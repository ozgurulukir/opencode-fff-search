# opencode-fff-search

OpenCode plugin that replaces the default `grep` and `glob` file search tools with [fff.nvim](https://github.com/dmtrKovalenko/fff.nvim)'s ultra-fast, typo-resistant, frecency-ranked search engine.

## Features

- **Blazing fast** - In-memory index, searches complete in milliseconds
- **Typo-resistant** - Fuzzy matching handles typos gracefully
- **Frecency-ranked** - Frequently accessed files rank higher
- **Git-aware** - Shows file status (modified, staged, untracked)
- **Smart case** - Auto-detects case sensitivity
- **Zero config** - Works out of the box

## Prerequisites

- OpenCode 1.14+
- Node.js 18+ (or Bun)
- **Cross-platform:** Linux, macOS, Windows (WSL recommended for Windows)

## Installation

### Option 1: Manual Installation (All Platforms)

1. **Copy the plugin to your OpenCode plugins directory:**

   **Linux/macOS:**
   ```bash
   mkdir -p ~/.config/opencode/plugins
   cp index.js ~/.config/opencode/plugins/opencode-fff-search.js
   ```

   **Windows (PowerShell):**
   ```powershell
   New-Item -ItemType Directory -Force "$env:APPDATA\opencode\plugins"
   Copy-Item index.js "$env:APPDATA\opencode\plugins\opencode-fff-search.js"
   ```

   **Or project-specific (any OS):**
   ```bash
   mkdir -p /path/to/project/.opencode/plugins
   cp index.js /path/to/project/.opencode/plugins/
   ```

2. **Install dependencies:**

   Navigate to your OpenCode config directory and install:

   **Linux/macOS:**
   ```bash
   cd ~/.config/opencode  # or ~/.opencode for project-local
   bun install            # or: npm install
   ```

   **Windows:**
   ```powershell
   cd "$env:APPDATA\opencode"
   bun install
   # or: npm install
   ```

   This installs `@ff-labs/fff-node` and downloads the platform-specific fff binary automatically.

### Option 2: Using the install script

```bash
git clone https://github.com/ozgurulukir/opencode-fff-search.git
cd opencode-fff-search
./install.sh  # Works on Linux/macOS
```

For Windows, run the equivalent commands manually or use WSL.

### Option 3: From npm (published)

Add to your OpenCode config (`opencode.json` or `opencode.jsonc`):

```json
{
  "plugin": ["opencode-fff-search"]
}
```

OpenCode will auto-install the plugin and its dependencies on next startup.

Alternatively, install globally:

```bash
npm install -g opencode-fff-search
```

## Verification

Restart OpenCode and run:

```bash
opencode run "Search for 'import' using grep"
```

You should notice faster search results. Check debug logs if needed:

```bash
opencode debug config --print-logs 2>&1 | grep fff
```

## How It Works

This plugin overrides OpenCode's built-in `grep` and `glob` tools. When the AI (or user) performs file search, it uses fff's in-memory index instead of spawning ripgrep processes.

- **`grep`** -> fff's content search with smart-case, regex, and fuzzy modes
- **`glob`** -> fff's fuzzy file finder with frecency ranking

> **Note:** Memory-mapped file caching (mmap) is disabled to prevent SIGBUS crashes.
fff's mmap warmup maps all indexed files into memory, which causes an unrecoverable
bus error when any mapped file is truncated or deleted during a session (editor saves,
git operations, builds). Standard file I/O is used instead, with negligible
performance impact for agent workloads where the index scan dominates latency.
See [fff.nvim#294](https://github.com/dmtrKovalenko/fff.nvim/issues/294).
## Tool Parameters

### `grep` Tool

Search file contents with fff's fast, typo-resistant search.

| Parameter | Type | Required? | Default | Description |
|-----------|------|-----------|---------|-------------|
| `pattern` | `string` | Yes | — | Search pattern (plain text, regex, or fuzzy) |
| `path` | `string` | No | — | Subdirectory or file to search within |
| `exclude` | `string` | No | — | Comma-separated glob patterns to exclude (e.g., `"*.log,node_modules/**"`) |
| `caseSensitive` | `boolean` | No | `false` (smart-case) | Enable case-sensitive matching |
| `context` | `number` | No | `0` | Number of lines before/after match to include |
| `limit` | `number` | No | `1000` | Maximum total matches to return |

**Smart-case behavior:** By default (`caseSensitive: false`), fff auto-detects case sensitivity—if the pattern contains uppercase letters, it becomes case-sensitive.


**Examples:**
```bash
# Simple search
opencode run "Search for 'import' using grep"

# Case-sensitive search in src directory, excluding node_modules
opencode run "Search for 'TODO' using grep with {\"path\": \"src\", \"caseSensitive\": true, \"exclude\": \"*.test.js\"}"

# Get context lines around matches
opencode run "Search for 'function' using grep with {\"context\": 3}"

# Limit results to first 50 matches
opencode run "Search for 'console.log' using grep with {\"limit\": 50}"
```

---

### `glob` Tool

Find files and directories using fff's fuzzy search.

| Parameter | Type | Required? | Default | Description |
|-----------|------|-----------|---------|-------------|
| `pattern` | `string` | Yes | — | Search pattern (fuzzy, glob, or plain text) |
| `path` | `string` | No | — | Subdirectory to search within |
| `type` | `"file" \| "directory"` | No | `"file"` | Filter results by type |
| `limit` | `number` | No | `100` | Maximum number of results |

**Examples:**
```bash
# Find all JavaScript files
opencode run "Find files matching '*.js' using glob"

# Find directories only
opencode run "Find files matching 'src' using glob with {\"type\": \"directory\"}"

# Search within a subdirectory
opencode run "Find files matching 'config' using glob with {\"path\": \"src\"}"

# Increase result limit
opencode run "Find files matching '*' using glob with {\"limit\": 500}"
```

---

## Performance

On a Chromium-sized repo (500k files):

| Operation | ripgrep (spawn) | fff (warm cache) |
|-----------|----------------|------------------|
| Single search | 3-9s | <10ms |
| 100 searches | 5-15min | <1s |

Mmap caching is disabled for stability (see above). This adds a small
constant overhead per grep call but does not affect index scan time or
file/directory search speed.

[Read the full fff.nvim performance analysis](https://github.com/dmtrKovalenko/fff.nvim#what-is-fff-and-why-use-it-over-ripgrep-or-fzf)

## Platform-Specific Notes

### Windows
- **WSL recommended** for best OpenCode experience
- Native Windows works but ensure Node.js is in PATH
- fff binary: `@ff-labs/fff-bin-win32-x64` (or `-arm64` for ARM)

### macOS
- Works on both Intel (`x64`) and Apple Silicon (`arm64`)
- fff binaries auto-download: `@ff-labs/fff-bin-darwin-x64` or `-arm64`

### Linux
- Multiple variants supported (GNU, musl)
- Auto-detects correct binary via npm optional dependencies

## Troubleshooting

### Plugin not loading
- Ensure plugin file is in correct `plugins/` directory (check with `find ~/.config/opencode/plugins`)
- Verify `~/.config/opencode/package.json` has `"type": "module"`
- Check dependencies installed: `ls ~/.config/opencode/node_modules/@ff-labs/fff-node`

### "Binary not found" errors
The fff native library didn't download. Install manually:

```bash
# Linux x64 (most common)
npm install @ff-labs/fff-bin-linux-x64-gnu

# macOS Intel
npm install @ff-labs/fff-bin-darwin-x64

# macOS Apple Silicon
npm install @ff-labs/fff-bin-darwin-arm64

# Windows x64 (in WSL or native)
npm install @ff-labs/fff-bin-win32-x64
```

See [all platform packages](https://www.npmjs.com/package/@ff-labs/fff-node?activeTab=dependencies).

### Slow first search
The first search triggers index building (typically 500ms-2s depending on repo size). Subsequent searches are instant. The index persists in memory while OpenCode runs.

### Permission errors
- Ensure you have read access to the project directory
- On Linux/macOS: check file permissions
- On Windows: run terminal as admin if accessing protected directories

## Development

```bash
git clone https://github.com/ozgurulukir/opencode-fff-search.git
cd opencode-fff-search
npm install

# Test the plugin loads correctly
node -e "import('./index.js').then(m => console.log('Plugin loads OK'))"

# Link for local development (global)
ln -sf $(pwd)/index.js ~/.config/opencode/plugins/opencode-fff-search.js

# Or on Windows (PowerShell):
# New-Item -ItemType SymbolicLink -Path "$env:APPDATA\opencode\plugins\opencode-fff-search.js" -Value "$(Get-Location)\index.js"
```

## License

MIT - see [LICENSE](LICENSE) file.

## Credits

- [fff.nvim](https://github.com/dmtrKovalenko/fff.nvim) - Fast file finder library
- [OpenCode](https://github.com/anomalyco/opencode) - AI coding agent

## Contributing

PRs welcome! Please:

1. Test with a real OpenCode session
2. Include benchmark results if optimizing performance
3. Follow existing code style (no semicolons, 2-space indent)
4. Update README if changing behavior

## Related

- [fff.nvim GitHub](https://github.com/dmtrKovalenko/fff.nvim) - The underlying search engine
- [OpenCode Plugins Docs](https://opencode.ai/docs/plugins) - Plugin development guide
- [OpenCode Ecosystem](https://opencode.ai/docs/ecosystem) - Other community plugins
