# Publishing

This is the maintainer checklist for publishing the package defined in `package.json`. Start at the
[documentation index](index.md) or return to the [README](../README.md).

## Release checklist

1. Update the package version in `package.json` and review the `Unreleased` section in `CHANGELOG.md`.
2. Run the relevant tests and check the package contents against the manifest's `files` list.
3. Commit the release changes and create a matching version tag, for example `v1.2.3` for package version `1.2.3`.
4. Push the release commit and tag to the configured origin.
5. Publish the package from the repository root:

   ```bash
   npm publish --access public
   ```

6. Check the published version:

   ```bash
   npm view opencode-fff-search version
   ```

The package name, current version, license, runtime requirements, and published file list are declared in
[`package.json`](../package.json). The repository has no configured release script or CI publishing workflow, so these
steps are manual. Publishing requires an npm account with permission to publish `opencode-fff-search`.

## Package contents

The `files` field in `package.json` includes the six runtime modules: `index.js`, `constants.js`, `helpers.js`,
`filters.js`, `gitignore.js`, and `search.js`. It does not include the tests or documentation.

Return to the [documentation index](index.md).
