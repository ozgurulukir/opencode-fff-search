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

1. **Initializes** a `FileFinder` instance from `@ff-labs/fff-node` with `aiMode: true`
2. **Creates a shared `scanPromise`** to avoid multiple concurrent index scans (critical for performance)
3. **Returns tool definitions** that override OpenCode's built-in `grep` and `glob` tools

### Data Flow

```
OpenCode tool call → FffPlugin.execute() → fff FileFinder → Format result → Return string
```

- **grep tool**: Returns `"file:line_number:line_content"` format, one per line
- **glob tool**: Returns newline-separated file/directory paths

### Key Components

- `FileFinder.create({ basePath: directory, aiMode: true })` - Initializes fff search engine
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
  mode: "regex",
  smartCase: args.caseSensitive !== true,  // Default is smart case (true) unless explicitly false
  beforeContext: args.context ?? 0,
  afterContext: args.context ?? 0,
  maxMatchesPerFile: Math.min(userLimit, DEFAULT_MAX_MATCHES_PER_FILE),  // 100
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

Automated test suite in `test/index.test.js` using `node:test` (zero external dependencies, Node.js 18+).

```bash
node --test test/index.test.js
```

The suite covers 69 tests across 18 suites:

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

Tests create a temporary project directory with sample files, initialize a real `FileFinder` instance, and poll until the scan completes before running assertions.

## Common Gotchas

1. **Return format**: Must return strings, not objects. This is critical for OpenCode tool integration.

2. **Scan timeout**: The 5s timeout in tool execute is intentional. Don't increase it—users want results even if scan isn't complete.

3. **Path trailing slashes**: Always use `.replace(/\/+$/, "")` before filtering to handle both "src" and "src/" inputs.

4. **Limit validation**: Validate with `args.limit != null &&` (not `args.limit &&`) to catch `limit: 0`. Then apply with `Math.max(1, args.limit || default)`.

5. **Abort checking**: Check `context.abort.aborted` both at start AND after any async operation.

6. **Logging overhead**: Excessive debug logs can slow down the plugin. Only log errors, warnings, and key lifecycle events.

7. **minimatch import**: Must use named import: `import { minimatch } from "minimatch"` (not default import).

8. **peerDependency**: `@opencode-ai/plugin` is a peer dependency—users install it, not the plugin itself.

9. **aiMode setting**: `FileFinder.create({ basePath: directory, aiMode: true })` enables AI-optimized ranking. Don't change this without understanding fff's AI mode.

10. **Result indexing**: `result.value.items` contains matches/items, not the result object itself. Always check `result.ok` first.

## Dependencies

### Runtime
- `@ff-labs/fff-node` ^0.6.4 - Core search engine (Rust wrapper)
- `minimatch` ^9.0.0 - Glob pattern matching for `exclude` parameter

### Peer Dependencies
- `@opencode-ai/plugin` >=1.14.0 - OpenCode plugin SDK (provided by OpenCode runtime)

## Package Structure

```
opencode-fff-search-plugin/
├── index.js          # Single plugin file (ES module)
├── package.json      # NPM package configuration
├── test/
│   └── index.test.js # Automated test suite (node:test)
├── install.sh        # Installation script (Linux/macOS only)
├── README.md         # User documentation
├── CODE_REVIEW.md    # Code review notes (historical)
├── PUBLISHING.md     # Publishing instructions
├── LICENSE           # MIT License
└── AGENTS.md         # This file
```

Only `index.js` is included in the published npm package (see `package.json` `files` array).

## Making Changes

When modifying the plugin:

1. **Run tests**: `node --test test/index.test.js`
2. **Test locally**: Link the plugin to your OpenCode config and test with real searches
3. **Check logs**: `opencode debug config --print-logs 2>&1 | grep fff`
4. **Verify return format**: Ensure tools return strings, not objects
5. **Update README**: If changing tool parameters or behavior
6. **Bump version**: Follow semver in `package.json` (major/minor/patch)
7. **Create git tag**: `git tag vX.Y.Z` before publishing
8. **Publish to npm**: `npm publish --access public`

## Performance Characteristics

- **First search**: 500ms-2s (index building)
- **Subsequent searches**: <10ms (in-memory index)
- **Scan timeout**: 15s absolute limit for `waitForScan`, 5s practical limit in tools
- **Result limits**: Grep defaults to 1000 matches, glob defaults to 100 results

The shared `scanPromise` pattern is critical—without it, concurrent tool calls would trigger multiple scans, causing severe performance degradation.
