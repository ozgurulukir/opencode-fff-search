# Agent guide

This file records implementation rules for coding agents. The user-facing overview is in [README.md](README.md);
canonical search behavior and test instructions are in [docs/SEARCH.md](docs/SEARCH.md) and
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Project shape

This is a modular ES module plugin for OpenCode and MiMo Code. There is no build step. The six runtime modules are
`index.js`, `search.js`, `helpers.js`, `filters.js`, `gitignore.js`, and `constants.js`.

`index.js` lazily selects the Bun or Node fff package, detects the available plugin SDK, creates one `FileFinder` per
workspace directory, waits for its initial scan, and registers `grep` and `glob`. The current `FileFinder.create()`
options are `aiMode: true`, `disableMmapCache: false`, `disableContentIndexing: false`, and `disableWatch: false`.
Verify this against `index.js` before changing this section.

If fff import or initialization fails, the plugin logs a warning and continues in filesystem-only mode. Tool execution
returns structured `{ title, output, metadata }` objects.

## Search routing invariants

- `grep` reads a selected file directly. Non-ASCII patterns and paths outside the indexed workspace use filesystem
  search. Indexed ASCII searches retry plain mode as regex when empty, then use filesystem fallback only if still empty.
- The filesystem fallback is asynchronous and can be expensive. Preserve the early `limit` check and pass the caller's
  limit at each `fsGrep` call site.
- `glob` uses minimatch for glob metacharacters and fff's file/directory finders for fuzzy names. Directory globs,
  outside-workspace searches, and empty-result cases use `globWalk`.
- Filesystem fallbacks augment the built-in skip set with simple directory-name entries read from `.gitignore`; they
  also skip dot-prefixed directories.
- fff results may use `path` instead of `relativePath` or omit `fileName`. Normalize them before path filtering or
  output formatting.
- Indexed grep can return incomplete ASCII results. Its filesystem failsafe is triggered by zero results, not by partial
  results.
- Direct-file and filesystem grep use JavaScript regex matching. Their behavior can differ from fff's plain and regex
  modes; see [Search behavior](docs/SEARCH.md).

## Implementation rules

- Resolve user paths with `resolvePathUnchecked()` when outside-workspace paths are allowed. It uses `path.resolve`; do
  not replace it with `join(directory, userPath)`. Use `resolvePath()` only when rejecting outside paths is intended.
- Preserve `{ title, output, metadata }` tool results. The host UI reads metadata for counts and truncation state.
- Check `context.abort.aborted` before work and after asynchronous waits.
- Keep native imports lazy. Under Bun, `lazyFff()` imports `@ff-labs/fff-bun`; under Node it imports
  `@ff-labs/fff-node`.
- Keep internal functions behind the single `__test()` export. Do not add named function exports that a legacy plugin
  loader might treat as plugin entry points.
- Use named imports from `minimatch`. Compile glob patterns once before loops where practical.
- Follow the existing style: two-space indentation, double quotes, and no semicolons.
- When extending tool parameters, compare the current host SDK contract and update [docs/SEARCH.md](docs/SEARCH.md).

## Tests

The tests use Node's built-in `node:test` runner. Install dependencies with `npm install`. Current test files matching
`test/*.test.js` include `plugin.test.js`, `internals.test.js`, `stress.test.js`, `module-contract.test.js`,
`glob-error-paths.test.js`, and `fff-init-fallback.test.js`.

```bash
node --test 'test/*.test.js'
node --test test/session-*.js
node --test test/integration-*.js
```

Integration tests spawn the OpenCode CLI and need a configured provider. Do not run the mmap-enabled crash reproductions
as part of routine verification; the historical findings and their version scope are in
[docs/SIGBUS_INVESTIGATION.md](docs/SIGBUS_INVESTIGATION.md) and
[docs/CRASH_REPORT_v0.6.4.md](docs/CRASH_REPORT_v0.6.4.md).

For fff-dependent unit tests, prefer injecting a mock finder into `performGrepRouting()` or `fetchGrepPages()`. Use
subprocess isolation only when a test must control native imports or plugin-level error handling; see
`test/glob-error-paths.test.js` and `test/fff-init-fallback.test.js`.

Keep stress-test fixtures isolated. Do not delete a directory shared with another test while a native finder may still
hold its index; an earlier fff version could abort the process when its indexed file count became stale after fixture
deletion.

## Dependency source of truth

Read `package.json` for supported Node version, runtime dependencies, optional SDK peer dependencies, operating systems,
and CPU architectures. Do not duplicate dependency versions here. The package metadata is authoritative.

## Historical implementation notes

- The `resolvePath()`/`path.join()` path bug recurred in earlier changes. Current search routing uses
  `resolvePathUnchecked()` where sibling or parent paths are allowed; keep that behavior deliberate.
- A process-fatal Rust slice panic was reported in fff-node v0.7.0–v0.7.2 when a stale indexed file count exceeded the
  current file list. It was triggered by test fixture directory reuse; JavaScript cannot catch a native process abort.
  Treat this as version-specific history and recheck the resolved fff version before assuming it applies.
- The Bun-on-Windows module-loading issue described in older notes is runtime-specific history. Consult the original
  commit history and issue reports before treating it as a current defect.
- SIGBUS findings were collected against older fff versions and configurations. They do not establish the behavior of
  the current dependency range; see the [historical reports](docs/index.md#historical-investigations).

## Changes and releases

Run the relevant test group for code changes, check that output and metadata remain host-compatible, and update the
search reference when tool behavior changes. Maintainer release notes are in [docs/PUBLISHING.md](docs/PUBLISHING.md).
