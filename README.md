# opencode-fff-search

## About

`opencode-fff-search` provides `grep` and `glob` tools for OpenCode and MiMo Code. It uses fff's indexed search where it
fits and filesystem search for selected cases such as Unicode patterns and paths outside the workspace.

OpenCode v1.17.0 added fff-backed search tools to Core. If those built-in tools meet your needs, this plugin may be
unnecessary; this plugin also provides additional filters and filesystem fallbacks. See the
[OpenCode v1.17.0 release notes](https://github.com/anomalyco/opencode/releases/tag/v1.17.0).

The package requires Node.js 18 or newer and also supports Bun at runtime. The install script supports Linux and macOS;
on Windows, use WSL or install the package through your host's plugin configuration.

## Quickstart

Clone the repository and run the installer for the host you use. The installer copies the plugin files and installs
their runtime dependencies into the host's configuration directory.

```bash
git clone https://github.com/ozgurulukir/opencode-fff-search.git
cd opencode-fff-search
./install.sh --target opencode
```

For MiMo Code, use `./install.sh --target mimocode`. Restart the host after installation, then try a search (the host
needs a working provider configuration):

```bash
opencode run 'Search for test using grep'
```

The script uses Bun when available and npm otherwise. For installation details and platform notes, see
[Development and installation](docs/DEVELOPMENT.md).

## Features

- Provides `grep` and `glob` tools with configurable paths, filters, context, result limits, and file/directory
  selection.
- Uses fff's frecency-ranked index for supported searches, with literal and regex grep patterns, smart case on the
  indexed path, and real glob matching alongside fuzzy search.
- Reads a selected file directly and uses filesystem search for non-ASCII patterns and directory paths outside the
  workspace.
- Adds filesystem fallback when indexed grep returns no matches. Indexed ASCII searches can still return incomplete
  results; use `grep` or `rg` when you need to verify a complete directory-wide result set.
- Returns structured output and match metadata for the host UI.

See [Search behavior and tool reference](docs/SEARCH.md) for parameters, routing, output formats, and known limitations.

## Documentation

- [Documentation index](docs/index.md)
- [Development, installation, and troubleshooting](docs/DEVELOPMENT.md)
- [Search behavior and tool reference](docs/SEARCH.md)
- [Publishing](docs/PUBLISHING.md)
- [Historical SIGBUS investigation](docs/SIGBUS_INVESTIGATION.md)
- [Historical fff-node v0.6.4 crash report](docs/CRASH_REPORT_v0.6.4.md)

## Development

Install dependencies and run the core suite with Node's built-in test runner:

```bash
npm install
node --test 'test/*.test.js'
```

See [Development and installation](docs/DEVELOPMENT.md) for the other test groups and their requirements.

## License

MIT. See [LICENSE](LICENSE).
