import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { readdirSync, statSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

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

/**
 * Spawn a single opencode run process. Returns { proc, resultPromise, kill() }.
 */
function spawnSession(id, repoDir, prompt, timeoutMs = 90_000) {
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

describe(`integration: ${NUM_SESSIONS} concurrent opencode run sessions + mutations on real repo`, () => {
  let files;
  let repoDir;

  it("setup: collect files from nodejs repo", () => {
    repoDir = NODEJS_REPO;
    assert.ok(
      statSync(repoDir).isDirectory(),
      `nodejs repo not found at ${repoDir}`,
    );
    files = collectFiles(repoDir, 2000);
    assert.ok(files.length > 500, `Expected >500 files, got ${files.length}`);
    console.log(`  [multi-session] ${files.length} files from ${repoDir}`);
  });

  it(`should not crash when ${NUM_SESSIONS} opencode sessions run concurrently with aggressive file mutations`, async () => {
    // Each session gets a different prompt to force different search patterns
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
      const session = spawnSession(i, repoDir, prompt, 90_000);
      sessions.push(session);
      console.log(`  [multi-session] session ${i} spawned`);
    }

    // Concurrent mutation loop — runs while ALL sessions are alive
    const mutationCount = 3000;
    let completed = 0;
    let errors = 0;
    let aliveSessions = NUM_SESSIONS;

    // Track which sessions are still alive
    const alive = new Array(NUM_SESSIONS).fill(true);
    for (let i = 0; i < NUM_SESSIONS; i++) {
      sessions[i].proc.on("close", () => {
        alive[i] = false;
        aliveSessions--;
      });
    }

    // Run mutations on a tight interval while sessions are running
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
            appendFileSync(filePath, `// ms${i}\n`);
            break;
          case 1: {
            const fd = openSync(filePath, "w");
            ftruncateSync(fd, 0);
            closeSync(fd);
            writeFileSync(filePath, `// ms${i}\n`);
            break;
          }
          case 2:
            unlinkSync(filePath);
            writeFileSync(filePath, `// ms${i}\n`);
            break;
          case 3:
            renameSync(filePath, filePath + `.ms-${i}`);
            break;
          case 4: {
            const fd = openSync(filePath, "w");
            ftruncateSync(fd, 0);
            closeSync(fd);
            break;
          }
          case 5: {
            // Create new file
            const dir = filePath.substring(0, filePath.lastIndexOf("/"));
            writeFileSync(join(dir, `.ms-${i}.js`), `// ${i}\n`);
            break;
          }
          case 6:
            rmSync(join(filePath.substring(0, filePath.lastIndexOf("/")), `.ms-${Math.max(0, i - 6)}.js`), { force: true });
            break;
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
            writeFileSync(join(repoDir, `.ms-lg-${i}.bin`), Buffer.alloc(512 * 1024, 0x41 + (i % 26)));
            break;
          }
          case 9: {
            // Remove a large file
            rmSync(join(repoDir, `.ms-lg-${Math.max(0, i - 9)}.bin`), { force: true });
            break;
          }
        }
      } catch { errors++; }

      completed++;
    }, 20); // Every 20ms — very aggressive

    // Wait for all sessions to finish
    const results = await Promise.all(sessions.map((s) => s.resultPromise));
    clearInterval(interval);

    // Cleanup
    try {
      execSync("git checkout -- .", { cwd: repoDir, timeout: 60_000, stdio: "pipe" });
      execSync("git clean -fd", { cwd: repoDir, timeout: 60_000, stdio: "pipe" });
    } catch { /* best effort */ }

    // Report per-session results
    for (const r of results) {
      const status = r.signal ? `KILLED(${r.signal})` : `exit(${r.exitCode})`;
      console.log(`  [multi-session] session ${r.id}: ${status}`);
    }

    // Critical: no session should die from a signal
    const crashedSessions = results.filter((r) => r.signal === "SIGBUS" || r.signal === "SIGSEGV");
    assert.equal(
      crashedSessions.length,
      0,
      `${crashedSessions.length} session(s) crashed with fatal signal:\n` +
        crashedSessions.map((r) => `  session ${r.id}: ${r.signal} — ${r.stderr.slice(-300)}`).join("\n"),
    );

    console.log(`  [multi-session] ${completed} mutations (${errors} fs errors) across ${NUM_SESSIONS} sessions`);
  });
});
