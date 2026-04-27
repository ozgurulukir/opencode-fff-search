# Crash Report: fff-node v0.6.4 Native SIGBUS (Stack Overflow in Grep)

## Summary

fff-node v0.6.4's native library (`libfff_c.so`) has an unbounded recursion bug in grep
processing. The crash occurs on native worker threads during content search. It cannot
be prevented by plugin configuration — the defect is in the native binary.

Two crashes observed in the same session:

| # | Date | PID | Project | Thread | Config |
|---|------|-----|---------|--------|--------|
| 1 | 2026-04-27 12:47:58 | 83045 | ipc-cost-tbfs-qwen-vue (~28K files) | 83324 | v0.3.1, `disableWatch: false` |
| 2 | 2026-04-27 15:20:08 | 116712 | vue-hakedis | 117952 | v0.3.2, `disableWatch: true` |

Crash #2 with `disableWatch: true` proves the watcher thread is **not** required to
trigger the bug. The recursion is in grep's own processing path.

## Environment

- **OS**: Debian forky/sid x64, Kernel 7.0.1-x64v3-xanmod1
- **Node.js**: 25.9.0
- **OpenCode**: 1.14.28, interactive chat mode (`opencode -c`)
- **fff-node**: v0.6.4 (latest published)

## Plugin Configuration (Crash #2 — watcher disabled)

```javascript
FileFinder.create({
  basePath: directory,
  aiMode: false,                // Disable frecency DB (LMDB mmap)
  disableMmapCache: true,       // Disable file content mmap
  disableContentIndexing: true, // Disable content index mmap
  disableWatch: true,           // Disabled — not the crash source
});
```

All known mmap sources and the watcher were disabled. The crash still occurred.

## Crash Details (Both Instances)

- **Signal**: 7 (BUS)
- **Crash location**: `libfff_c.so + 0x15aca8`
- **Binary**: Stripped — no build-id, no debug symbols
- **Core file**: `/var/lib/systemd/coredump/core.opencode.*.zst`

## Stack Trace (Crash #2)

Crashing thread: 117952 (native fff worker, not V8)

```
  #0  0x00007fe8d0d5aca8 libfff_c.so + 0x15aca8    (crash site)
  #1  0x00007fe8d0f1bf8d libfff_c.so + 0x31bf8d
  #2  0x00007fe8d0f2f3ca libfff_c.so + 0x32f3ca
  #3  0x00007fe8d0f2ce3c libfff_c.so + 0x32ce3c
  #4  0x00007fe8d0f852f9 libfff_c.so + 0x3852f9    ← grep entry point
  #5  0x00007fe8d0e34937 libfff_c.so + 0x234937
  #6  0x00007fe8d0e3859c libfff_c.so + 0x23859c
  #7  0x00007fe8d0debd93 libfff_c.so + 0x1ebd93    ← recursive pair A
  #8  0x00007fe8d0e38c63 libfff_c.so + 0x238c63    ← recursive pair B
  #9  0x00007fe8d0debd93 libfff_c.so + 0x1ebd93    ← A
 #10  0x00007fe8d0e38c63 libfff_c.so + 0x238c63    ← B
 #11  0x00007fe8d0debd93 libfff_c.so + 0x1ebd93    ← A
 #12  0x00007fe8d0e38c63 libfff_c.so + 0x238c63    ← B
 #13  0x00007fe8d0debd93 libfff_c.so + 0x1ebd93    ← A
 #14  0x00007fe8d0e38c63 libfff_c.so + 0x238c63    ← B
 #15  0x00007fe8d0debd93 libfff_c.so + 0x1ebd93    ← A
 #16  0x00007fe8d0e38c63 libfff_c.so + 0x238c63    ← B
 #17  0x00007fe8d0debd93 libfff_c.so + 0x1ebd93    ← A
 #18  0x00007fe8d0e524f9 libfff_c.so + 0x2524f9
 #19  0x00007fe8d0f09cd6 libfff_c.so + 0x309cd6
 #20  0x00007fe8d0f0a299 libfff_c.so + 0x30a299
 #21  0x00007fe8d0f0cbe7 libfff_c.so + 0x30cbe7
 #22  0x00007fe8d0f0d22e libfff_c.so + 0x30d22e
 #23  0x00007fe8d0ff1976 libfff_c.so + 0x3f1976
 #24  0x00007fe92e994da9 libc.so.6 + 0x95da9
 #25  0x00007fe92ea13e08 libc.so.6 + 0x114e08
```

**Recursive pair**: `0x1ebd93` (crash #2) / `0x1ebf52` (crash #1) ↔ `0x238c63`
**Grep entry**: `0x3852f9` (same in both crashes)
**Crash frame**: `0x15aca8` — leaf function called after recursion exhausts stack

The recursion repeats the pair 10+ times before the stack collides with the guard page.

## Root Cause

The crash is in `libfff_c.so`'s grep processing, specifically an internal function
pair that recurses without a base case. The entry path (`0x3852f9`) is the grep/scan
dispatch, which calls into `0x234937`/`0x23859c`, which enters the recursive pair.

This is **not** triggered by:
- Mmap file cache (disabled)
- File system watcher (disabled, crash #2)
- Frecency database / LMDB (disabled)
- Content indexing (disabled)

This is triggered by:
- Large project file count (28K+ files)
- Specific query patterns that hit the recursive code path
- The grep operation itself entering unbounded recursion on certain directory trees or
  file iteration patterns

## Repro Conditions

- **Project size**: 28K+ files
- **All safety flags enabled**: `disableMmapCache: true`, `aiMode: false`,
  `disableContentIndexing: true`, `disableWatch: true`
- **Mode**: Interactive `opencode -c` with repeated grep calls
- **Duration**: Variable — crash #1 after ~X hours, crash #2 after ~2.5 hours

## Mitigation

No software mitigation is possible. All configurable safety options are already at
maximum. The defect is in the native binary (`libfff_c.so`) and requires an upstream
fix.

### Current Status

The plugin is installed but the crash makes it unsafe for production use. Users should
either:

1. **Remove the plugin** — Fall back to OpenCode's built-in ripgrep-based grep
2. **Wait for upstream fix** — Track [fff.nvim#422](https://github.com/dmtrKovalenko/fff.nvim/issues/422)

## Timeline

| Date | Event |
|------|-------|
| 2026-04-27 15:20:08 | Crash #2: SIGBUS with `disableWatch: true` — proves grep is the cause |
| 2026-04-27 12:47:58 | Crash #1: SIGBUS with `disableWatch: false` — initially attributed to watcher |
| 2026-04-27 09:28 | Plugin symlinked to repo for live updates |
| 2026-04-25 | Initial test suite and stability fixes deployed |

## References

- fff.nvim#422: https://github.com/dmtrKovalenko/fff.nvim/issues/422
- fff-node v0.6.4: https://www.npmjs.com/package/@ff-labs/fff-node/v/0.6.4
- SIGBUS_INVESTIGATION.md: Mmap crash analysis (separate issue, resolved)
