# Changelog

## Unreleased

### Added

- Surface `regexFallback` boolean in grep tool metadata so agents can detect when fff falls back from plain to regex mode ([index.js](../../index.js))
- Add direct unit tests for `compilePatterns` and `shouldIncludeCompiled` ([test/internals.test.js](../../test/internals.test.js))
- Add test for `filterByPath` null targetPath short-circuit ([test/internals.test.js](../../test/internals.test.js))
- Add tests for `debugLog` enabled/disabled branches ([test/internals.test.js](../../test/internals.test.js))
- Add tests for `directFileGrep` and `fsGrep` pattern > 200 slicing ([test/internals.test.js](../../test/internals.test.js))
- Add test for `fsGrep` invalid regex → escaped fallback path ([test/internals.test.js](../../test/internals.test.js))
- Add test for `fetchGrepPages` retry exhaustion after `MAX_EMPTY_RETRIES` ([test/internals.test.js](../../test/internals.test.js))
- Add tests for `performGrepRouting` with mock finder: `regexFallbackError` capture, plain→regex retry, `isPathInsideIndexFn` gating ([test/internals.test.js](../../test/internals.test.js))
- Add tests for object-shaped directory input (`{ fsPath }`, `{ path }`) ([test/plugin.test.js](../../test/plugin.test.js))
- Add test for glob `type=directory` with metachar pattern routing ([test/plugin.test.js](../../test/plugin.test.js))
- Add test for glob truncation notice text in output ([test/plugin.test.js](../../test/plugin.test.js))
- Add tests for `.gitignore` parser edge cases: comments, negations, wildcard patterns, path patterns with slashes ([test/plugin.test.js](../../test/plugin.test.js))
- Add subprocess tests for glob `directorySearch`/`fileSearch` `!ok` throw paths ([test/glob-error-paths.test.js](../../test/glob-error-paths.test.js))
- Add subprocess test for plugin outer catch → `{ tool: {} }` fallback when `waitForScan` throws synchronously ([test/glob-error-paths.test.js](../../test/glob-error-paths.test.js))
