# Code Review: opencode-fff-search

**Date:** 2026-04-25  
**Version:** 0.1.0  
**Reviewer:** Code Review Agent  
**Files Reviewed:** `index.js`, `package.json`, `README.md`, `install.sh`

---

## Executive Summary

**Overall Assessment:** ✅ **APPROVED** - The plugin is functional, well-designed, and ready for production use with minor improvements recommended.

**Critical Issues:** 0  
**Medium Issues:** 3  
**Minor Issues:** 4  
**Security Concerns:** 0  

---

## ✅ What's Working Well

### 1. Architecture & Design
- **Clean separation of concerns:** Plugin initialization, scanning, and tool execution are properly separated
- **Shared scanPromise pattern:** Prevents multiple concurrent scans, excellent performance optimization
- **Proper error handling:** Errors are caught and logged via OpenCode's logging API
- **ES6 module format:** Correctly uses `"type": "module"` to match OpenCode's expectations

### 2. API Usage
- **Correct tool override:** Uses `tool` property to override built-in `grep` and `glob` ✓
- **Proper schema definitions:** Uses `tool.schema` for Zod validation ✓
- **Context-aware:** Receives `directory` and `client` parameters correctly ✓

### 3. Feature Completeness
- **Path filtering:** Grep supports `path` parameter to narrow search scope
- **Exclude patterns:** Basic glob-style exclusion implemented
- **Context lines:** Supports `beforeContext`/`afterContext` for grep
- **Type filtering:** Glob supports `type: "directory"` filter

### 4. Cross-Platform Support
- **Platform-agnostic:** No OS-specific code; relies on fff-node's platform binaries
- **Graceful degradation:** Scan timeout warning doesn't crash the plugin

---

## ⚠️ Issues Found

### 🔴 Critical (None)

### 🟡 Medium Priority

#### M-1: Missing `path` Support in Glob Tool
**Severity:** Medium  
**Location:** `index.js:139-165`  
**Problem:** The `glob` tool accepts a `pattern` but doesn't support filtering by subdirectory/path like the built-in glob does. Users cannot search within a specific directory.

**Recommendation:** Add optional `path` parameter and filter results:
```javascript
args: {
  pattern: tool.schema.string(),
  path: tool.schema.string().optional(), // ADD THIS
  type: tool.schema.enum(["file", "directory"]).optional(),
  limit: tool.schema.number().optional(),
}

// In execute:
let result;
if (args.type === "directory") {
  const dirResult = finder.dirSearch(args.pattern, opts);
  // ...
}
// After getting result:
if (args.path) {
  const target = args.path.replace(/\/+$/, "");
  result = result.filter(p => p === target || p.startsWith(target + "/"));
}
```

#### M-2: `exclude` Implementation is Basic
**Severity:** Medium  
**Location:** `index.js:93-115`  
**Problem:** Custom regex-based glob matching only handles `*` and `?`. Doesn't support:
- `**` for recursive directory matching
- Character classes `[abc]`
- Brace expansion `{a,b}`
- Negation patterns `!pattern`

**Recommendation:** Use a lightweight glob library:
```bash
cd ~/.config/opencode && bun add minimatch
```
Then:
```javascript
import minimatch from "minimatch";
// ...
matches = matches.filter(m => {
  return !patterns.some(pat => minimatch(m.relativePath, pat, { dot: true }));
});
```
**Trade-off:** Adds ~50KB dependency but provides full glob compliance.

#### M-3: No Result Limiting on Grep
**Severity:** Medium  
**Location:** `index.js:73-74`  
**Problem:** `maxMatchesPerFile: 100` is hardcoded but there's no overall `limit` parameter. On large repos with many matches, this could return thousands of results overwhelming the AI or user.

**Recommendation:** Add `limit` parameter and truncate results:
```javascript
args: {
  // ...
  limit: tool.schema.number().optional().describe("Maximum total matches to return"),
}

// In execute after filtering:
let totalMatches = matches.length;
if (args.limit && totalMatches > args.limit) {
  matches = matches.slice(0, args.limit);
}
// Optionally add metadata about truncation
context.metadata({
  totalMatches,
  truncated: args.limit ? totalMatches >= args.limit : false,
  returnedMatches: matches.length
});
```

---

### 🔵 Minor Priority

#### m-1: Inconsistent Smart Case Logic
**Severity:** Minor  
**Location:** `index.js:70`  
**Problem:** `smartCase: args.caseSensitive ? false : true` - This inverts logic confusingly. If user passes `caseSensitive: true`, smartCase becomes false. Should be explicit.

**Recommendation:** Rename parameter or clarify:
```javascript
smartCase: args.caseSensitive !== true, // default true unless explicitly false
```
Or better: rename arg to `smartCase` and default to `true`.

#### m-2: No Metadata Returned
**Severity:** Minor  
**Location:** `index.js:118-124`, `index.js:152-160`  
**Problem:** Tools don't return metadata (match count, truncation, index status). Users have no visibility into why results might be incomplete.

**Recommendation:** Use `context.metadata()`:
```javascript
return {
  output: matches.map(...),
  metadata: {
    totalMatches: result.value.totalCount,
    scanComplete: scanPromise.isFulfilled,
    indexStats: finder.getStats()
  }
};
```

#### m-3: Missing Validation for Negative Limits
**Severity:** Minor  
**Location:** `index.js:143`  
**Problem:** `args.limit || 100` treats negative numbers as truthy, passing `-5` to fff.

**Recommendation:**
```javascript
pageSize: Math.max(1, args.limit || 100)
```

#### m-4: Unused `exclude` in Grep Args
**Severity:** Minor  
**Location:** `index.js:92-115`  
**Problem:** The `exclude` filtering is implemented but the comment says "For robust matching, a library like minimatch would be better." This is technical debt.

**Recommendation:** Either implement properly with minimatch (see M-2) or remove `exclude` param from args until fully implemented.

---

## 🔒 Security Review

### ✅ No Security Issues Found

**Input sanitization:**
- Pattern strings are passed to fff's Rust core (memory-safe)
- No shell command construction (avoids injection)
- Path filtering uses simple string operations (safe)

**Dependency analysis:**
- `@ff-labs/fff-node` is a well-maintained wrapper around fff.nvim (Rust)
- `@opencode-ai/plugin` is OpenCode's official SDK
- No `eval`, `child_process`, or dangerous APIs used

**File system access:**
- Confined to `directory` parameter (project root)
- No arbitrary file writes or deletions

---

## ⚡ Performance Review

### ✅ Excellent Design Choices

1. **Shared `scanPromise`:** Prevents N concurrent scans for N tool calls
2. **In-memory index:** fff maintains index in RAM, no process spawn overhead
3. **Timeout handling:** 10s scan timeout prevents indefinite blocking
4. **Lazy loading:** Index builds on-demand, not at plugin load

### 💡 Potential Optimizations

1. **Make timeout configurable** via environment or plugin config
2. **Add cache warming** option (scan in background after plugin load)
3. **Expose index statistics** for debugging (file count, scan duration)

---

## 🧪 Testing Recommendations

### Current State
- ✅ Manual test passed: `opencode run "Search for 'dependencies' using grep"`
- ❌ No automated tests

### Recommended Test Suite

Create `test.js` or use a test framework:

```javascript
// Test cases:
1. grep with simple pattern returns matches
2. grep with caseSensitive: true respects case
3. grep with path filter narrows results
4. grep with exclude filters correctly
5. grep with context returns before/after lines
6. glob with pattern returns file paths
7. glob with type: "directory" returns only directories
8. glob with limit truncates results
9. Error handling: invalid pattern throws meaningful error
10. Scan timeout doesn't crash plugin
```

### Integration Test
```bash
opencode run "Search for 'function' using grep" | grep -q "index.js"
opencode run "Find files matching '*.js' using glob" | grep -q "index.js"
```

---

## 📚 Documentation Review

### README.md ✅ Excellent
- Comprehensive installation instructions (3 methods)
- Cross-platform notes (Linux, macOS, Windows)
- Troubleshooting section with specific error scenarios
- Performance benchmarks table
- Clear examples

### Suggested Additions
1. **Tool parameters reference table:**
   ```markdown
   | Parameter | Type | Required? | Description |
   |-----------|------|-----------|-------------|
   | pattern | string | Yes | Search pattern |
   | path | string | No | Subdirectory to search within |
   | exclude | string | No | Comma-separated glob patterns |
   | caseSensitive | boolean | No | Default: smart-case |
   | context | number | No | Lines before/after match |
   | limit | number | No | Max results (default 100) |
   ```

2. **Configuration options:**
   - `scanTimeout` (default 10000ms)
   - `maxMatchesPerFile` (default 100)
   - `aiMode` (default true) - what it does

3. **Migration from default tools:** What changes users should expect

---

## 🔄 Recommended Changes Summary

### High Priority (Do Before Publishing)
1. **Add `path` parameter to glob tool** (M-1) - Improves feature parity with built-in glob
2. **Fix smartCase logic** (m-1) - Clarify parameter semantics
3. **Add `limit` to grep** (M-3) - Prevent overwhelming output

### Medium Priority (Nice to Have)
4. **Replace custom exclude with minimatch** (M-2) - Full glob support
5. **Return metadata** (m-2) - Better debugging
6. **Validate negative limits** (m-3) - Input validation

### Low Priority (Future Iterations)
7. **Add `sort` parameter** (by recency, path, relevance)
8. **Add `gitStatus` filter** (only show modified/untracked files)
9. **Add `since` parameter** (files modified in last N days)

---

## 📦 Packaging & Distribution

### package.json ✅ Good
- Correct `name` format: `opencode-fff-search`
- Proper `peerDependencies` for OpenCode plugin API
- `os` and `cpu` fields correctly restrict to supported platforms
- `files` array correctly includes only `index.js`

### Suggested Improvements
1. **Add `opencode` keyword** in `keywords` array:
   ```json
   "keywords": ["opencode", "plugin", ...]
   ```
2. **Add `bugs` URL:**
   ```json
   "bugs": {
     "url": "https://github.com/ozgurulukir/opencode-fff-search/issues"
   }
   ```
3. **Consider adding `funding` field** if accepting sponsorships

---

## ✅ Final Verdict

**Status:** **Ready to Publish** ✓

The plugin is functional, well-architected, and solves a real performance problem. The three medium-priority issues should be addressed before v1.0.0, but v0.1.0 can ship as-is with documentation noting limitations.

### Immediate Actions
- [ ] Sync `index.js` in repo with tested installed version (DONE ✓)
- [ ] Consider adding `path` to glob (M-1)
- [ ] Add `limit` to grep (M-3)
- [ ] Fix smartCase naming/comment (m-1)
- [ ] Update README with full parameter reference

### Future Work
- [ ] Add test suite
- [ ] Publish to npm
- [ ] Add more fff features (git status, sort options)
- [ ] Collect user feedback for v1.0 roadmap

---

## Sign-Off

**Reviewer:** Code Review Agent  
**Recommendation:** **APPROVE** with medium-priority fixes  
**Confidence:** High ✓

The plugin delivers on its promise: replacing ripgrep with a faster, smarter search engine. Implementation is clean, dependencies are minimal, and cross-platform support is solid.
