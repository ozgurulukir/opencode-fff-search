# Search behavior and tool reference

This page documents the `grep` and `glob` tools exposed by the plugin. For setup, see the [README](../README.md) and
[development guide](DEVELOPMENT.md).

## `grep`

`grep` searches file contents. Its implementation selects an indexed fff search or a filesystem path according to the
pattern and target path.

The current fff configuration enables `aiMode`, which supplies fff's frecency ranking on indexed searches. See
`index.js` for the active native options.

### Parameters

| Parameter       | Type             | Default    | Description                                               |
| --------------- | ---------------- | ---------- | --------------------------------------------------------- |
| `pattern`       | string, required | —          | Non-empty literal text or regex pattern.                  |
| `path`          | string           | workspace  | File or directory, absolute or relative to the workspace. |
| `include`       | string           | —          | File glob pattern(s) to include.                          |
| `exclude`       | string           | —          | Comma-separated glob patterns to exclude.                 |
| `caseSensitive` | boolean          | smart case | `true` disables smart case for indexed fff search.        |
| `context`       | number           | `0`        | Number of lines shown before and after each match.        |
| `limit`         | number           | `100`      | Maximum displayed matches, from 1 to 5000.                |

Include and exclude patterns use minimatch against the relative path and filename; excludes also match individual path
segments. The direct single-file path does not currently apply include/exclude filters.

### Routing

| Search target                             | Implementation                                                    |
| ----------------------------------------- | ----------------------------------------------------------------- |
| A file path                               | Reads that file directly, bypassing the fff index.                |
| A directory and a non-ASCII pattern       | Walks the filesystem and matches with a Unicode JavaScript regex. |
| A directory outside the workspace         | Uses filesystem search; fff's index is scoped to the workspace.   |
| An indexed directory and an ASCII pattern | Uses fff grep with plain or regex mode and smart case.            |

For indexed ASCII searches, the plugin retries a plain-mode query in regex mode when there are no matches. If the
indexed path still has no matches, it falls back to filesystem search. The filesystem fallback is not run when fff
returns partial results, so an indexed search can miss additional matches. Verify results with `grep` or `rg` when
completeness matters.

Filesystem routes use JavaScript regular expressions and infer case behavior from the pattern's uppercase letters. The
`caseSensitive` option is passed to the indexed fff path; it is not currently passed into direct-file or filesystem
fallback matching. Pattern behavior can therefore differ between routes. The direct-file path also does not use fff's
plain-mode literal handling.

### Output

Each result line is formatted as `relativePath:lineNumber:lineContent`. When `context` is greater than zero, matching
lines are returned with surrounding lines and their line numbers. The result object includes `metadata.matches`,
`metadata.truncated`, and `metadata.regexFallback`.

## `glob`

`glob` finds files or directories. Patterns containing `*`, `?`, or `[` use minimatch glob matching; other patterns use
fff's fuzzy finder, with filesystem augmentation when an exact basename is absent or there are no results.

### Parameters

| Parameter | Type                  | Default   | Description                                                 |
| --------- | --------------------- | --------- | ----------------------------------------------------------- |
| `pattern` | string, required      | —         | Glob pattern or fuzzy name query.                           |
| `path`    | string                | workspace | Directory to search, absolute or relative to the workspace. |
| `type`    | `file` or `directory` | `file`    | Restrict results to files or directories.                   |
| `limit`   | number                | `100`     | Maximum displayed results, from 1 to 5000.                  |

Glob patterns with `type="directory"` use the filesystem walker directly because fff's directory finder is fuzzy rather
than glob-aware. Outside-workspace searches also use the filesystem walker. The walker matches both relative paths and
entry names, and applies minimatch with dot-file matching enabled.

Output is newline-separated absolute paths. The result metadata contains `count` and `truncated`.

## Ignore behavior

The fff index uses its own `.gitignore` support. Filesystem search skips a built-in set of directories, dot-prefixed
directories below the search root, and simple directory-name entries extracted from the workspace `.gitignore`. The
fallback parser is deliberately limited; it does not implement the full `.gitignore` rule language.

## Limitations

- Indexed ASCII grep is not a guarantee of complete recall. Its filesystem fallback runs only when the indexed path
  returns no results.
- Filesystem fallback reads files asynchronously and may be slower than indexed search on large trees.
- fff regex support and JavaScript regex support differ. The filesystem routes use JavaScript regular expressions, while
  indexed routes use fff's regex engine.
- Directory-level filesystem filtering skips dot-prefixed directories and common generated/build directories.

For installation, development, and troubleshooting, return to the [documentation index](index.md) or
[README](../README.md).
