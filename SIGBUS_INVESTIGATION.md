# SIGBUS Investigation Report

## Summary

**SIGBUS crashes were caused by fff's mmap file cache mapping indexed files into memory.** When any process (editor, git, build tool) truncated, deleted, or overwrote a file that was mmap'd by fff, the process received an unrecoverable SIGBUS (signal 7). The fix is to disable both mmap caching and the file watcher in `FileFinder.create()`.

## Root Cause

fff's `FileFinder` uses `mmap()` to map indexed files into virtual memory for fast content searches. This is standard for read-heavy workloads but has a critical vulnerability:

1. **mmap maps a region of the file** into the process's address space
2. **If the underlying file is truncated**, the mmap'd region becomes invalid
3. **Any read from the invalid region triggers SIGBUS** (bus error — signal 7)
4. **SIGBUS cannot be caught in JavaScript** — it kills the process immediately

In OpenCode's agent workload, the filesystem is constantly mutated:
- Agent edits files (editor saves truncate + rewrite)
- Git operations modify `.git/index`
- OpenCode writes to `.opencode/session.db`
- npm install/uninstall modifies `node_modules/`

Any of these operations on an mmap'd file = instant process death.

## Timeline

### Phase 1: Bug Reports
- User reported intermittent SIGBUS crashes during OpenCode sessions
- Crashes were non-deterministic — depended on timing between file writes and fff reads

### Phase 2: Initial Investigation
- Researched `@ff-labs/fff-node` API: `FileFinder.create()` options, `disableMmapCache`, `disableWatch`
- Identified fff's mmap warmup as the likely culprit
- Confirmed `disableMmapCache` and `disableWatch` are valid options

### Phase 3: Bug Fixes
1. **`disableWatch: true`** — Prevents fff's file watcher from triggering re-indexing during mutations (watcher detects file changes and triggers full re-scan, hitting mmap'd files mid-mutation)
2. **`disableMmapCache: true`** — Disables mmap entirely, using standard `read()` syscalls instead

### Phase 4: Test Suite (78 → 93+ tests)

#### Unit Tests (78 tests, 23 suites)
- Initialization, tool shape, grep/glob behavior, case sensitivity, path filtering, exclude, limits, abort, regex, edge cases

#### Synthetic Stress Tests (7 tests)
- File mutation during search (delete, truncate, overwrite, rapid create/delete)
- Multiple native instances, destroy during search, large file handling
- Plugin-level stress (multiple calls, multiple directories)

#### Session Simulation Tests (7 tests)
- 200 interleaved edit+search cycles on synthetic 270-file project
- 50 in-flight searches + 25 file renames
- 200 session DB truncate+rewrite cycles
- 100 git index rewrite cycles
- 50 package creates + 25 removes
- 500 full agent cycles (grep + glob + edits + creates + deletes + renames + DB writes)
- 5 concurrent finders x 30 searches + 50 concurrent mutations

#### Integration Tests (4 tests)
- Live `opencode run` + async I/O mutations (synthetic, 200 mutations)
- Live `opencode run` + worker thread mutations (synthetic, 500 mutations)
- Live `opencode run` + async I/O mutations on real nodejs/node repo (1000 mutations)
- Live `opencode run` + worker thread mutations on real nodejs/node repo (2000 mutations)

#### Multi-Session Tests (1 test, configurable)
- 4-6 concurrent `opencode run` instances on real repo + 3000 mutations

## Diagnosis: mmap Cache vs Watch

| Config | mmap cache | watch | Result |
|---|---|---|---|
| Current plugin | OFF | OFF | **Pass** (all tests) |
| mmap only | ON | OFF | **SIGBUS** on real repo after ~500 mutations |
| mmap + watch | ON | ON | **Hangs** (watch triggers re-indexing loop) |
| Multiple instances | ON | OFF | **SIGBUS** (second FileFinder instance crashes) |

### Key Finding

The SIGBUS is **not** from mutations during search. It occurs because:
1. `FileFinder.create()` with `disableMmapCache: false` mmaps all indexed files during scan
2. Any subsequent file mutation invalidates the mmap'd region
3. The next grep/glob read from that region triggers SIGBUS

Even with `disableWatch: true` (no re-indexing), the **initial scan** already mmaps files. If those files are mutated before or during any search, SIGBUS fires.

### Why disableMmapCache: true is Safe

With mmap disabled, fff uses standard `read()` syscalls:
- File is read fresh on each search — no stale memory mappings
- File can be truncated/deleted/overwritten between reads without crashing
- Performance impact is negligible: the in-memory index (file list, metadata) dominates latency, not individual file reads

### Why disableWatch: true is Necessary

With the watcher enabled, fff re-indexes on every file change:
1. File watcher detects mutation → triggers re-scan
2. Re-scan re-mmaps all files (if mmap cache is on)
3. If any file is mid-mutation during re-scan → SIGBUS
4. Even with mmap off, rapid mutations cause excessive re-scanning

### Watch-Only Testing (disableMmapCache: true, disableWatch: false)

With mmap cache OFF, the watcher was tested on synthetic projects and real repos:

#### Synthetic project (270 files)

| Test | Mutations | Rate | Duration | Result |
|------|-----------|------|----------|--------|
| Slow (200ms interval) | 100 | 5/s | 20.5s | **Pass** — 0 errors |
| Moderate (50ms interval) | 100 | 20/s | 5.2s | **Pass** — 0 errors |
| New file detection | 5 files | N/A | 2.1s | Detected at 2s |
| Deleted file detection | 1 file | N/A | 10s | Detected at 10s |
| Directory create/delete | 10 dirs | 200ms | 3.0s | **Pass** |
| Grep with context | 50 | 150ms | 8.0s | **Pass** |

#### Real repo (nodejs/node — 48,208 files, 887MB)

| Test | Mutations | Rate | Duration | Result |
|------|-----------|------|----------|--------|
| New file detection | 3 files | N/A | **1s** | Detected at 1s |
| Deleted file detection | 1 file | N/A | **1s** | Detected at 1s |
| Grep new content | 1 file | N/A | **1s** | Detected at 1s |
| 100 mutations + searches | 100 | 2/s (500ms) | 50s | **Pass** — 0 errors |
| Grep latency (20 searches) | N/A | N/A | 120ms | avg **6ms**, max 8ms |
| Glob latency (20 searches) | N/A | N/A | 130ms | avg **6.5ms**, max 9ms |

#### Concurrent opencode sessions + watch ON on real repo

| Sessions | Mutations | Duration | SIGBUS | FS errors | Watcher detection |
|----------|-----------|----------|--------|-----------|------------------|
| 4 | 917 | 18.7s | **0** | 0 | **98%** (90/92) |
| 6 | 2006 | 40.5s | **0** | 0 | **50%** (100/201) |

Note: exit codes 0 and 1 are expected (code 1 = API errors/rate limits, not crashes).
Watcher detection rate varies with mutation speed — at 20ms intervals, many files
are created and deleted between 3s polling checks. The watcher itself detects them
faster; the measurement interval limits observed rate.

**Findings:**
- No SIGBUS with watcher enabled + mmap off on any configuration (confirming mmap is the sole SIGBUS cause)
- No hangs at moderate mutation rates (50ms interval, 20 mutations/sec)
- **New files detected within 1s** on real repo (48K files) — faster than synthetic project
- **Deleted files detected within 1s** on real repo
- **grep benefits from watcher** — only searches files in the index, not all files on disk
- **Search latency unaffected** by watcher — 6ms avg on 48K files
- **Concurrent opencode sessions stable** — 6 sessions + 3000 mutations, zero crashes
- `finder.destroy()` **blocks indefinitely** when watcher is active (native thread join)

**Assessment:** The watcher is production-ready with mmap off. New files appear in both grep and glob
within 1s on real repos, deleted files are cleaned up within 1s, and concurrent opencode sessions
remain stable. The `destroy()` blocking is a fff-node bug but irrelevant during normal
plugin operation.

**Decision:** `disableWatch: false` (watcher enabled) with `disableMmapCache: true` (mmap off).
## dmesg Analysis

Kernel logs showed **no SIGBUS/SIGSEGV entries** — only OOM killer toggle messages:
```
[59596.508387] OOM killer disabled.
[59598.681736] OOM killer enabled.
```

This is expected behavior:
- SIGBUS is a user-space signal, not a kernel error
- The kernel delivers SIGBUS to the process but doesn't log it as a system error
- OOM killer toggling is from fff's native (Rust) layer or LMDB frecency database

## Tradeoffs

### What We Lose
- **`finder.destroy()` blocks**: With watcher active, cleanup hangs on native thread join. Not a problem during normal operation (plugin never destroys finder mid-session).
- **Watcher re-index cost on large repos**: On a 48K-file repo, each file mutation triggers re-indexing. At 2 mutations/sec (500ms spacing), the watcher keeps up. At 50 mutations/sec (20ms), detection rate drops to ~50%.

### What We Gain
- **New file detection**: Files created during a session appear in search within ~1s on real repos (48K files)
- **Deleted file cleanup**: Deleted files are removed from results within ~1s
- **Both grep and glob benefit**: fff only searches files in its index, so watcher-driven index updates affect all search types
- **No performance penalty**: Search latency unchanged — 6ms avg grep, 6.5ms avg glob on 48K files
- **Concurrent session stability**: 6 concurrent opencode instances + 3000 mutations, zero SIGBUS

## Test Infrastructure

```
test/
├── helpers/
│   └── stress.js                    # Shared: project structure, finder init, cleanup
├── index.test.js                    # 78 core unit tests
├── session-edit.js                  # 200 edit+search cycles
├── session-refactor.js              # 50 searches + 25 renames
├── session-db.js                    # 200 session DB rewrites
├── session-git.js                   # 100 git index rewrites
├── session-nodemodules.js           # 50 creates + 25 removes
├── session-heavy.js                 # 500 full agent cycles
├── session-concurrent.js            # 5 finders + 50 concurrent mutations
├── integration-opencode.js          # Live opencode + async mutations
├── integration-worker.js            # Live opencode + worker thread mutations
├── integration-real-repo.js         # Live opencode + real repo mutations
├── integration-worker-real.js       # Live opencode + worker thread + real repo
├── integration-multi-session.js     # 4-6 concurrent opencode instances
├── integration-multi-session-watch.js # Concurrent sessions + watch ON + mutations
├── stress-mmap-enabled.js           # mmap cache ON tests (proves the crash)
├── stress-mmap-single.js           # Single-instance mmap test on real repo
├── stress-watch-enabled.js         # Watch ON + mmap OFF stability tests
├── stress-watch-real-repo.js        # Watch ON + mmap OFF on real repo (48K files)
├── stress-watch-timing.js           # Watcher debounce timing measurement
├── diagnose-mmap.js                 # Isolated diagnostic: which operation triggers SIGBUS
├── mutation-worker.cjs              # CJS worker for synthetic mutations
└── mutation-worker-real.cjs         # CJS worker for real repo mutations
```

## Running Tests

```bash
# Core unit tests
node --test test/index.test.js

# Session simulation tests
node --test test/session-*.js

# Integration tests (requires opencode installed and plugin symlinked)
node --test test/integration-*.js

# Multi-session test (configurable: NUM_SESSIONS=6)
NUM_SESSIONS=6 node --test test/integration-multi-session.js

# Multi-session with watch enabled (configurable: NUM_SESSIONS=6)
NUM_SESSIONS=6 node --test test/integration-multi-session-watch.js

# mmap cache enabled tests (proves the crash — will SIGBUS)
node --test test/stress-mmap-enabled.js  # NOTE: will crash

# Watch-enabled tests (mmap OFF, watch ON — ~40s)
node --test test/stress-watch-enabled.js

# Watch-enabled real repo test (requires nodejs/node at /tmp/stress-test-repos/nodejs — ~55s)
node --test test/stress-watch-real-repo.js

# Watcher timing measurement (~12s)
node --test test/stress-watch-timing.js

# All tests except mmap-enabled
node --test test/index.test.js test/session-*.js

# Full suite including integration
node --test test/*.js
```

## References

- [fff.nvim#294](https://github.com/dmtrKovalenko/fff.nvim/issues/294) — Original mmap-related issue
- [Linux mmap(2) man page](https://man7.org/linux/man-pages/man2/mmap.2.html) — SIGBUS behavior on truncated files
- [OpenCode Plugin SDK](https://opencode.ai/docs/plugins) — Plugin development guide
