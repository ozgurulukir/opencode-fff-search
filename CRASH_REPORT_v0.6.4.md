# Crash Report: fff-node v0.6.4 Native SIGBUS

## Summary

fff-node v0.6.4's native library (`libfff_c.so`) crashes with SIGBUS during file
search operations (both `grep` and `glob`/`directorySearch`). The crash cannot be
prevented by plugin configuration — all known mmap-disable flags are set, but the
library still imports `mmap`/`mmap64` from glibc and uses them in internal paths
not gated by those flags.

8 crashes observed across 24 hours:

| # | Date | PID | Process | Crash addr | Project | Trigger |
|---|------|-----|---------|------------|---------|---------|
| 1 | Apr 27 08:39 | 31755 | opencode | — | — | — |
| 2 | Apr 27 12:47 | 83045 | opencode | `+0x15aca8` | local project | grep |
| 3 | Apr 27 15:20 | 116712 | opencode | `+0x15aca8` | local project | grep |
| 4 | Apr 27 17:14 | 155727 | node (test) | `+0x1c9b30` | test suite | grep |
| 5 | Apr 27 17:15 | 156854 | node (test) | `+0x1c9b30` | test suite | grep |
| 6 | Apr 27 17:15 | 157017 | node (test) | `+0x1c9b39` | test suite | grep |
| 7 | Apr 27 19:56 | 194759 | opencode | `+0x2d436b` | local project | glob |
| 8 | Apr 28 12:09 | 9379 | opencode | `+0x1c9b30` | local project | — |

Crashes #7 is confirmed glob/directorySearch. Crashes #4-6 are intentional test runs
of the mmap stress tests. Crashes #1-3, #8 are opencode sessions with both grep and glob
activity. The crash address varies (`0x15aca8`, `0x1c9b30`, `0x1c9b39`, `0x2d436b`),
indicating multiple distinct mmap access sites inside the library.

## Environment

- **OS**: Debian forky/sid x64, Kernel 7.0.1-x64v3-xanmod1
- **Node.js**: 25.9.0
- **OpenCode**: 1.14.28, interactive chat mode (`opencode -c`)
- **fff-node**: v0.6.4 (latest stable published)
- **libfff_c.so**: stripped, no build-id, no debug symbols

## Plugin Configuration (All Crashes)

```javascript
FileFinder.create({
  basePath: directory,
  aiMode: false,                // Disable frecency DB (LMDB mmap)
  disableMmapCache: true,       // Disable file content mmap cache
  disableContentIndexing: true, // Disable content index mmap
  disableWatch: true,           // Disabled (fff.nvim#422 stack overflow bug)
});
```

All four mmap/watcher-related flags are set to maximum safety. The crash still occurs.

## Binary Analysis

`libfff_c.so` imports `mmap` and `mmap64` from glibc regardless of configuration:

```
$ nm -D libfff_c.so | grep mmap
                 U mmap64@GLIBC_2.2.5
                 U mmap@GLIBC_2.2.5
```

The exported `fff_create_instance2` function receives boolean parameters:
- `enable_mmap_cache` (set to `false` by `disableMmapCache: true`)
- `enable_content_indexing` (set to `false` by `disableContentIndexing: true`)
- `watch` (set to `false` by `disableWatch: true`)

But the library uses mmap in internal paths (search index traversal, file iteration)
that are not gated behind these parameters. The crash addresses (`0x15aca8`,
`0x1c9b30`, `0x2d436b`) fall in different regions of the binary, confirming
multiple unprotected mmap call sites.

## Root Cause

**SIGBUS from mmap'd file access on mutated files.** OpenCode agents constantly
mutate files (edits, writes, git operations). When fff has an mmap'd view of a
file and that file is truncated, deleted, or rewritten by another process or
thread, the subsequent access to the mmap'd region delivers SIGBUS.

The `disableMmapCache: true` flag only disables fff's *file content caching*
layer (which stores file contents in memory via mmap for fast access). It does
not disable mmap usage in:
- The in-memory search index structure
- File metadata traversal during directory/file search
- Internal data structures used for scoring and matching

This is fundamentally a design defect in fff-node v0.6.4: it assumes files are
unchanged during the lifetime of a search index, which is incompatible with
AI agent workloads that interleave file mutation and search.

## Common Stack Trace Pattern (Grep)

Crashes #2 and #3 share this pattern (crash #3 shown):

```
  #0  libfff_c.so + 0x15aca8    (crash site)
  #1  libfff_c.so + 0x31bf8d
  #2  libfff_c.so + 0x32f3ca
  #3  libfff_c.so + 0x32ce3c
  #4  libfff_c.so + 0x3852f9    grep entry point
  #5  libfff_c.so + 0x234937
  #6  libfff_c.so + 0x23859c
  #7  libfff_c.so + 0x1ebd93    -+
  #8  libfff_c.so + 0x238c63     | search result iteration
  #9  libfff_c.so + 0x1ebd93     |
 #10  libfff_c.so + 0x238c63     | (not recursion: thread-local
 #11  libfff_c.so + 0x1ebd93     |  work-stealing iterator pattern)
 #12  libfff_c.so + 0x238c63     |
 #13  libfff_c.so + 0x1ebd93     |
 #14  libfff_c.so + 0x238c63     |
 #15  libfff_c.so + 0x1ebd93     |
 #16  libfff_c.so + 0x238c63     |
 #17  libfff_c.so + 0x1ebd93    -+
 #18  libfff_c.so + 0x2524f9
 #19  libfff_c.so + 0x309cd6    thread pool dispatch
 #20  libc start_thread
```

The repeating `0x1ebd93`/`0x238c63` pair was initially mistaken for recursion.
It is actually a thread-local search iterator pattern that walks through
result items. The crash occurs when one of these iterations accesses an
mmap'd data structure that has been invalidated by a concurrent file mutation.

## Stack Trace Pattern (Glob - Crash #7)

```
  #0  libfff_c.so + 0x2d436b    (crash site)
  #1  libfff_c.so + 0x237848
  #2  libfff_c.so + 0x1ebd93    same iterator as grep path
  #3  libfff_c.so + 0x238c63
  #4  libfff_c.so + 0x1ebd93
  #5  libfff_c.so + 0x238c63
  ...
 #13  libfff_c.so + 0x2524f9
 #14  libfff_c.so + 0x309cd6    thread pool dispatch
```

Crash #7 confirms both grep and glob paths share the same vulnerable mmap'd
data structures.

## Repro Conditions

- **Any project size**: crashes occurred on projects from small to large
- **All safety flags enabled** as shown above
- **Any search type**: grep (content search), glob (directorySearch/fileSearch)
- **Mode**: Interactive `opencode -c` with interleaved file mutations and searches
- **Duration**: Variable — crashes after 1-3 hours of active use

## Mitigation

No software mitigation is possible. All configurable safety options are at maximum.
The defect is in the native binary (`libfff_c.so`) and requires an upstream fix.

### Recommended Actions

1. **For users**: Remove the plugin and use OpenCode's built-in ripgrep-based grep
2. **For upstream**: 
   - Replace all internal mmap usage with `read()`-based access when `enable_mmap_cache=false`
   - Or provide a `disable_all_mmap: true` flag that gates ALL mmap paths
3. **For plugin**: Track fff-node releases for a fix; consider a `0.6.5-nightly` test

## Timeline

| Date | Event |
|------|-------|
| 2026-04-28 12:09 | Crash #8: SIGBUS in local project session |
| 2026-04-27 19:56 | Crash #7: SIGBUS during glob/directorySearch — confirms grep not the only trigger |
| 2026-04-27 17:15 | Crashes #4-6: mmap stress test runs (intentional) |
| 2026-04-27 15:20 | Crash #3: SIGBUS with `disableWatch: true` applied |
| 2026-04-27 12:47 | Crash #2: SIGBUS during grep in local project |
| 2026-04-27 08:39 | Crash #1: earliest recorded crash |

## References

- fff.nvim#422 (watcher stack overflow): https://github.com/dmtrKovalenko/fff.nvim/issues/422
- fff-node v0.6.4: https://www.npmjs.com/package/@ff-labs/fff-node/v/0.6.4
- SIGBUS_INVESTIGATION.md: Mmap cache crash analysis (file content cache, resolved by `disableMmapCache`)
- Upstream issue filed for internal mmap: [link if filed]
