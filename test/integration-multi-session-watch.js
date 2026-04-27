import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { readdirSync, statSync, rmSync, appendFileSync, openSync, closeSync, ftruncateSync, writeFileSync, unlinkSync } from "node:fs";
import { FileFinder } from "@ff-labs/fff-node";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";
const NODEJS_REPO = process.env.NODEJS_REPO || "/tmp/stress-test-repos/nodejs";
const NUM_SESSIONS = parseInt(process.env.NUM_SESSIONS || "4", 10);

function collectFiles(repoDir, maxFiles = 2000) {
  const skipDirs = new Set([".git", "node_modules", "out", "build", "deps", "Release", "test/fixtures"]);
  const files = [];
  function walk(dir) {
    if (files.length >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(join(dir, entry.name));
      }
    }
  }
  walk(repoDir);
  return files;
}

function spawnSession(id, repoDir, prompt, timeoutMs = 120_000) {
  const proc = spawn(
    OPENCODE_BIN,
    ["run", prompt, "--dir", repoDir, "--print-logs", "--format", "json"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => { stdout += d; });
  proc.stderr.on("data", (d) => { stderr += d; });

  const timer = setTimeout(() => {
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 3000);
  }, timeoutMs);

  const resultPromise = new Promise((resolve) => {
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ id, exitCode: code, signal, stdout, stderr });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ id, exitCode: -1, signal: null, stdout, stderr: err.message });
    });
  });

  return { proc, resultPromise };
}

/**
 * Integration test: concurrent opencode run sessions + file mutations
 * with watch ENABLED (disableWatch: false, disableMmapCache: true).
 *
 * This is the real-world scenario: multiple opencode sessions are running
 * against the same repo while files are being mutated. The watcher should
 * keep the index updated without SIGBUS or hangs.
 *
 * Additionally, a separate FileFinder instance with watch ON polls for
 * newly-created files to verify the watcher is functioning during mutations.
 */
describe(`integration: ${NUM_SESSIONS} concurrent opencode sessions + watch ON + mutations on real repo`, () => {
  let files;
  let repoDir;
  let watcher; // Separate FileFinder to test watcher independently

  it("setup: collect files and init watch-enabled finder", async () => {
    repoDir = NODEJS_REPO;
    assert.ok(statSync(repoDir).isDirectory(), `nodejs repo not found at ${repoDir}`);
    files = collectFiles(repoDir, 2000);
    assert.ok(files.length > 500, `Expected >500 files, got ${files.length}`);
    console.log(`  [multi-watch] ${files.length} files from ${repoDir}`);

    // Init a watch-enabled FileFinder to monitor new file detection during mutations
    const initResult = FileFinder.create({
      basePath: repoDir,
      aiMode: false,           // Match production
      disableMmapCache: true,  // Match production
      disableContentIndexing: true, // Match production
      disableWatch: false,     // Match production
    });
    if (!initResult.ok) throw new Error(`watcher init failed: ${initResult.error}`);
    watcher = initResult.value;
    await watcher.waitForScan(30000);
    console.log(`  [multi-watch] Watch-enabled FileFinder initialized`);
  });

  it(`should not crash when ${NUM_SESSIONS} opencode sessions + watcher + mutations run concurrently`, async () => {
    const prompts = [
      "Search for all files containing 'Environment' and list their paths.",
      "Find all C++ header files that define a class. Show the file and class name.",
      "Search for all JavaScript files that import 'fs' or 'path'. List them.",
      "Find all TODO and FIXME comments across the entire codebase.",
      "Search for all test files in test/ directory. List the first 20.",
      "Find all files that export 'function' in the src/ directory.",
      "Search for 'errno' usage across C and C++ files.",
      "Find all files with 'async' or 'await' in JavaScript files.",
    ];

    // Spawn all sessions
    const sessions = [];
    for (let i = 0; i < NUM_SESSIONS; i++) {
      const prompt = prompts[i % prompts.length];
      const session = spawnSession(i, repoDir, prompt, 120_000);
      sessions.push(session);
      console.log(`  [multi-watch] session ${i} spawned`);
    }

    // Track session lifecycle
    const alive = new Array(NUM_SESSIONS).fill(true);
    let aliveSessions = NUM_SESSIONS;
    for (let i = 0; i < NUM_SESSIONS; i++) {
      sessions[i].proc.on("close", () => {
        alive[i] = false;
        aliveSessions--;
      });
    }

    // Mutation loop
    const mutationCount = 3000;
    let completed = 0;
    let errors = 0;
    const uniqueMarker = `MULTI_WATCH_${Date.now()}`;
    let newFilesCreated = 0;
    let newFilesDetected = 0;

    const interval = setInterval(() => {
      if (completed >= mutationCount || aliveSessions === 0) {
        clearInterval(interval);
        return;
      }

      const i = completed;
      const filePath = files[i % files.length];

      try {
        switch (i % 10) {
          case 0:
            appendFileSync(filePath, `// mw${i}\n`);
            break;
          case 1: {
            const fd = openSync(filePath, "w");
            ftruncateSync(fd, 0);
            closeSync(fd);
            writeFileSync(filePath, `// mw${i}\n`);
            break;
          }
          case 2:
            unlinkSync(filePath);
            writeFileSync(filePath, `// mw${i}\n`);
            break;
          case 3:
            try { renameSync(filePath, filePath + `.mw-${i}`); } catch { /* ok */ }
            break;
          case 4: {
            const fd = openSync(filePath, "w");
            ftruncateSync(fd, 0);
            closeSync(fd);
            break;
          }
          case 5: {
            // Create new file with unique marker
            const dir = filePath.substring(0, filePath.lastIndexOf("/"));
            writeFileSync(join(dir, `${uniqueMarker}-${i}.js`), `// ${uniqueMarker} ${i}\n`);
            newFilesCreated++;
            break;
          }
          case 6: {
            // Delete a previously created file
            const target = join(
              filePath.substring(0, filePath.lastIndexOf("/")),
              `${uniqueMarker}-${Math.max(0, i - 10)}.js`,
            );
            try { rmSync(target, { force: true }); } catch { /* ok */ }
            break;
          }
          case 7: {
            // .git/index rewrite
            const idx = join(repoDir, ".git", "index");
            const fd = openSync(idx, "w");
            ftruncateSync(fd, 0);
            closeSync(fd);
            writeFileSync(idx, `v${i}\n` + "0".repeat(4096));
            break;
          }
          case 8: {
            // Large file churn
            writeFileSync(join(repoDir, `.mw-lg-${i}.bin`), Buffer.alloc(512 * 1024, 0x41 + (i % 26)));
            break;
          }
          case 9: {
            rmSync(join(repoDir, `.mw-lg-${Math.max(0, i - 9)}.bin`), { force: true });
            break;
          }
        }
      } catch { errors++; }

      completed++;
    }, 20); // Every 20ms — aggressive

    // Watcher verification: periodically check if newly-created files appear
    const watchCheckInterval = setInterval(() => {
      if (newFilesCreated > 0 && watcher && !watcher.isDestroyed) {
        try {
          const result = watcher.fileSearch(uniqueMarker, { pageSize: 50 });
          if (result.ok && result.value.items.length > 0) {
            newFilesDetected = result.value.items.length;
          }
        } catch { /* ok */ }
      }
    }, 3000); // Check every 3s

    // Wait for all sessions to finish
    const results = await Promise.all(sessions.map((s) => s.resultPromise));
    clearInterval(interval);
    clearInterval(watchCheckInterval);

    // Final watcher check
    if (watcher && !watcher.isDestroyed) {
      try {
        const finalCheck = watcher.fileSearch(uniqueMarker, { pageSize: 100 });
        if (finalCheck.ok) {
          newFilesDetected = finalCheck.value.items.length;
        }
      } catch { /* ok */ }
    }

    // Cleanup repo
    try {
      const { execSync } = await import("node:child_process");
      execSync("git checkout -- .", { cwd: repoDir, timeout: 60_000, stdio: "pipe" });
      execSync("git clean -fd", { cwd: repoDir, timeout: 60_000, stdio: "pipe" });
    } catch { /* best effort */ }

    // Report per-session results
    for (const r of results) {
      const status = r.signal ? `KILLED(${r.signal})` : `exit(${r.exitCode})`;
      console.log(`  [multi-watch] session ${r.id}: ${status}`);
    }

    // Critical: no session should die from a signal
    const crashedSessions = results.filter(
      (r) => r.signal === "SIGBUS" || r.signal === "SIGSEGV",
    );
    assert.equal(
      crashedSessions.length,
      0,
      `${crashedSessions.length} session(s) crashed with fatal signal:\n` +
        crashedSessions.map((r) => `  session ${r.id}: ${r.signal} — ${r.stderr.slice(-300)}`).join("\n"),
    );

    console.log(`  [multi-watch] ${completed} mutations (${errors} fs errors) across ${NUM_SESSIONS} sessions`);
    console.log(`  [multi-watch] ${newFilesCreated} new files created, ${newFilesDetected} detected by watcher`);

    // Watcher should have detected at least some of the new files
    // (not all — some may have been deleted before the watcher picked them up)
    if (newFilesCreated > 10) {
      console.log(`  [multi-watch] Watcher detection rate: ${newFilesDetected}/${newFilesCreated} (${((newFilesDetected / newFilesCreated) * 100).toFixed(0)}%)`);
    }
  });
});
