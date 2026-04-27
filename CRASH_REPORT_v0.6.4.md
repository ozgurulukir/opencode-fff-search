# Crash Report: fff-node v0.6.4 Native SIGBUS (Stack Overflow)

Date: 2026-04-27 12:47:58 +03
Environment: Debian forky/sid x64, Kernel 7.0.1-x64v3-xanmod1, Node.js 25.9.0
Plugin: opencode-fff-search v0.3.1, linked via symlink

## Crash Details
- **Signal**: 7 (BUS)
- **Core file**: `/var/lib/systemd/coredump/core.opencode.1000.*.zst` (79.6 MB)
- **OpenCode CLI**: `opencode -c` (interactive chat mode), version 1.14.28
- **Crash location**: `libfff_c.so + 0x15aca8`
- **Binary info**: `libfff_c.so` is stripped — no build-id, no debug symbols

## Plugin Configuration

```javascript
FileFinder.create({
  basePath: directory,
  aiMode: false,                // Disable frecency DB (LMDB mmap)
  disableMmapCache: true,       // Disable file content mmap
  disableContentIndexing: true, // Disable content index mmap
  disableWatch: false,          // File watcher enabled (stable with mmap off)
});
```

All known mmap sources were already disabled. The crash is **not** from reading a truncated mmap'd file.

## Stack Trace Analysis

Crashing thread: 83324 (native fff worker thread, not V8 main thread)

```
#0  0x00007fdc21b5aca8 libfff_c.so + 0x15aca8    (crash site)
#1  0x00007fdc21d1bf8d libfff_c.so + 0x31bf8d
#2  0x00007fdc21d2ee7a libfff_c.so + 0x32ee7a
#3  0x00007fdc21d2ce3c libfff_c.so + 0x32ce3c
#4  0x00007fdc21d852f9 libfff_c.so + 0x3852f9
#5  0x00007fdc21c34937 libfff_c.so + 0x234937
#6  0x00007fdc21c3859c libfff_c.so + 0x23859c
#7  0x00007fdc21bebf52 libfff_c.so + 0x1ebf52
#8  0x00007fdc21c38c63 libfff_c.so + 0x238c63      ← start of recursion
#9  0x00007fdc21bebf52 libfff_c.so + 0x1ebf52      ←
#10 0x00007fdc21c38c63 libfff_c.so + 0x238c63      ← repeating pair
#11 0x00007fdc21bebf52 libfff_c.so + 0x1ebf52      ←
#12 0x00007fdc21c38c63 libfff_c.so + 0x238c63      ←
#13 0x00007fdc21bebd93 libfff_c.so + 0x1ebd93      ←
#14 0x00007fdc21c38c63 libfff_c.so + 0x238c63      ← stack overflow
... continues for >20 frames
```

**Pattern**: Frames #8-#14 alternate between `0x1ebf52` and `0x238c63` (libfff_c.so).
This is **not** an mmap page fault -- it's a **stack overflow** from unbounded recursion
inside libfff_c.so's native code.

The crash frame (#0, `0x15aca8`) is *not* part of the recursive loop -- it is the
function called at the bottom of the call chain after the recursion exhausted the
stack. The full path is: **call into grep/scan -> watcher event dispatch ->
recursive processing loop (`0x1ebf52` <-> `0x238c63`) -> leaf function (`0x15aca8`)
-> SIGBUS as stack collides with guard page.**

## Root Cause (Inferred)

fff-node v0.6.4's native library (`libfff_c.so`) has an **unbounded recursion bug**
in its watcher/grep interop code. The evidence:

- **Crash is on a native worker thread** (83324), not the V8 main thread
- **Recursion is in the watcher/grep interaction path**: frames #1-#6 show the call
  descends from `0x3852f9` (likely a scan or grep entry point) into the recursive pair
- **The recursive pair (`0x1ebf52` <-> `0x238c63`) is the defect** -- it cycles without
  a base case or depth limit

Likely scenario:
1. The file system watcher detects an event (inotify notification)
2. The watcher callback invokes index update logic
3. The index update modifies something the watcher is watching
4. The watcher re-fires the callback -> re-enters index update -> loops

This is consistent with:
- Crash occurring with `disableWatch: false` (watcher enabled)
- Crash NOT occurring with `disableWatch: true` (no watcher thread)
- 28K-file project providing many watcher events to trigger the loop
## Repro Conditions

- **Project**: ipc-cost-tbfs-qwen-vue (~28,261 files)
- **OpenCode mode**: Interactive chat (`opencode -c`) with background file mutations
- **Watcher enabled**: `disableWatch: false`
- **Background mutations**: Concurrent file operations (ccache, build artifacts, git operations)
- **Duration**: Unknown (OpenCode was running in interactive chat mode)

## Mitigation Options

| Option | Change | Effect |
|--------|--------|--------|
| **Disable watcher** | `disableWatch: true` | Eliminates crash, new files invisible until restart |
| Run without plugin | Remove plugin | No fff at all, falls back to ripgrep |
| Report upstream | File issue with fff-node | Fix in future release |

## Timeline

| Date | Event |
|------|-------|
| 2026-04-27 12:47:58 | SIGBUS crash in libfff_c.so (stack overflow in native thread) |
| 2026-04-27 09:28 | Plugin symlinked to v0.3.1 (all mmap sources disabled) |
| 2026-04-25 | Initial test suite and stability fixes deployed |

## References

- fff-node v0.6.4 npm package: https://www.npmjs.com/package/@ff-labs/fff-node/v/0.6.4
- SIGBUS_INVESTIGATION.md: Previous findings on mmap-related crashes
- OpenCode issue tracker: https://github.com/dmtrKovalenko/fff.nvim/issues
- Linux mmap(2): SIGBUS behavior on truncated files
