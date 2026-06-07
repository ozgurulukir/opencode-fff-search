# opencode-fff-search

OpenCode plugin that replaces the default `grep` and `glob` file search tools with [fff](https://github.com/dmtrKovalenko/fff)'s ultra-fast, typo-resistant search engine.

## Features

- **Drop-in replacement** — Overrides OpenCode's built-in `grep` and `glob` tools
- **Blazing fast** — In-memory index, searches complete in milliseconds
- **Smart mode detection** — Automatically detects regex vs plain patterns; plain mode uses SIMD-accelerated literal matching
- **Full-text search** — Reads file contents directly for patterns with non-ASCII characters; falls back to async Node.js file reading for exact Unicode matching
- **Single-file 100% recall** — When `path` points to a file, reads it directly (bypasses fff index)
- **Real glob matching** — Recursive `**/`, brace expansion `{a,b}`, character classes via `minimatch`
- **Exact-name augmentation** — Non-glob patterns (e.g., `temp.ts`) also searched via `globWalk` when fff fuzzy results don't include an exact basename match
- **Context lines** — Renders `contextBefore`/`contextAfter` with correct line numbers when `context > 0`
- **Dynamic cursor pagination** — Accumulates results across fff's 50-item pages; page ceiling scales with `limit`
- **Exclude + include filtering** — Post-filter results with glob patterns
- **Type filtering** — Glob tool supports `type="file"` and `type="directory"`; `type=directory` with glob patterns routes directly to `globWalk`
- **TUI-compatible** — Returns `{ output, metadata }` so OpenCode's TUI displays match counts inline
- **aiMode enabled** — Frecency scoring enabled by default for better recall and ranking
- **Turkish/Unicode support** — Non-ASCII patterns route to an fs-based grep that performs exact Unicode matching (no `ş↔s` normalization)
- **.gitignore-aware fallback** — `fsGrep` and `globWalk` parse `.gitignore` to augment skip list, reducing redundancy with fff's built-in ignore support

## Prerequisites

- OpenCode 1.14+
- Node.js 18+ (or Bun)
- **Cross-platform:** Linux, macOS, Windows (WSL recommended for Windows)

## Installation

### Option 1: From npm (recommended)

Add to your `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "plugin": ["opencode-fff-search"],
}
```

OpenCode auto-installs the plugin and its dependencies on startup.

After upgrading the package version in `opencode.json`, delete the cached copy to force re-install:

```bash
rm -rf ~/.cache/opencode/packages/opencode-fff-search@latest/
```

Restart OpenCode — the plugin is re-fetched from npm on next startup.

### Option 2: Manual installation

```bash
mkdir -p ~/.config/opencode/plugins
cp index.js ~/.config/opencode/plugins/opencode-fff-search.js
cd ~/.config/opencode && npm install
```

### Option 3: Install script (Linux/macOS)

```bash
git clone https://github.com/ozgurulukir/opencode-fff-search.git
cd opencode-fff-search && npm install

# Run the test suite (172 tests)
node --test 'test/*.test.js'

# Run session simulation tests
node --test test/session-*.js

# Test plugin loads
node -e "import('./index.js').then(m => console.log('OK'))"
```

### Project structure

```
opencode-fff-search/
├── index.js          # Single plugin file (ES module)
├── package.json      # NPM package configuration
├── test/
│   ├── helpers.mjs                     # Shared test utilities
│   ├── plugin.test.js                  # Plugin integration tests
│   ├── internals.test.js               # Internal function unit tests
│   ├── stress.test.js                  # SIGBUS stability stress tests
│   └── ...                             # Session, integration tests
├── AGENTS.md         # Agent context documentation
├── README.md         # This file
└── LICENSE           # MIT License
```

## Configuration

The plugin uses hardcoded defaults with all fff features enabled:

| Option                   | Default | Description                                                                                                                             |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `aiMode`                 | `true`  | Frecency scoring (uses LMDB). Improves recall and ranking over time.                                                                    |
| `disableMmapCache`       | `false` | Memory-map file cache enabled for speed.                                                                                                |
| `disableContentIndexing` | `false` | Bigram inverted index enabled. Pre-filters files before grep, eliminating 80-95% that can't match. Speeds up grep 5-20x on large repos. |
| `disableWatch`           | `false` | File system watcher enabled. Detects new/deleted files mid-session.                                                                     |

All features are enabled for maximum search performance. The bigram content index pre-filters files before opening them — it does not affect recall, only eliminates files that cannot match.

## How It Works

This plugin overrides OpenCode's built-in `grep` and `glob` tools with fff's text search engine.

### `grep` Tool

Four search paths, selected automatically:

| Condition                           | Strategy                                             | Recall |
| ----------------------------------- | ---------------------------------------------------- | ------ |
| `path` points to a file             | `directFileGrep` — Node.js async file read           | 100%   |
| Non-ASCII pattern (Turkish/Unicode) | `fsGrep` — directory walk + Unicode regex (`u` flag) | 100%   |
| `path` outside indexed workspace    | `fsGrep` — filesystem-level grep                     | 100%   |
| ASCII pattern in indexed dir        | fff indexed search (regex/plain + smart case)        | ~90%+  |

**fff fallback chain**: If fff returns zero results, the plugin retries with regex mode (if plain failed), then falls back to `fsGrep` for guaranteed coverage.

**Mode detection**: Patterns with regex syntax (`\s`, `|`, `[abc]`, `^`, `$`) use `"regex"` mode. Everything else uses `"plain"` mode (SIMD-accelerated literal matching). Literal patterns like `example.com` or `foo(bar)` match correctly in plain mode.

**Smart case**: Lowercase patterns are case-insensitive. Uppercase or mixed-case patterns are case-sensitive. Matches ripgrep `--smart-case` behavior. Explicit `caseSensitive` parameter overrides this.

Results are frecency-ranked by fff (most recently/frequently used first). Limited to configurable count (default 100, max 5000).

### `glob` Tool

| Pattern type                        | Strategy                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| Glob metacharacters (`*`, `?`, `[`) | fff fuzzy search + minimatch post-filter → `globWalk` fallback                     |
| Fuzzy query (no metacharacters)     | fff's `fileSearch` / `directorySearch` → `globWalk` augmentation if no exact match |

- Items from fff are normalized (both `relativePath` and `fileName` always present)
- `type="directory"` with glob metacharacters (`*`, `?`, `[`) routes directly to `globWalk` (fff's `directorySearch` is fuzzy, not glob-aware). Without metacharacters, `finder.directorySearch()` is used instead.
- Output is absolute paths (matching OpenCode upstream behavior)
- For non-metachar patterns (e.g., `temp.ts`), fff returns fuzzy matches. If no result has an exact basename match, `globWalk` runs to find the real file and augment results

### TUI Rendering

Both tools return `{ output, metadata }` so OpenCode's TUI displays match counts inline. Note: `grep` uses `metadata.matches` while `glob` uses `metadata.count`.

### Exclude Filter

Matches against both `relativePath` and `fileName` because `minimatch("dir/Foo.vue", "*.vue")` returns false.

### Skipped Directories

The plugin respects `.gitignore` at two levels:

1. **fff's index** — respects `.gitignore` natively via the Rust `ignore` crate (same library ripgrep uses). Files in `node_modules/`, `dist/`, etc. are never indexed.
2. **Filesystem fallbacks** (`fsGrep`, `globWalk`) — parse `.gitignore` from disk lazily (on first use) and augment a hardcoded skip list. Results are cached per workspace root. Simple directory-name patterns (e.g., `vendor/`, `generated/`) are extracted and added to the skip set automatically.

Hardcoded baseline (used when no `.gitignore` exists):

```
.git  node_modules  .hg  .svn  __pycache__  .cache
dist  .next  coverage  .nyc_output  build  out
.nuxt  .output  .vercel  .terraform
```

Plus all dot-prefixed directories (except the search root).

### Known Limitations

#### Turkish/Unicode Overcount (Solved)

fff's search engine performs Unicode normalization that maps `ş` (U+015F) to ASCII `s`, inflating match counts for Turkish patterns. The plugin detects non-ASCII patterns and routes them to `fsGrep` — a file-level read with exact Unicode regex matching. Patterns containing characters like `ş`, `ı`, `İ`, `ğ`, `ü`, `ö`, `ç` produce counts matching bash `grep` exactly.

#### Case-Insensitive Matching for Turkish Uppercase (fff Limitation)

fff's case folding is ASCII-only. When `smartCase` is enabled and the pattern is uppercase (e.g., `ISTANBUL`), fff performs case-sensitive matching and won't find Turkish title-case text like `İstanbul` because `I` ≠ `İ` in ASCII. **Workaround**: Use lowercase patterns for case-insensitive search (e.g., `istanbul` matches `İstanbul`). For exact uppercase Turkish matching, use `caseSensitive: true` with the exact Unicode pattern.

#### Regex Support (Basic)

fff supports basic regex: character classes (`[abc]`), quantifiers (`+`, `*`, `?`), alternation (`|`), anchors (`^`, `$`), escaped classes (`\s`, `\d`, `\w`). Advanced PCRE features are **not** supported: non-capturing groups (`(?:...)`), inline flags (`(?i)`), look-ahead/behind, backreferences. Use the `caseSensitive` parameter instead of inline flags.

#### Keyword Search (Inherent fff Limitation)

fff's grep indexes symbol tokens (identifiers, component names) but not language keywords (`import`, `const`, `return`, `export`). The plugin cannot override this for ASCII patterns. For keyword search, use bash `grep`/`rg` directly.

#### Grep Recall Gap (Mitigated)

fff's grep engine does not guarantee 100% recall across all files — coverage is high for symbol names and identifiers but inconsistent for short/common words.

**Mitigation:** When `path` points to a specific file, the plugin reads it directly for guaranteed 100% recall (`directFileGrep`). For non-ASCII patterns, filesystem-level reading also provides exact coverage. For directory-wide ASCII searches requiring 100% recall, the plugin auto-falls back to `fsGrep`. If still incomplete, use bash `grep`/`rg`.

## Tool Parameters

### `grep` Tool

Fast content search with full-text matching.

| Parameter       | Type      | Required? | Default | Description                                                                               |
| --------------- | --------- | --------- | ------- | ----------------------------------------------------------------------------------------- |
| `pattern`       | `string`  | Yes       | —       | Search pattern (regex or literal text)                                                    |
| `path`          | `string`  | No        | —       | File or directory to search in. Absolute or relative to workspace root.                   |
| `include`       | `string`  | No        | —       | File pattern to include (e.g., `"*.vue"`, `"*.{ts,tsx}"`). Matches basename or full path. |
| `exclude`       | `string`  | No        | —       | Comma-separated glob patterns to exclude (e.g., `"*.test.ts,*.spec.ts"`)                  |
| `caseSensitive` | `boolean` | No        | `false` | Override smart case. `true` = always case-sensitive.                                      |
| `context`       | `number`  | No        | `0`     | Number of context lines before/after each match                                           |
| `limit`         | `number`  | No        | `100`   | Maximum total matches to return (1–5000)                                                  |

**Output format:** `relativePath:lineNumber:lineContent` (one line per match). When `context > 0`, context lines before/after each match are included with their correct line numbers.

Default limit 100, max 5000. Results are frecency-ranked by fff (most recently/frequently used first).

**Single-file mode:** When `path` points to a file (not a directory), the plugin reads the file directly, bypassing fff's index. This guarantees 100% recall for file-specific searches.

**Unicode mode:** Patterns containing non-ASCII characters (e.g., Turkish `ş`, `ı`, `İ`) use Node.js file reading with exact Unicode regex (`u` flag). This avoids fff's Unicode normalization that would overcount `ş↔s`. The fs-based path applies include/exclude filters during traversal.

### `glob` Tool

Fast file pattern matching with glob + fuzzy support.

| Parameter | Type                    | Required? | Default  | Description                                                     |
| --------- | ----------------------- | --------- | -------- | --------------------------------------------------------------- |
| `pattern` | `string`                | Yes       | —        | Glob pattern (`**/*.ts`) or fuzzy query (`helpers`)             |
| `path`    | `string`                | No        | —        | Directory to search in. Absolute or relative to workspace root. |
| `type`    | `"file" \| "directory"` | No        | `"file"` | Filter results by type                                          |
| `limit`   | `number`                | No        | `100`    | Maximum number of results (1–5000)                              |

**Glob vs fuzzy:** Patterns containing `*`, `?`, or `[` use real glob matching with minimatch. Others use fff's fuzzy file finder.

**Output format:** newline-separated absolute file paths.

## Performance

On a 48K-file repo (nodejs/node):

| Operation         | ripgrep (spawn) | fff (in-memory)                 |
| ----------------- | --------------- | ------------------------------- |
| Single grep       | ~45ms           | ~15ms                           |
| Single glob       | ~3ms            | ~6ms (glob walk) / ~2ms (fuzzy) |
| 100 grep searches | ~5min           | <1s                             |

> Benchmarks observed in local development; not produced by automated test assertions. Performance will vary by repo size and hardware.

## Platform-Specific Notes

### Windows

- **WSL recommended** for best OpenCode experience
- fff binary: `@ff-labs/fff-bin-win32-x64` (or `-arm64` for ARM)
- Bun-on-Windows known issue resolved: internal functions now wrapped under a single `__test()` export to avoid the `getLegacyPlugins()` `paths[1]` CJS interop bug

### macOS

- Works on both Intel (`x64`) and Apple Silicon (`arm64`)
- fff binaries auto-download via npm optional dependencies

### Linux

- Multiple variants supported (GNU, musl)
- Auto-detects correct binary via npm optional dependencies

## Troubleshooting

### Plugin not loading

- Ensure plugin file is in correct `plugins/` directory
- Verify dependencies: `ls ~/.config/opencode/node_modules/@ff-labs/fff-node`
- For development, symlink for live updates: `ln -sf $(pwd)/index.js ~/.config/opencode/plugins/opencode-fff-search.js`

### Plugin not updating after upgrade

If installed via `opencode.json` (`"plugin": ["opencode-fff-search"]`), delete the cached copy to force re-install:

```bash
rm -rf ~/.cache/opencode/packages/opencode-fff-search@latest/
```

Then start a fresh `opencode` session (`opencode -c`). Node.js caches ES modules per process.

### "Binary not found" errors

```bash
# Linux x64
npm install @ff-labs/fff-bin-linux-x64-gnu
# macOS Intel
npm install @ff-labs/fff-bin-darwin-x64
# macOS Apple Silicon
npm install @ff-labs/fff-bin-darwin-arm64
# Windows x64
npm install @ff-labs/fff-bin-win32-x64
```

### Missing search results (recall gap)

fff's grep may not find matches in all files when searching directories. For 100% recall, search a specific file path or use bash `grep`/`rg`.

### Glob `type=directory` returns unexpected results

- `*` wildcard now correctly matches nested directories (fixed in latest)
- `src/stores/**` returning empty is correct if `stores/` has no subdirectories — `**` requires at least one path segment to match. Use `src/**` for broader directory listing.

## Development

```bash
git clone https://github.com/ozgurulukir/opencode-fff-search.git
cd opencode-fff-search && npm install

# Run the test suite (172 tests)
node --test 'test/*.test.js'

# Run session simulation tests
node --test test/session-*.js

# Test plugin loads
node -e "import('./index.js').then(m => console.log('OK'))"
```

## Credits

- [fff](https://github.com/dmtrKovalenko/fff) — Fast file finder library
- [OpenCode](https://github.com/anomalyco/opencode) — AI coding agent

## Contributing

PRs welcome! Please:

1. Run the test suite: `node --test 'test/*.test.js'`
2. Follow existing code style (no semicolons, 2-space indent)
3. Update README if changing behavior

## License

MIT — see [LICENSE](LICENSE) file.
