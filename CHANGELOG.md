# Changelog

## Unreleased

### Added

- Add test verifying `loadGitignoreFilter` returns cached filter on repeated calls with same `basePath` ([test/plugin.test.js](../../test/plugin.test.js))
- Add subprocess-isolated test for `FileFinder.create` throw fallback path, verifying fs-only mode recovery and warning log ([test/fff-init-fallback.test.js](../../test/fff-init-fallback.test.js))
