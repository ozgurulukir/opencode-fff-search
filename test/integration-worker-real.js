import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { readdirSync, statSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";
const NODEJS_REPO = process.env.NODEJS_REPO || "/tmp/stress-test-repos/nodejs";
const WORKER_PATH = join(__dirname, "mutation-worker-real.cjs");

function collectFiles(repoDir, maxFiles = 3000) {
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

describe("integration: worker-thread mutations on real repo (nodejs/node)", () => {
  let files;
  let repoDir;

  it("setup: collect mutable files from nodejs repo", () => {
    repoDir = NODEJS_REPO;
    assert.ok(
      statSync(repoDir).isDirectory(),
      `nodejs repo not found at ${repoDir}. Clone it first: git clone --depth=1 https://github.com/nodejs/node ${repoDir}`,
    );
    files = collectFiles(repoDir, 3000);
    assert.ok(files.length > 1000, `Expected >1000 files, got ${files.length}`);
    console.log(`  [real-repo-worker] ${files.length} files from ${repoDir}`);
  });

  it("should not SIGBUS when worker thread mutates 2000 files on real repo while opencode runs", async () => {
    const prompt =
      "Search for all C++ files that include 'Environment' or 'Isolate'. " +
      "For each match, show the file path and the line. " +
      "Then find all JavaScript files that export a class. " +
      "Finally, search for any TODO or FIXME in the 'src/' directory.";

    // Spawn opencode
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
    }, 120_000);

    // Worker thread does max-speed mutations
    const worker = new Worker(WORKER_PATH, {
      workerData: { files, repoDir, mutationCount: 2000 },
    });

    const workerResult = await new Promise((resolve, reject) => {
      worker.on("message", (msg) => {
        if (msg.type === "done") resolve(msg);
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (code !== 0) reject(new Error(`worker exited with code ${code}`));
      });
    });

    // Wait for opencode
    const opencodeResult = await new Promise((resolve) => {
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ exitCode: code, signal, stdout, stderr });
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, signal: null, stdout, stderr: err.message });
      });
    });

    // Cleanup
    worker.terminate();
    try {
      execSync("git checkout -- .", { cwd: repoDir, timeout: 60_000, stdio: "pipe" });
      execSync("git clean -fd", { cwd: repoDir, timeout: 60_000, stdio: "pipe" });
    } catch { /* best effort — shallow clone may have issues */ }

    // Critical assertions
    assert.notEqual(
      opencodeResult.signal,
      "SIGBUS",
      `SIGBUS! Worker did ${workerResult.completed} mutations (${workerResult.errors} errors). stderr: ${opencodeResult.stderr.slice(-500)}`,
    );
    assert.notEqual(
      opencodeResult.signal,
      "SIGSEGV",
      `SIGSEGV! Worker did ${workerResult.completed} mutations (${workerResult.errors} errors). stderr: ${opencodeResult.stderr.slice(-500)}`,
    );

    console.log(`  [real-repo-worker] ${workerResult.completed} mutations (${workerResult.errors} errors)`);
    if (opencodeResult.signal) {
      console.log(`  [real-repo-worker] opencode killed by signal: ${opencodeResult.signal}`);
    } else if (opencodeResult.exitCode !== 0) {
      console.log(`  [real-repo-worker] opencode exited with code: ${opencodeResult.exitCode}`);
    } else {
      console.log(`  [real-repo-worker] opencode exited cleanly`);
    }
  });
});
