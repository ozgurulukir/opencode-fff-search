# opencode-fff-search

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

OpenCode plugin that replaces the default `grep` and `glob` file search tools with [fff.nvim](https://github.com/dmtrKovalenko/fff.nvim)'s ultra-fast, typo-resistant, frecency-ranked search engine.

## Features

- **Blazing fast** - In-memory index means searches complete in milliseconds, no process spawn overhead
- **Typo-resistant** - Smith-Waterman fuzzy matching handles typos and partial matches gracefully
- **Frecency-ranked** - Files you use often rank higher in results
- **Git-aware** - Shows modified, staged, untracked status
- **Smart case** - Auto-detects case sensitivity needs
- **Definition highlighting** - Classifies code definitions (functions, classes, etc.)
- **Background watching** - Index stays up-to-date as files change

## Prerequisites

- OpenCode 1.14+
- Node.js 18+ (for the fff-node SDK)
- Linux, macOS, or Windows

## Installation

### Local Plugin (Manual)

1. **Create the plugin directory:**

   ```bash
   # Global (all projects)
   mkdir -p ~/.config/opencode/plugins

   # OR project-specific
   mkdir -p /path/to/your/project/.opencode/plugins
   ```

2. **Copy the plugin file:**

   Download `index.js` from this repo and place it in the plugins directory:

   ```bash
   # Global
   cp index.js ~/.config/opencode/plugins/opencode-fff-search.js

   # OR project-specific
   cp index.js /path/to/project/.opencode/plugins/
   ```

3. **Add dependencies to OpenCode's package.json:**

   ```bash
   # Edit ~/.opencode/package.json (global) or project/.opencode/package.json
   ```

   ```json
   {
     "type": "module",
     "dependencies": {
       "@ff-labs/fff-node": "^0.6.4"
     }
   }
   ```

4. **Install dependencies:**

   OpenCode uses Bun by default. If Bun is not available, it falls back to npm.

   ```bash
   cd ~/.opencode  # or your project's .opencode directory
   bun install      # or: npm install
   ```

   The fff native binary will be downloaded automatically on first use.

### NPM Package (Easier - Coming Soon)

Once published to npm, you can install via OpenCode config:

```json
{
  "plugin": ["opencode-fff-search"]
}
```

And OpenCode will auto-install it.

## How It Works

This plugin overrides OpenCode's built-in `grep` and `glob` tools. When the AI (or you) uses file search:

- `grep` → uses fff's fast content search
- `glob` → uses fff's fuzzy file finder

All searches benefit from fff's in-memory index, which is built once at startup and kept warm. Subsequent searches are ~10-100x faster than spawning `ripgrep` each time.

## Performance

On a large codebase (100k+ files), typical improvements:

| Operation | ripgrep (spawn) | fff (in-memory) |
|-----------|----------------|-----------------|
| First search | 3-9s | 500ms-2s (warm-up) |
| Subsequent searches | 3-9s each | <10ms each |
| 100 searches total | 5-15 minutes | <1 second |

See the [fff.nvim benchmarks](https://github.com/dmtrKovalenko/fff.nvim#what-is-fff-and-why-use-it-over-ripgrep-or-fzf) for more details.

## Verification

After installing, restart OpenCode and run:

```bash
opencode run "Use grep to search for 'function'"
```

You should see faster results. The plugin logs its status to OpenCode's logs at startup.

## Troubleshooting

### Plugin not loading
- Ensure the plugin file is in `~/.config/opencode/plugins/` or `.opencode/plugins/`
- Check file has `.js` extension (not `.ts` unless you have TypeScript support)
- Verify `@ff-labs/fff-node` is in `node_modules/`

### Binary download fails
- Manually install: `npm install @ff-labs/fff-bin-linux-x64-gnu` (adjust for your OS/arch)
- See [fff.nvim releases](https://github.com/dmtrKovalenko/fff.nvim/releases) for prebuilt binaries

### Permission errors
- The plugin runs with same permissions as OpenCode
- Ensure you have read access to the project directory

## Development

```bash
# Clone and set up
git clone <this-repo>
cd opencode-fff-search
npm install

# Test the plugin directly
node -e "import('./index.js').then(m => console.log('OK'))"

# Link for local development (global)
ln -sf $(pwd)/index.js ~/.config/opencode/plugins/opencode-fff-search.js
```

## License

MIT - see [LICENSE](LICENSE) file.

## Credits

- [fff.nvim](https://github.com/dmtrKovalenko/fff.nvim) - The fast file finder
- [OpenCode](https://github.com/anomalyco/opencode) - AI coding agent

## Contributing

Issues and PRs welcome! Please test against a real OpenCode session and include performance metrics if applicable.
