# AGENTS.md

This document provides essential context for AI agents working on the opencode-fff-search codebase.

## Project Overview

OpenCode plugin that replaces OpenCode's default `grep` and `glob` file search tools with [fff.nvim](https://github.com/dmtrKovalenko/fff.nvim)'s ultra-fast, typo-resistant, frecency-ranked search engine.

**Key characteristics:**
- Single-file ES module plugin (`index.js`)
- No build step required
- Node.js 18+ required (ES modules)
- Uses `@ff-labs/fff-node` (Rust-based fast search) and `minimatch` for glob matching
- Returns results as strings (not objects) to match OpenCode's ToolResult contract

## Architecture

### Plugin Structure

The plugin exports a single async function `FffPlugin` that:

1. **Initializes** a `FileFinder` instance from `@ff-labs/fff-node` with `aiMode: false`
2. **Creates a shared `scanPromise`** to avoid multiple concurrent index scans (critical for performance)
3. **Returns tool definitions** that override OpenCode's built-in `grep` and `glob` tools

### Data Flow

```
OpenCode tool call → FffPlugin.execute() → fff FileFinder → Format result → Return string
```

- **grep tool**: Returns `"file:line_number:line_content"` format, one per line
- **glob tool**: Returns newline-separated file/directory paths

### Key Components

- `FileFinder.create({ basePath: directory, aiMode: false })` - Initializes fff search engine
- `finder.waitForScan(15000)` - Waits for initial index build (15s timeout)
- `finder.grep(pattern, opts)` - Content search with smart case, context, limits
- `finder.fileSearch(pattern, { pageSize })` - Fuzzy file search
- `finder.directorySearch(pattern, { pageSize })` - Fuzzy directory search

## Essential Commands

### Testing

```bash
# Run the automated test suite (node:test, zero dependencies)
node --test test/index.test.js

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
cd ~/.config/opencode && bun install @ff-labs/fff-node @opencode-ai/plugin

# For project-local testing
mkdir -p .opencode/plugins && cp index.js .opencode/plugins/
cd .opencode && bun install

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
// Tool definition pattern
tool({
  description: "...",
  args: {
    param: tool.schema.string().optional(),
  },
  async execute(args, context) {
    // 1. Check abort early
    if (context.abort.aborted) throw new Error("Aborted");

    // 2. Wait for scan (with timeout)
    await Promise.race([
      scanPromise.then(() => { scanCompleted = true; }),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);

    // 3. Check abort again after async work
    if (context.abort.aborted) throw new Error("Aborted");

    // 4. Execute search
    const result = finder.grep(args.pattern, opts);

    // 5. Filter/validate results
    if (args.path) {
      // Filter by path
    }

    // 6. Return string, not object
    return formattedString;
  },
})
```

### Error Handling

```javascript
try {
  const result = finder.grep(args.pattern, opts);
  if (!result.ok) {
    await client.app.log({
      body: { service: "fff-plugin", level: "error", message: `fff grep error: ${result.error}` }
    });
    throw new Error(`fff grep error: ${result.error}`);
  }
  // Process result...
} catch (err) {
  await client.app.log({
    body: { service: "fff-plugin", level: "error", message: `EXECUTE EXCEPTION: ${err.message}\n${err.stack}` }
  });
  throw err; // Re-throw to surface error to user
}
```

### Logging

Use structured logging via `client.app.log()`:

```javascript
await client.app.log({
  body: {
    service: "fff-plugin",
    level: "info", // or "error", "warn", "debug"
    message: "Description of what happened"
  }
});
```

**Important**: Keep logs minimal. Recent cleanup removed debug logs that polluted output. Only log:
- Initialization/scan completion (info)
- Errors (error)
- Warnings about timeouts (warn)

## Critical Implementation Details
## SIGBUS Prevention

The plugin disables mmap caching in `FileFinder.create()`:

```javascript
const initResult = FileFinder.create({
  basePath: directory,
  aiMode: false,           // Disable frecency DB (LMDB mmap source)
  disableMmapCache: true,  // Prevents SIGBUS on file truncation
  disableContentIndexing: true, // Explicitly disable content index (mmap source)
  disableWatch: true,      // Disabled due to upstream stack overflow (fff.nvim#422)
});
```

**Why mmap is disabled**: fff maps indexed files into memory via `mmap()`. If any
process truncates or deletes a mapped file, reading it triggers SIGBUS (unrecoverable).
OpenCode's agent workload constantly mutates files (edits, git ops, session writes). Standard
`read()` syscalls are used instead — performance impact is negligible.

**Why watch is enabled**: The file watcher detects new and deleted files within ~2 seconds.
Without it, files created during a session (agent creates new files, npm install) never
appear in search results. With `disableMmapCache: true`, the watcher is safe — the SIGBUS
risk only materializes when mmap cache is also enabled.

**Known issue**: `finder.destroy()` blocks indefinitely when the watcher is active (native
thread join). This is a fff-node bug but doesn't affect normal operation since the plugin
never destroys the finder mid-session.

See [SIGBUS_INVESTIGATION.md](./SIGBUS_INVESTIGATION.md) for full root cause analysis.

### Tool Return Format

**CRITICAL**: Both tools must return **strings**, not objects. This is required by OpenCode's ToolResult contract.

- **grep**: Returns `"file:line_number:line_content"` joined by newlines
- **glob**: Returns file/directory paths joined by newlines

```javascript
// Correct - returns string
return lines.join('\n');

// Incorrect - returns object
return { files: lines, metadata: {...} };
```

### Shared scanPromise Pattern

The plugin uses a shared `scanPromise` to prevent multiple concurrent scans when multiple tool calls happen simultaneously:

```javascript
const scanPromise = finder.waitForScan(15000).catch(() => undefined);
scanPromise.then(() => {
  client.app.log({ body: { service: "fff-plugin", level: "info", message: "Initial fff scan complete" } });
});
```

In each tool execute, wait for scan with timeout:

```javascript
await Promise.race([
  scanPromise.then(() => { scanCompleted = true; }),
  new Promise((resolve) => setTimeout(resolve, 5000)),
]);
```

This ensures the index is built (or 5s elapsed) before searching, without blocking forever.

### Abort Handling

OpenCode can abort tool calls (e.g., user presses Escape). Check `context.abort.aborted`:

```javascript
// At start
if (context.abort.aborted) throw new Error("Aborted");

// After async operations
if (context.abort.aborted) throw new Error("Aborted");
```

### Smart Case Logic

The `caseSensitive` parameter has non-obvious behavior:

```javascript
const userLimit = args.limit || DEFAULT_GREP_LIMIT;
    const opts = {
      mode: detectGrepMode(args.pattern),  // Auto: plain (SIMD) or regex
      smartCase: args.caseSensitive !== true,  // Default is smart case
      beforeContext: args.context ?? 0,
      afterContext: args.context ?? 0,
      maxMatchesPerFile: limit,  // Follows user limit
    };
```

- If `caseSensitive: true` (explicit), then `smartCase: false`
- If `caseSensitive: false` or undefined, then `smartCase: true`
- Smart case: pattern with uppercase → case-sensitive; all lowercase → case-insensitive

### Path Filtering

Path filtering normalizes trailing slashes and supports exact match or prefix:

```javascript
if (args.path) {
  const target = args.path.replace(/\/+$/, "");  // Remove trailing slashes
  matches = matches.filter((m) => m.relativePath === target || m.relativePath.startsWith(target + "/"));
}
```

### Exclude Patterns

Uses `minimatch` library for glob pattern matching:

```javascript
if (args.exclude) {
  const patterns = args.exclude.split(",").map((p) => p.trim()).filter(Boolean);
  matches = matches.filter((m) => !patterns.some((pat) => minimatch(m.relativePath, pat, { dot: true })));
}
```

**Note**: `{ dot: true }` ensures patterns match hidden files (like `.gitignore`).

### Limit Validation

Always validate limits to prevent negative/zero values. Use `!= null` to catch `0`:

```javascript
// Validation (throws on 0, negative, or > MAX_LIMIT)
if (args.limit != null && (typeof args.limit !== "number" || args.limit < 1 || args.limit > MAX_LIMIT)) {
  throw new Error(`limit must be a number between 1 and ${MAX_LIMIT}`);
}

// Apply validated limit with fallback default
const limit = Math.max(1, args.limit || DEFAULT_GREP_LIMIT);
const pageSize = Math.max(1, args.limit || DEFAULT_GLOB_LIMIT);
```
### fff API Result Handling

All fff API calls return a Result type with `ok` boolean:

```javascript
const result = finder.grep(args.pattern, opts);
if (!result.ok) {
  // Handle error
  throw new Error(`fff grep error: ${result.error}`);
}
const matches = result.value.items;  // Success: access .value
```

## Tool Parameters Reference

### grep Tool

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `pattern` | string (required) | — | Search pattern |
| `path` | string (optional) | — | Subdirectory filter |
| `exclude` | string (optional) | — | Comma-separated glob patterns |
| `caseSensitive` | boolean (optional) | false (smart case) | Pass `true` for strict case-sensitive |
| `context` | number (optional) | 0 | Lines before/after match |
| `limit` | number (optional) | 1000 | Max total matches to return |

**Output format**: `"file:line_number:line_content\nfile:line_number:line_content\n..."`

### glob Tool

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `pattern` | string (required) | — | Search pattern |
| `path` | string (optional) | — | Subdirectory filter |
| `type` | "file" or "directory" (optional) | "file" | Filter results by type |
| `limit` | number (optional) | 100 | Max results to return |

**Output format**: `"file1.js\nfile2.js\n..."` or `"dir1/\ndir2/\n..."`

## Platform-Specific Notes

### fff Binary Download

The `@ff-labs/fff-node` package downloads platform-specific binaries automatically via npm optional dependencies. If this fails, users may need to manually install:

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
node --test test/index.test.js
```

78 unit tests across 23 suites covering initialization, tool shape, grep/glob behavior,
case sensitivity, path filtering, exclude patterns, limits, abort handling, regex, and
edge cases.

| Suite | Tests | What's verified |
|-------|-------|-----------------|
| Initialization | 7 | Plugin export shape, PluginInput compat, bad directory error, instance caching, logging, broken log survival |
| Tool definition shape | 6 | OpenCode SDK contract, parameter names match built-in grep/glob, return type is `string` |
| grep basic | 7 | Pattern matching, `file:line:content` format, relative paths, empty results, input validation |
| grep case sensitivity | 5 | Smart case default, uppercase auto-enables case-sensitive, `caseSensitive=true/false` |
| grep path filtering | 5 | Subdirectory scope, trailing slash normalization, nested paths |
| grep exclude | 4 | Single glob, comma-separated, whitespace trimming, hidden files |
| grep context | 2 | Context lines before/after match |
| grep limit | 6 | Limit enforcement, edge cases (0, negative, >5000) |
| grep input validation | 3 | Negative context, non-number types |
| grep abort | 1 | Pre-aborted signal |
| grep regex | 2 | Valid regex, invalid regex graceful fallback |
| glob basic | 6 | Fuzzy file search, newline paths, empty results, input validation |
| glob type filter | 3 | Default (file), type=directory, invalid type coercion |
| glob path/limit/abort | 4 | Path filtering, trailing slash, limit, abort |
| Edge cases | 8 | Special regex chars, long pattern, combined params, extra args, concurrent calls |

### Session simulation tests (synthetic 270-file project)

```bash
node --test test/session-*.js
```

7 tests simulating real OpenCode agent behavior on a synthetic project:
- Interleaved edits + searches (200 cycles)
- File renames during in-flight searches (50 searches + 25 renames)
- Session DB truncate+rewrite (200 cycles)
- Git index rewrite (100 cycles)
- npm install/uninstall (50 creates + 25 removes)
- Full 500-cycle agent session (grep + glob + edits + creates + deletes + renames + DB writes)
- 5 concurrent finders + 50 concurrent mutations

### Integration tests (requires `opencode` CLI)

```bash
node --test test/integration-*.js
```

4 tests spawning actual `opencode run` processes:
- Async I/O mutations on synthetic project (200 mutations)
- Worker-thread mutations on synthetic project (500 mutations)
- Async I/O mutations on real nodejs/node repo (1000 mutations)
- Worker-thread mutations on real nodejs/node repo (2000 mutations)

### Multi-session test

```bash
NUM_SESSIONS=6 node --test test/integration-multi-session.js
```

Spawns 4-6 concurrent `opencode run` instances with different prompts while
3000 files are mutated simultaneously. Configurable via `NUM_SESSIONS` env var.

### Watch-enabled tests (mmap OFF, watch ON)

```bash
node --test test/stress-watch-enabled.js       # Stability tests (~40s)
node --test test/stress-watch-timing.js         # Debounce timing (~12s)
node --test test/stress-watch-real-repo.js    # Real repo (48K files, ~55s)
```

Verifies the file watcher works correctly with mmap disabled:
- New files appear in search within ~1s on real repos
- Deleted files are removed from results within ~1s
- No SIGBUS, no hangs at moderate mutation rates
- Search latency unchanged (6ms avg grep on 48K files)

### Multi-session watch test

```bash
NUM_SESSIONS=6 node --test test/integration-multi-session-watch.js
```

Concurrent opencode sessions + watch-enabled FileFinder + 3000 mutations on real repo.
Tests watcher stability under real multi-process contention. Results: 0 SIGBUS across
4-6 sessions with 98% watcher detection rate at 4 sessions, 50% at 6 sessions.


### Mmap cache tests (proves the crash)

```bash
node --test test/stress-mmap-enabled.js   # WARNING: will SIGBUS
node --test test/stress-mmap-single.js    # WARNING: will SIGBUS on real repo
```

These tests intentionally enable `disableMmapCache: false` to demonstrate the
SIGBUS crash. They will kill the test process. See [SIGBUS_INVESTIGATION.md](./SIGBUS_INVESTIGATION.md).

### Real repo tests

Integration tests that use the nodejs/node repository require:

```bash
git clone --depth=1 https://github.com/nodejs/node.git /tmp/stress-test-repos/nodejs
```

Some tests also accept `NODEJS_REPO` env var to point to a different repo.

## Common Gotchas

1. **Return format**: Must return strings, not objects. This is critical for OpenCode tool integration.

2. **Scan timeout**: The 5s timeout in tool execute is intentional. Don't increase it—users want results even if scan isn't complete.

3. **Path trailing slashes**: Always use `.replace(/\/+$/, "")` before filtering to handle both "src" and "src/" inputs.

4. **Limit validation**: Validate with `args.limit != null &&` (not `args.limit &&`) to catch `limit: 0`. Then apply with `Math.max(1, args.limit || default)`.

5. **Abort checking**: Check `context.abort.aborted` both at start AND after any async operation.

6. **Logging overhead**: Excessive debug logs can slow down the plugin. Only log errors, warnings, and key lifecycle events.

7. **minimatch import**: Must use named import: `import { minimatch } from "minimatch"` (not default import).

8. **peerDependency**: `@opencode-ai/plugin` is a peer dependency—users install it, not the plugin itself.

9. **aiMode setting**: `FileFinder.create({ basePath: directory, aiMode: false })` disables the LMDB frecency database (another mmap source). v0.3.3+ uses `false`.

10. **Result indexing**: `result.value.items` contains matches/items, not the result object itself. Always check `result.ok` first.
11. **disableMmapCache**: Always use `disableMmapCache: true`. mmap maps files into memory; any truncation/delete causes SIGBUS. Standard read() is used instead.

12. **disableWatch**: Set to `true` (watcher disabled) due to upstream stack overflow bug in fff-node v0.6.4 ([fff.nvim#422](https://github.com/dmtrKovalenko/fff.nvim/issues/422)).

## Dependencies

### Runtime
- `@ff-labs/fff-node` ^0.6.4 - Core search engine (Rust wrapper)
- `minimatch` ^9.0.0 - Glob pattern matching for `exclude` parameter

### Peer Dependencies
``
opencode-fff-search-plugin/
├── index.js          # Single plugin file (ES module)
├── package.json      # NPM package configuration
├── test/
│   ├── helpers/
│   │   └── stress.js                  # Shared helpers: project structure, finder init
│   ├── index.test.js                  # 78 core unit tests
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
│   ├── integration-multi-session-watch.js # Concurrent sessions + watch ON + mutations
│   ├── stress-mmap-enabled.js         # mmap crash demo (will SIGBUS)
│   ├── stress-mmap-single.js          # Single-instance mmap crash demo
│   ├── stress-watch-enabled.js         # Watch ON + mmap OFF stability tests
│   ├── stress-watch-real-repo.js        # Watch ON + mmap OFF on real repo (48K files)
│   ├── stress-watch-timing.js           # Watcher debounce timing measurement
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

1. **Run core tests**: `node --test test/index.test.js`
2. **Run session tests**: `node --test test/session-*.js`
3. **Test locally**: Link the plugin to your OpenCode config and test with real searches
4. **Check logs**: `opencode debug config --print-logs 2>&1 | grep fff`
5. **Verify return format**: Ensure tools return strings, not objects
6. **Update README**: If changing tool parameters or behavior
7. **Bump version**: Follow semver in `package.json` (major/minor/patch)
8. **Create git tag**: `git tag vX.Y.Z` before publishing
9. **Publish to npm**: `npm publish --access public`

## Performance Characteristics

- **First search**: 500ms-2s (index building)
- **Subsequent searches**: <10ms (in-memory index)
- **Scan timeout**: 15s absolute limit for `waitForScan`, 5s practical limit in tools
- **Result limits**: Grep defaults to 1000 matches, glob defaults to 100 results
- **mmap cache**: Disabled (`disableMmapCache: true`) for stability — prevents SIGBUS on file truncation
- **File watcher**: Disabled (`disableWatch: true`) due to upstream stack overflow bug (fff.nvim#422)

The shared `scanPromise` pattern is critical—without it, concurrent tool calls would trigger multiple scans, causing severe performance degradation.
