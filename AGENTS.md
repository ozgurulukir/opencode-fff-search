# AGENTS.md

This document provides essential context for AI agents working on the opencode-fff-search codebase.

## Project Overview

OpenCode plugin that replaces OpenCode's built-in `grep` and `glob` file search tools with [fff](https://github.com/dmtrKovalenko/fff)'s ultra-fast, typo-resistant search engine.

**Key characteristics:**

- Single-file ES module plugin (`index.js`)
- No build step required
- Node.js 18+ required (ES modules)
- Uses `@ff-labs/fff-node` (Node.js) or `@ff-labs/fff-bun` (Bun runtime) with auto-detection, plus `minimatch` for glob matching
- Returns `{ output, metadata }` objects so OpenCode's TUI renders match counts inline
- **Full feature set** — grep (pattern, path, include, exclude, caseSensitive, context, limit), glob (pattern, path, type, limit)
- **Single-file 100% recall** — When path points to a file, reads it directly bypassing fff index
- **aiMode enabled** — Frecency scoring on by default for better recall and ranking
- **Smart mode detection** — Detects regex vs plain patterns; plain uses SIMD-accelerated literal matching

## Architecture

### Plugin Structure

The plugin exports an async default function `(input)` that:

1. **Lazily imports** fff-native (`@ff-labs/fff-bun` or `@ff-labs/fff-node` via `lazyFff()`) at runtime — never at module level, avoiding Bun-on-Windows module-graph crashes
2. **Initializes** a `FileFinder` instance with safe defaults; gracefully falls back to fs-only mode when `FileFinder.create()` returns `ok: false`
3. **Caches** one `FileFinder` per directory (module-level `instances` Map) to prevent native resource leaks
4. **Creates a shared `scanPromise`** to avoid multiple concurrent index scans
5. **Returns tool definitions** that override OpenCode's built-in `grep` and `glob` tools

### Data Flow

```
grep:
  File path      → directFileGrep (Node.js fsPromises.readFile) → format
  Unicode pattern → fsGrep (fsPromises.readdir + fsPromises.readFile + Unicode regex) → post-filter → format
  Outside index  → fsGrep (path outside basePath) → format
  ASCII pattern  → fff grep (plain or regex mode) → if zero → plain→regex retry → fsGrep fallback → post-filter → format

glob:
  Metachar + type=directory → globWalk directly (fff directorySearch is fuzzy, not glob-aware)
  Metachar + type=file      → fff fileSearch → minimatch post-filter → globWalk fallback → absolute paths → format
  Fuzzy query               → fff fileSearch/directorySearch → filter by path → globWalk fallback → absolute paths → format
  Fuzzy query (no exact match) → fff fileSearch + globWalk augmentation → absolute paths → format
```

### Tool Output Format

- **grep tool**: Returns `{ title, output: string, metadata: { matches: number, truncated: boolean } }`
  - Output format: `relativePath:lineNumber:lineContent` (one line per match)
  - When `context > 0`: renders `contextBefore` lines, match line, `contextAfter` lines with correct line numbers
  - Default limit: 100 matches, configurable 1–5000
- **glob tool**: Returns `{ title, output: string, metadata: { count: number, truncated: boolean } }`
  - Output format: newline-separated absolute file paths
  - Default limit: 100 results, configurable 1–5000

### Key Components

- `lazyFff(client)` — Lazily imports `@ff-labs/fff-bun` (Bun) or `@ff-labs/fff-node` (Node.js) at runtime, avoiding Bun-on-Windows module-graph crashes. Safe to call multiple times (idempotent).
- `FileFinder.create({ basePath, ...config })` — Initializes fff search engine with aiMode enabled; gracefully falls back to fs-only mode when `ok: false`
- `instances` Map — Module-level cache: one `{ finder, scanPromise }` per directory
- `finder.waitForScan(15000)` — Waits for initial index build (15s timeout)
- `detectGrepMode(pattern)` — Returns `"regex"` or `"plain"` based on regex metachar detection
- `finder.grep(pattern, opts)` — Content search with regex/plain mode + smart case + cursor pagination
- `directFileGrep(filePath, basePath, pattern, ctxLines)` — Direct file read for 100% recall on single-file searches
- `fsGrep(dir, basePath, pattern, ctxLines, pathFilter, include, exclude)` — Directory-level grep for non-ASCII (Unicode/Turkish) patterns; walks dirs with `fsPromises.readdir` and reads files with `fsPromises.readFile` using exact Unicode regex (`u` flag). Bypasses fff's Unicode normalization to avoid `ş↔s` overcount. Applies include/exclude during traversal. Include/exclude patterns are pre-parsed once via `parsePatterns()` before the loop.
- `globWalk(dir, pattern, basePath, limit, type)` — Real glob matching via recursive `fsPromises.readdir` + minimatch (supports file/directory type)
- `loadGitignoreFilter(basePath)` — Async function that reads `.gitignore` via `fsPromises.readFile` and augments `SKIP_DIRS` with directory-name entries; cached per basePath. Used by `fsGrep` and `globWalk` (both `await` it).
- `fetchGrepPages(finder, pattern, opts, limit, abort, client)` — Cursor-based pagination across fff's 50-item pages; page ceiling = `ceil(limit/50) + 2`
- `filterByPath(items, pathKey, targetPath)` — Post-filter results to a subdirectory or file
- `filterByGlob(items, pattern)` — Post-filter results by include glob pattern
- `filterByExclude(items, exclude)` — Post-filter results by exclude glob pattern
- `parsePatterns(str)` — Parses comma-separated glob string into array once; returns `null` for empty. Used by `applyMinimatchFilter` and `fsGrep` to avoid repeated splitting in loops.
- `getRelativePath(directory, argsPath)` — Converts `argsPath` to relative: returns `null` if falsy, `relative(directory, argsPath)` if absolute, otherwise `argsPath` as-is. Replaces 7 duplicated ternaries.
- `isPathInsideIndex(argsPath, directory)` — Returns `true` if `argsPath` is `null`, relative, or an absolute path inside `directory`. Used to decide whether fff can handle the search or `fsGrep` is needed.
- `waitForScan(scanPromise, timeoutMs)` — Race between scan completion and timeout, never throws
- `safeLog(client, level, message)` — Logging that never throws; logs to `console.error` as fallback when `client.app.log` fails
- `__test()` — Single function export that returns all internal functions for testing; prevents `getLegacyPlugins()` from calling each named export as a separate plugin server (Bun-on-Windows fix)

### Configuration

The plugin uses hardcoded defaults with all fff features enabled:

```javascript
// Hardcoded defaults in FileFinder.create()
{
  aiMode: true,                // Frecency DB enabled (improves recall)
  disableMmapCache: false,     // Enable mmap cache for speed
  disableContentIndexing: false, // Bigram inverted index (5-20x grep speedup, no recall impact)
  disableWatch: false,         // Enable file watcher (detects new/deleted files)
}
```

All features are enabled for maximum search performance. The bigram content index pre-filters files before opening them — it does not affect recall, only eliminates files that cannot match the query pattern.

### Skipped Directories

`SKIP_DIRS` — hardcoded baseline set, augmented at runtime by `loadGitignoreFilter`:

```javascript
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".hg",
  ".svn",
  "__pycache__",
  ".cache",
  "dist",
  ".next",
  "coverage",
  ".nyc_output",
  "build",
  "out",
  ".nuxt",
  ".output",
  ".vercel",
  ".terraform",
]);
```

`loadGitignoreFilter(basePath)` reads `.gitignore` from disk (async, via `fsPromises.readFile`) and extracts simple directory-name
patterns (e.g., `vendor/`, `generated/`) into the skip set. Results are cached per `basePath`.

`globWalk` and `fsGrep` skip all dot-prefixed directories (except the search root).

fff's own index respects `.gitignore` natively via the Rust `ignore` crate (same library ripgrep uses).
This means `SKIP_DIRS` is only needed for the filesystem fallback functions.

## Essential Commands

### Testing

```bash
# Run all tests (node:test, zero dependencies)
node --test 'test/*.test.js'

# Run only plugin integration tests
node --test test/plugin.test.js

# Run only internal function unit tests
node --test test/internals.test.js

# Run only SIGBUS stress tests
node --test test/stress.test.js

# Test plugin loads correctly
node -e "import('./index.js').then(m => console.log('Plugin loads OK'))"

# Manual integration test with OpenCode
opencode run "Search for 'import' using grep"
opencode run "Find files matching '*.js' using glob"

# Check debug logs
opencode debug config --print-logs 2>&1 | grep fff
```

### Installation

```bash
# For development testing (global OpenCode config)
ln -sf $(pwd)/index.js ~/.config/opencode/plugins/opencode-fff-search.js
cd ~/.config/opencode && npm install

# For project-local testing
mkdir -p .opencode/plugins && cp index.js .opencode/plugins/
cd .opencode && npm install

# Using the install script (Linux/macOS only)
./install.sh
```

### Publishing

```bash
# Update version in package.json
git add package.json && git commit -m "chore: bump version to X.Y.Z"
git tag vX.Y.Z
git push origin vX.Y.Z

# Publish to npm
npm publish --access public

# Verify
npm view opencode-fff-search version
```

## Code Conventions

### Style

- **Indentation**: 2 spaces
- **Semicolons**: No semicolons (ES module style)
- **Quotes**: Double quotes for strings, backticks for template literals
- **Function declarations**: Arrow functions for callbacks/handlers, `async function` for top-level

### Patterns

```javascript
// Tool definition pattern — extends upstream with exclude, context, limit
tool({
  description: "...",
  args: {
    pattern: tool.schema.string().describe("Search pattern"),
    path: tool.schema.string().optional(),
    exclude: tool.schema.string().optional(),
    caseSensitive: tool.schema.boolean().optional(),
    context: tool.schema.number().optional(),
    limit: tool.schema.number().optional(),
  },
  async execute(args, context) {
    // 1. Validate + abort check
    if (
      !args.pattern ||
      typeof args.pattern !== "string" ||
      args.pattern.trim() === ""
    )
      throw new Error("pattern must be a non-empty string");
    if (context.abort.aborted) throw new Error("Aborted");

    // 2. Wait for scan
    await waitForScan(scanPromise, TOOL_TIMEOUT_MS);
    if (context.abort.aborted) throw new Error("Aborted");

    // 3. Detect single-file vs directory search
    let resolvedFilePath = null;
    if (args.path) {
      const resolvedPath = resolvePath(directory, args.path);
      if (existsSync(resolvedPath) && statSync(resolvedPath).isFile())
        resolvedFilePath = resolvedPath;
    }

    // 4. Execute search
    let matches;
    if (resolvedFilePath) {
      matches = directFileGrep(
        resolvedFilePath,
        directory,
        args.pattern,
        ctxLines,
      );
    } else {
      // ... routing logic (see Data Flow above)
    }

    // 5. Post-filter by path, exclude
    // 6. Sort by mtime, apply limit
    // 7. Return { title, output, metadata }
    return {
      title: args.pattern,
      metadata: { matches: total, truncated },
      output: output.join("\n"),
    };
  },
});
```

### Error Handling

```javascript
try {
  const result = finder.grep(args.pattern, { mode, smartCase: true });
  if (!result.ok) {
    await safeLog(client, "error", `fff grep error: ${result.error}`);
    throw new Error(`fff grep error: ${result.error}`);
  }
} catch (err) {
  await safeLog(client, "error", `grep error: ${err.message}`);
  throw err;
}
```

### Logging

Use structured logging via `client.app.log()`. Keep logs minimal — only initialization, scan completion, and errors. Always use `safeLog` (never throws).

## Critical Implementation Details

### Upstream Contract Alignment

The plugin extends the upstream OpenCode tool contracts:

**grep** ([upstream source](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/tool/grep.ts)):

- Upstream: 3 parameters (`pattern`, `path`, `include`)
- **Extensions**: `exclude` (post-filter), `caseSensitive` (overrides smart case), `context` (fff native), `limit` (configurable 1–5000)
- Uses `detectGrepMode()` to choose `"plain"` (SIMD) vs `"regex"` mode
- Single-file search: reads file directly for 100% recall (bypasses fff)
- Default limit 100, max 5000
- Output: `relativePath:lineNumber:lineContent` per line (context lines rendered before/after match when `context > 0`)
- Truncation notice: `(Results are truncated: showing first ${limit} results ...)`

**glob** ([upstream source](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/tool/glob.ts)):

- Upstream: 2 parameters (`pattern`, `path`)
- **Extensions**: `type` (file/directory), `limit` (configurable 1–5000)
- Metachar patterns: fff fuzzy + minimatch post-filter + `globWalk` fallback
- Fuzzy queries: fff `fileSearch`/`directorySearch` + `globWalk` fallback
- `globWalk` triggers on ALL empty-result cases (not just metachar)
- fff items normalized to always have `relativePath` and `fileName`
- Default limit 100, max 5000
- Output: newline-separated **absolute** file paths (matches upstream behavior)

### Tool Return Format

**CRITICAL**: Both tools must return `{ output, metadata }` objects, not plain strings.

```javascript
// Correct
return {
  title: args.pattern,
  metadata: { matches: total, truncated },
  output: output.join("\n"),
};

// Incorrect — TUI shows no match count
return lines.join("\n");
```

### Path Handling

Matches upstream behavior:

- **Absolute paths** — resolved as-is, then converted to relative for filtering
- **Relative paths** — joined with workspace `directory`
- **Falsy/omitted** — uses workspace `directory`

```javascript
function resolvePath(directory, p) {
  if (!p) return directory;
  if (isAbsolute(p)) return p;
  return join(directory, p);
}

function getRelativePath(directory, argsPath) {
  if (!argsPath) return null;
  return isAbsolute(argsPath) ? relative(directory, argsPath) : argsPath;
}

function isPathInsideIndex(argsPath, directory) {
  if (!argsPath) return true;
  if (!isAbsolute(argsPath)) return true;
  return argsPath.startsWith(directory + "/") || argsPath === directory;
}
```

### Smart Mode Detection (`detectGrepMode`)

```javascript
const REGEX_METACHAR_RE =
  /\\[sdwnbtDSWNBT]|\\|\||\[\^?\]|\[\^?[^\]]+\]|\\\+|\\\*|\\\?|[\^\$]/;
```

Patterns with `\s`, `\d`, `|`, `[abc]`, `^`, `$`, etc. → `"regex"` mode.
Everything else → `"plain"` mode (SIMD-accelerated literal matching).

This is necessary because regex mode silently drops literal metacharacters: `foo(bar)` in regex mode would fail to match the literal parentheses. Plain mode handles this correctly.

**Failsafe**: If plain mode returns zero results, the plugin retries with regex mode automatically.

### Exclude Parameter Filtering

The `exclude` parameter matches against **both** `relativePath` and `fileName`. This is necessary because `minimatch("dir/Foo.vue", "*.vue")` returns false (`*` doesn't match `/`):

```javascript
if (args.exclude) {
  const patterns = args.exclude
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  matches = matches.filter(
    (m) =>
      !patterns.some(
        (pat) =>
          minimatch(m.relativePath, pat, { dot: true }) ||
          minimatch(m.fileName, pat, { dot: true }),
      ),
  );
}
```

### Glob Tool: Glob vs Fuzzy Routing

The glob tool detects whether the pattern contains glob metacharacters (`*`, `?`, `[`):

- **Glob patterns + type=directory** — skips fff's `directorySearch` (which is fuzzy, not glob-aware) and uses `globWalk` directly for proper minimatch matching
- **Glob patterns + type=file** → fff fuzzy search → minimatch post-filter → `globWalk` fallback
  - `globWalk()` uses recursive `fsPromises.readdir` + `minimatch`
  - Supports recursive `**/`, brace expansion (`*.{ts,js}`), and character classes via `minimatch`
  - Directory matching checks both `relativePath` and `entry.name` so `*` matches nested dirs
- **Fuzzy queries** (`helpers`, `config`) → fff `fileSearch()` / `directorySearch()` → `globWalk` fallback
- **Exact-name augmentation**: for non-metachar patterns, if fff's fuzzy results don't include an exact basename match, `globWalk` runs to find and augment with the real file

`globWalk` triggers for **all** empty-result cases, not just metachar patterns. For non-metachar patterns with non-empty fuzzy results, `globWalk` also runs if no result has an exact basename match — augmenting the fuzzy results with the real file.

### Glob Item Normalization

fff's `directorySearch` and `fileSearch` may return items with `path` instead of `relativePath`, or missing `fileName`. The plugin normalizes all items:

```javascript
items = (result.value?.items || []).map((item) => ({
  relativePath: item.relativePath || item.path || "",
  fileName:
    item.fileName ||
    (item.relativePath || item.path || "").split("/").pop() ||
    "",
}));
```

This prevents `undefined.split()` crashes in downstream `minimatch`/`filterByPath`/`join` calls.

### Content Indexing (Bigram Prefilter)

All fff features are enabled in `FileFinder.create()`:

```javascript
{
  aiMode: true,                // Frecency DB enabled (improves recall)
  disableMmapCache: false,     // Memory-mapped file cache for speed
  disableContentIndexing: false, // Bigram inverted index (5-20x grep speedup)
  disableWatch: false,         // File watcher (detects new/deleted files)
}
```

**How the bigram content index works**: fff builds a character-pair (bigram) inverted index from file contents during the initial scan. Each bigram maps to a bitset of files containing that pair. During grep, the engine ANDs posting lists for the query pattern to produce a candidate file set, eliminating 80-95% of files before opening any file. The actual grep then does exhaustive line-by-line matching (SIMD `memchr` for plain text, `regex` crate for patterns) within candidate files only.

**No recall impact**: The bigram prefilter is conservative — a file is only skipped if it lacks all bigrams from the query. This cannot produce false negatives. The recall gap in fff's grep comes from its fuzzy file finder (tokenization), not from content indexing.

**Non-ASCII content**: The bigram index only tracks printable ASCII pairs (chars 32-126). Files with only non-ASCII content pass through to the full grep unfiltered, which is why the plugin's Unicode routing to `fsGrep` is correct.

### Known Limitations

#### Turkish/Unicode Overcount (Solved)

fff's search engine performs Unicode normalization that maps `ş` (U+015F) to ASCII `s`, inflating match counts for Turkish patterns. The plugin detects non-ASCII patterns via `/[^\x00-\x7F]/` and routes them to `fsGrep` — a file-level read with exact Unicode regex (`giu` flags). Patterns containing characters like `ş`, `ı`, `İ`, `ğ`, `ü`, `ö`, `ç` produce exact counts matching bash `grep`.

#### Case-Insensitive Matching for Turkish Uppercase (fff Limitation)

fff's case folding is ASCII-only. When `smartCase` is enabled and the pattern is uppercase (e.g., `ISTANBUL`), fff performs case-sensitive matching and won't find Turkish title-case text like `İstanbul` because `I` ≠ `İ` in ASCII. **Workaround**: Use lowercase patterns for case-insensitive search (e.g., `istanbul` matches `İstanbul`). For exact uppercase Turkish matching, use `caseSensitive: true` with the exact Unicode pattern.

#### Regex Support (Basic)

fff supports basic regex: character classes (`[abc]`), quantifiers (`+`, `*`, `?`), alternation (`|`), anchors (`^`, `$`), escaped classes (`\s`, `\d`, `\w`). Advanced PCRE features are **not** supported: non-capturing groups (`(?:...)`), inline flags (`(?i)`), look-ahead/behind, backreferences. Use the `caseSensitive` parameter instead of inline flags.

#### Keyword Search (Inherent fff Limitation)

fff's grep indexes symbol tokens (identifiers, component names) but not language keywords (`import`, `const`, `return`, `export`). Plugin cannot override this for ASCII patterns. For keyword search, agents should fall back to bash `grep`/`rg`.

#### Grep Recall Gap (Mitigated)

fff's grep engine does not guarantee 100% recall across all files — coverage is high for symbol names and identifiers but inconsistent for short/common words. Not related to file size or content type.

**Mitigation**: When `path` points to a specific file, the plugin reads it directly for 100% recall (`directFileGrep`). For non-ASCII patterns, `fsGrep` provides exact file-level coverage. For directory-wide ASCII searches, the plugin auto-falls back to `fsGrep` when fff returns zero results. For guaranteed 100% recall, agents should fall back to bash `grep`/`rg`.

**Smart case**: Uppercase/mixed-case patterns search case-sensitively. Lowercase patterns are case-insensitive. Matches ripgrep's `--smart-case` behavior. Override with explicit `caseSensitive` parameter.

**Important**: fff's smart case is ASCII-only. `ISTANBUL` won't match `İstanbul` case-insensitively because `I` ≠ `İ` in ASCII case folding. Use lowercase patterns for Turkish case-insensitive search.

### Shared scanPromise Pattern

```javascript
const scanPromise = finder.waitForScan(SCAN_TIMEOUT_MS).catch(() => undefined);
scanPromise.then(() => safeLog(client, "info", "Initial fff scan complete"));
```

### Abort Handling

Check `context.abort.aborted` at start and after async operations:

```javascript
if (context.abort.aborted) throw new Error("Aborted");
await waitForScan(scanPromise, TOOL_TIMEOUT_MS);
if (context.abort.aborted) throw new Error("Aborted");
```

## Tool Parameters Reference

### grep Tool

| Parameter       | Type               | Default | Notes                                                     |
| --------------- | ------------------ | ------- | --------------------------------------------------------- |
| `pattern`       | string (required)  | —       | Search pattern (regex or literal text)                    |
| `path`          | string (optional)  | —       | File or directory to search in (absolute or relative)     |
| `include`       | string (optional)  | —       | File pattern to include (e.g., `"*.vue"`, `"*.{ts,tsx}"`) |
| `exclude`       | string (optional)  | —       | Comma-separated glob patterns to exclude                  |
| `caseSensitive` | boolean (optional) | `false` | Override smart case. `true` = always case-sensitive.      |
| `context`       | number (optional)  | `0`     | Context lines before/after each match                     |
| `limit`         | number (optional)  | `100`   | Max matches to return (1–5000)                            |

**Output format**: `relativePath:lineNumber:lineContent` (one line per match). Context lines rendered before/after match with correct line numbers when `context > 0`.

### glob Tool

| Parameter | Type                             | Default | Notes                                         |
| --------- | -------------------------------- | ------- | --------------------------------------------- |
| `pattern` | string (required)                | —       | Glob pattern or fuzzy query                   |
| `path`    | string (optional)                | —       | Directory to search in (absolute or relative) |
| `type`    | "file" or "directory" (optional) | "file"  | Filter by type                                |
| `limit`   | number (optional)                | `100`   | Max results to return (1–5000)                |

**Output format**: newline-separated absolute file paths

## Platform-Specific Notes

### fff Binary Download

The `@ff-labs/fff-node` package downloads platform-specific binaries automatically via npm optional dependencies:

- Linux x64: `@ff-labs/fff-bin-linux-x64-gnu` (or `-musl` for Alpine)
- macOS Intel: `@ff-labs/fff-bin-darwin-x64`
- macOS Apple Silicon: `@ff-labs/fff-bin-darwin-arm64`
- Windows: `@ff-labs/fff-bin-win32-x64`

### Installation Locations

- Global: `~/.config/opencode/plugins/` (Linux/macOS) or `%APPDATA%\opencode\plugins\` (Windows)
- Project-local: `.opencode/plugins/` (any OS)

## Testing

Automated test suite using `node:test` (zero external dependencies, Node.js 18+).

### Core tests

```bash
node --test 'test/*.test.js'
```

172 tests across 44 suites split across three files:

- **`test/plugin.test.js`** — Plugin integration tests (initialization, tool shape, grep/glob
  execute, case sensitivity, path filtering, exclude/include, Turkish/Unicode, context lines,
  limit, abort, regex mode, pagination, edge cases, fsGrep/globWalk/directFileGrep internals)
- **`test/internals.test.js`** — Pure unit tests for internal functions (detectGrepMode,
  filterByPath, resolvePath, parsePatterns, shouldIncludeFile, applyMinimatchFilter, safeLog,
  waitForScan, searchInFile, fetchGrepPages, lazyFff, performGrepRouting)
- **`test/stress.test.js`** — SIGBUS stability stress tests (file mutation, multiple native
  instances, large files, plugin-level stress)

Shared helpers live in `test/helpers.mjs`.

### Session simulation tests (synthetic 270-file project)

```bash
node --test test/session-*.js
```

7 tests simulating real OpenCode agent behavior on a synthetic project.

### Integration tests (requires `opencode` CLI)

```bash
node --test test/integration-*.js
```

Spawns actual `opencode run` processes with file mutations. Requires a configured provider.

### Watch-enabled tests

```bash
node --test test/stress-watch-enabled.js
node --test test/stress-watch-timing.js
node --test test/stress-watch-real-repo.js
```

### Mmap cache tests (proves the crash)

```bash
node --test test/stress-mmap-enabled.js   # WARNING: will SIGBUS
node --test test/stress-mmap-single.js    # WARNING: will SIGBUS on real repo
```

See [SIGBUS_INVESTIGATION.md](./SIGBUS_INVESTIGATION.md).

## Lessons Learned

### `resolvePath()` vs `path.join()` for user-supplied paths

`path.join()` **concatenates** segments when the second argument is absolute, producing a non-existent merged path:

```js
join("/home/user", "/absolute/path/to/dir");
// → "/home/user/absolute/path/to/dir"   ← wrong!
```

Always use the existing `resolvePath()` helper (index.js:103) which short-circuits on absolute paths:

```js
function resolvePath(directory, p) {
  if (!p) return directory;
  if (isAbsolute(p)) return p; // absolute paths returned as-is
  return join(directory, p);
}
```

This bug appeared in **two separate PRs** (#1 and #3), both in the `fsGrep` fallback path. Future edits to path resolution should use `resolvePath()` and never call `join(directory, args.path)` directly.

### `fsGrep` uses async I/O — add a `limit` guard early

`fsGrep` walks directories with `fsPromises.readdir` and reads files with `fsPromises.readFile`. For a common short pattern (e.g. `fn`, `pub`, `use`) the bigram content index in fff returns zero results, the `fsGrep` failsafe fires, and it can take a long time scanning every file in a directory.

**Fix**: `fsGrep` now accepts an optional `limit` parameter and returns early when `results.length >= limit`. All three call sites (Unicode fallback, outside-index fallback, failsafe fallback) pass `limit` through. When calling `fsGrep`, always pass the caller's `limit` so the early-return guard works correctly.

### The `fsGrep` failsafe is the last-resort fallback — not first choice

`fsGrep` is intentionally slow (directory-level async I/O). It should only be reached through:

- Unicode/Non-ASCII patterns (`/[^\x00-\x7F]/`) — forced `fsGrep` route
- Outside-index paths — `args.path` outside the indexed directory
- Zero-result failsafe — fff returned nothing, recurse to `fsGrep`

For ASCII patterns where fff returns results, `fsGrep` is never called. The exception is PR #3's fix where the failsafe `fallbackDir` was computed with `join()` instead of `resolvePath()`, causing it to silently find nothing.

### Always review upstream tool source when extending parameters

When adding a parameter like `limit` to the grep tool, check [upstream source](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/tool/grep.ts) first to understand the upstream contract and ensure extensions remain aligned.

19. **Path resolution consistency**: `fsGrep` failsafe fallback must use `resolvePath(directory, args.path)`, not `join()`. Same pattern applies to any new `fsGrep` call sites. (Reinforces Gotcha #9 — fff fallback path bug has recurred twice.)

### Rust binary panic: `grep.rs:2110` slice out-of-bounds in `@ff-labs/fff-node@0.7.0`

The fff-core Rust binary v0.7.0 (and v0.7.1/v0.7.2) contains a known bug at `grep.rs:2110`:
`for f in &files[overflow_start..]` where `overflow_start > files.len()`. This
triggers a process-fatal Rust panic (OS-level SIGABRT / segfault) — no JS catch
possible — when the bigram overlay's `base_file_count()` (recorded at index-build
time) disagrees with the current `files.len()` (after files are deleted).

**Trigger in tests**: the "should cache finder instance per directory" test called
`createTempProject()` which internally calls `cleanupTempProject(tmpDir)`, deleting
the shared test directory (`tmpDir`). When the next `before()` hook tried to
rebuild `tmpDir` but the Rust overlay still held the stale `overflow_start == 9`,
`findFiles()` returned an empty list and the slice `files[9..]` on a zero-length
slice panicked the binary.

**Workaround (in JS / tests)**:

- **index.js** `existsSync(fallbackDir)` guard (line 555): prevents `fsGrep`
  from walking a directory that has been deleted between the overlay state
  being recorded and it being read on disk.
- **`fetchGrepPages` retry loop**: `totalFilesSearched === 0` retries up to
  3 times with exponential backoff, which mitigates overlay staleness races.
- **Test fix**: the "cache finder" test now uses its own `freshDir` with
  `rmSync` instead of `createTempProject()`/`cleanupTempProject()` which
  would delete the shared `tmpDir`. This eliminates the race entirely.

**Upstream fix pending**: fff-core main branch now has
`overflow_start = min(overflow_start, files.len())` at the boundary assignment
(`grep.rs:2103`), but this fix has not been released in any published version
as of this writing. Update `@ff-labs/fff-node` to `>=0.8.2` when it ships
a crate version that backports this clamp.

### `getLegacyPlugins()` calls every named export as a separate plugin server

OpenCode's plugin loader calls `getLegacyPlugins(mod)` which iterates
`Object.values(mod)` and invokes each function-valued export with
`(input, options)` as if it were a standalone plugin `server()`. When a named
export like `fsGrep` or `loadGitignoreFilter` is called with `(input, options)`,
the arguments are `PluginInput` (object) and plugin metadata (object), not the
intended positional parameters. This is harmless for most functions (they return
early or catch), but under Bun-on-Windows, one such internal call triggers the
`paths[1]` CJS interop bug during `require.resolve` deep within the Bun runtime.

**Fix**: Replace individual named exports (`export { fsGrep, detectGrepMode, ... }`)
with a single `export async function __test() {}` that returns an object containing
all internal functions. This way `getLegacyPlugins()` sees exactly one function
export — `__test` — and calling it has no side effect.

## Common Gotchas

1. **Return format**: Must return `{ output, metadata }` objects, not plain strings. TUI reads metadata for match counts.
2. **Scan timeout**: The 5s timeout in tool execute is intentional. Don't increase it.
3. **exclude filtering**: Match against both `fileName` and `relativePath` — `minimatch("dir/Foo.vue", "*.vue")` returns false.
4. **Configurable limits**: Default 100 results for both tools, configurable up to 5000 via `limit` param.
5. **Abort checking**: Check `context.abort.aborted` both at start AND after any async operation.
6. **minimatch import**: Must use named import: `import { minimatch } from "minimatch"`.
7. **peerDependency**: `@opencode-ai/plugin` is a peer dependency — users install it, not the plugin itself.
8. **Smart case**: Uppercase/mixed-case patterns search case-sensitively. Use lowercase for broad matching. Override with `caseSensitive` param.
9. **Recall gap**: fff's grep may miss matches in directories. Single-file searches have 100% recall. For directory-wide 100% recall, fall back to bash `grep`.
10. **Single-file search**: When `path` points to a file, the plugin reads it directly with Node.js — bypasses fff entirely.
11. **Glob detection**: `GLOB_METACHAR_RE = /[*?\[]/` — patterns with `*`, `?`, or `[` use minimatch post-filter. Others use fff's fuzzy finder.
12. **type=directory**: Glob tool supports `type="directory"` for both glob patterns and fuzzy queries. Metachar patterns with `type=directory` skip fff and use `globWalk` directly (fff's `directorySearch` is fuzzy, not glob-aware). Directory matching checks both `relativePath` and `entry.name` so `*` matches nested directories.
13. **globWalk fallback**: Triggers for ALL empty-result cases (not just metachar patterns). For non-metachar patterns, also augments fff's fuzzy results when no exact basename match exists (e.g., `temp.ts` pattern where fff returns 100 fuzzy `.ts` files but none is `temp.ts`). Handles `type="directory"`, Unicode filenames, and fff index gaps.
14. **Item normalization**: fff `directorySearch` may return items with `path` instead of `relativePath`. The plugin normalizes all items to prevent `undefined.split()` crashes.
15. **fsGrep for non-ASCII**: Patterns with Turkish/Unicode characters (`ş`, `ı`, `İ`) route via `/[^\x00-\x7F]/` to `fsGrep`, which reads files with `fsPromises.readFile` and exact Unicode regex (`giu`). This avoids fff's `ş↔s` normalization overcount. The `fsGrep` path applies include/exclude during the walk — no double filtering.
16. **loadGitignoreFilter**: `fsGrep` and `globWalk` parse `.gitignore` to augment `SKIP_DIRS` with directory-name entries. Async — uses `fsPromises.readFile`; cached per basePath. Dot-prefixed dirs are always skipped. fff's own index also respects `.gitignore` natively via the Rust `ignore` crate.
17. **Pagination**: `fetchGrepPages` uses dynamic `maxPages = ceil(limit/50) + 2` instead of fixed `MAX_GREP_PAGES`. fff's `pageLimit` is hardcoded to 50 in `finder.ts` and not exposed via `GrepOptions`.
18. **Context rendering**: When `context > 0`, the output loop renders `contextBefore` lines (with correct line numbers before the match), the match line itself, then `contextAfter` lines. Both fff grep items and `directFileGrep`/`fsGrep` items carry `contextBefore`/`contextAfter` arrays.
19. **Test directory deletion can trigger a Rust panic**: `createTempProject()` internally calls `cleanupTempProject(tmpDir)` which deletes the shared test directory. If another test's `before()` hook then tries to rebuild that directory while the Rust overlay's `base_file_count()` is stale (higher than `files.len()`), calling `finder.grep()` inside `fetchGrepPages` will reach `files[overflow_start..]` with `overflow_start > files.len()` — a process-fatal slice panic (`grep.rs:2110`) that cannot be caught in JS. Workaround: never delete `tmpDir` from within a test. Use an isolated directory (e.g. `rmSync` a fresh unique path) so the shared test directory is untouched. The JS-side guards (`existsSync(fallbackDir)` in `fsGrep` failsafe, `totalFilesSearched === 0` retry in `fetchGrepPages`) reduce the blast radius but cannot prevent this specific panic.
20. **Upstream (OpenCode/Bun) plugin loading bug — `"paths[1]" must be of type string, got object`**: When `package.json` in the plugin directory (e.g. `~/.config/opencode/`) lacks `"type": "module"`, Bun's internal CJS `require()` implementation throws `The "paths[1]" property must be of type string, got object` during dependency resolution. This is a Bun runtime bug — OpenCode's plugin loader (`packages/opencode/src/plugin/loader.ts`) calls `import(row.entry)` with no second argument and no `paths` option. The error originates from Bun's bundled `require.resolve` wrapper which receives an invalid `options.paths` array internally when the module type is ambiguous. **Root cause on Windows**: `@ff-labs/fff-node` depends on `ffi-rs` which uses CJS `require()` to load native `.node` addons — this triggers the Bun `paths[1]` bug on Windows. **Solution**: the plugin now detects Bun at runtime (`typeof Bun !== "undefined"`) and imports `@ff-labs/fff-bun` instead, which uses `bun:ffi` (`dlopen`) and has zero CJS dependencies. Under Node.js (tests), `@ff-labs/fff-node` is used.
21. **Named exports trigger `getLegacyPlugins()` server calls**: OpenCode's `getLegacyPlugins(mod)` iterates `Object.values(mod)` and invokes each function-valued export as a separate plugin `server()`. Under Bun-on-Windows, calling an internal function like `fsGrep` or `loadGitignoreFilter` with `(PluginInput, options)` arguments triggers a `paths[1]` CJS interop crash inside Bun's `require.resolve`. **Fix**: Always wrap test-only internal exports under a single `export async function __test()` rather than individual named `export { ... }` blocks.

## Dependencies

### Runtime

- `@ff-labs/fff-node` ^0.8.1 - Core search engine for Node.js (Rust wrapper via `ffi-rs`)
- `@ff-labs/fff-bun` ^0.8.4 - Core search engine for Bun runtime (uses `bun:ffi`, no CJS deps)
- `minimatch` ^10.2.5 - Glob pattern matching for exclude parameter and `globWalk`

The plugin auto-detects the runtime at load time using `typeof Bun !== "undefined"` and imports the appropriate package. Both are listed as dependencies so they're always available.

### Peer Dependencies

- `@opencode-ai/plugin` ^1.14.28 - OpenCode plugin SDK

```
opencode-fff-search/
├── index.js          # Single plugin file (ES module)
├── package.json      # NPM package configuration
├── test/
│   ├── helpers.mjs                     # Shared test utilities (createTempProject, createMockClient, etc.)
│   ├── plugin.test.js                  # Plugin integration tests (initialization, grep/glob execute)
│   ├── internals.test.js               # Pure unit tests for internal functions
│   ├── stress.test.js                  # SIGBUS stability stress tests
│   ├── session-edit.js                # Edit+search stress test
│   ├── session-refactor.js            # Rename during search stress test
│   ├── session-db.js                  # Session DB stress test
│   ├── session-git.js                 # Git index stress test
│   ├── session-nodemodules.js         # npm install/remove stress test
│   ├── session-heavy.js               # Full agent cycle stress test
│   ├── session-concurrent.js          # Concurrent finder stress test
│   ├── integration-opencode.js        # Live opencode + async mutations
│   ├── integration-worker.js          # Live opencode + worker mutations
│   ├── integration-real-repo.js       # Live opencode + real repo mutations
│   ├── integration-worker-real.js     # Live opencode + worker + real repo
│   ├── integration-multi-session.js   # Concurrent opencode instances
│   ├── integration-multi-session-watch.js # Concurrent sessions + watch ON
│   ├── stress-mmap-enabled.js         # mmap crash demo (will SIGBUS)
│   ├── stress-mmap-single.js          # Single-instance mmap crash demo
│   ├── stress-watch-enabled.js         # Watch ON + mmap OFF stability tests
│   ├── stress-watch-real-repo.js        # Watch ON + mmap OFF on real repo
│   ├── stress-watch-timing.js           # Watcher debounce timing
│   ├── diagnose-mmap.js               # Isolated mmap diagnostic
│   ├── mutation-worker.cjs            # CJS worker for synthetic mutations
│   └── mutation-worker-real.cjs       # CJS worker for real repo mutations
├── install.sh        # Installation script (Linux/macOS only)
├── SIGBUS_INVESTIGATION.md  # SIGBUS root cause analysis
├── PUBLISHING.md     # Publishing instructions
├── LICENSE           # MIT License
└── AGENTS.md         # This file
```

Only `index.js` is included in the published npm package (see `package.json` `files` array).

## Making Changes

When modifying the plugin:

1. **Run core tests**: `node --test 'test/*.test.js'`
2. **Run session tests**: `node --test test/session-*.js`
3. **Test locally**: Link the plugin to your OpenCode config and test with real searches
4. **Check logs**: `opencode debug config --print-logs 2>&1 | grep fff`
5. **Verify return format**: Ensure tools return `{ output, metadata }`, not plain strings
6. **Match upstream**: Keep tool contracts aligned with [upstream source](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/tool/)
7. **Bump version**: Follow semver in `package.json`
8. **Publish to npm**: `npm publish --access public`

## Performance Characteristics

- **First search**: 500ms-2s (index building)
- **Subsequent searches**: <10ms (in-memory index)
- **Scan timeout**: 15s absolute limit for `waitForScan`, 5s practical limit in tools
- **Default limits**: 100 matches (grep), 100 results (glob) — configurable up to 5000
- **mmap cache**: Enabled by default — faster searches via memory-mapped file cache
- **File watcher**: Enabled by default — detects new/deleted files mid-session
- **Recall**: ~90%+ for common tokens; inconsistent for edge cases. Single-file searches have 100% recall. Non-ASCII patterns and fff-zero fallback provide exact filesystem-level recall.
- **Fallback**: When `FileFinder.create()` returns `ok:false`, the plugin operates in fs-only mode (no native fff index), using `globWalk` and `fsGrep` for all searches.
