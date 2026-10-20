# Development, installation, and troubleshooting

This guide covers installing and working on `opencode-fff-search`. For tool behavior, see [Search behavior](SEARCH.md);
for the project overview, see the [README](../README.md).

## Requirements

- Node.js 18 or newer is required by the package manifest. The plugin also selects the Bun-specific fff package when it
  runs under Bun.
- The host application must be installed: OpenCode or MiMo Code.
- The install script targets Linux and macOS. On Windows, use WSL or configure the plugin manually through the host.

## Install the plugin

From a shell on Linux or macOS:

```bash
git clone https://github.com/ozgurulukir/opencode-fff-search.git
cd opencode-fff-search
./install.sh --target opencode
```

Use `./install.sh --target mimocode` for MiMo Code. The script copies the plugin modules into the host configuration
directory, creates a top-level plugin symlink, and installs the required fff, minimatch, and host SDK packages. It uses
Bun if available, otherwise npm. Restart the host after installing.

The script prints a sample command when it completes. For OpenCode, its example is:

```bash
opencode run 'Search for test using grep'
```

For MiMo Code, the script prints the corresponding `mimo run` command. These commands need a working host configuration
and provider.

## Run the tests

Install the package dependencies from the repository root, then use Node's built-in test runner:

```bash
npm install
node --test 'test/*.test.js'
```

Other test groups are:

```bash
# Filesystem mutation simulations
node --test test/session-*.js

# OpenCode subprocess integrations; requires the opencode CLI and a configured provider
node --test test/integration-*.js

# Watch-enabled stress scenarios
node --test test/stress-watch-enabled.js
node --test test/stress-watch-timing.js
node --test test/stress-watch-real-repo.js
```

The mmap-enabled tests are diagnostic crash reproductions and are not part of the normal suite. The historical reports
describe SIGBUS observed with older fff versions and settings; consult them before running these tests:

```bash
node --test test/stress-mmap-enabled.js
node --test test/stress-mmap-single.js
```

See [SIGBUS investigation](SIGBUS_INVESTIGATION.md) and the [fff-node v0.6.4 crash report](CRASH_REPORT_v0.6.4.md) for
the scope and age of those observations.

## Source layout

| File           | Responsibility                                                                          |
| -------------- | --------------------------------------------------------------------------------------- |
| `index.js`     | Plugin entry point, SDK/native runtime detection, tool definitions, and initialization. |
| `search.js`    | Grep/glob routing, fff pagination, and filesystem search.                               |
| `helpers.js`   | Path handling, logging, abort-safe scan waiting, and debug output.                      |
| `filters.js`   | Path and minimatch filtering.                                                           |
| `gitignore.js` | Cached `.gitignore`-derived fallback directory filter.                                  |
| `constants.js` | Limits, timeouts, patterns, and skipped-directory defaults.                             |

Internal functions used by tests are returned by the single `__test()` export. Avoid adding named function exports: the
host's legacy plugin loader may call exported functions as plugin entry points.

## Troubleshooting

### The plugin loads twice

The install script uses a local plugin symlink. If the host config also lists the npm package `opencode-fff-search`,
remove that package entry when using the script-based installation.

### Changes do not appear

Re-run `./install.sh --target opencode` or `./install.sh --target mimocode` after updating the checkout. The script
refreshes the copied plugin files and skips dependency installation when they are already present.

### Search results are incomplete

Indexed ASCII grep may return partial results without triggering filesystem fallback. Search a specific file or verify a
directory-wide result with `grep` or `rg`. See [Search limitations](SEARCH.md#limitations).

### The native fff package does not load

The plugin logs an `fff-native import failed` warning and uses filesystem search if the native package cannot be
imported. Re-run the installer for the host in use and check its configuration directory for the fff packages installed
by the script. The supported operating systems and CPU architectures are listed in `package.json`.

### Inspect fallback logs

Set `DEBUG_GREP=1` in the host environment to enable the plugin's diagnostic stderr messages. The plugin also logs
initialization and fallback warnings through the host client logger.

## Contributing

Use the existing JavaScript style: two-space indentation, double quotes, and no semicolons. Run the relevant test group
for code changes. The repository has no separate `CONTRIBUTING.md`; check the [README](../README.md) and open a pull
request through the repository's [GitHub project](https://github.com/ozgurulukir/opencode-fff-search).

Return to the [documentation index](index.md).
