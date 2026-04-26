import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import {
  openSync,
  closeSync,
  ftruncateSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  appendFileSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";
const NODEJS_REPO = process.env.NODEJS_REPO || "/tmp/stress-test-repos/nodejs";

/**
 * Collect mutable source files from the repo (skip .git, node_modules, out, build dirs).
 * Returns flat array of absolute paths.
 */
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


/**
 * Verify the repo is still usable after mutations (files exist, git works).
 */
function verifyRepoIntegrity(repoDir) {
  try {
    execSync("git status --short", { cwd: repoDir, timeout: 5000, stdio: "pipe" });
  } catch (e) {
    if (e.status === null || e.signal) {
      throw new Error(`git crashed: signal=${e.signal}`);
    }
  }
}

describe("integration: real repo (nodejs/node) under heavy mutation", () => {
  let files;
  let repoDir;

  it("setup: collect mutable files from nodejs repo", () => {
    repoDir = NODEJS_REPO;
    assert.ok(
      statSync(repoDir).isDirectory(),
      `nodejs repo not found at ${repoDir}. Clone it first: git clone --depth=1 https://github.com/nodejs/node ${repoDir}`,
    );
    files = collectFiles(repoDir, 5000);
    assert.ok(files.length > 1000, `Expected >1000 files, got ${files.length}`);
    console.log(`  [real-repo] ${files.length} mutable files collected from ${repoDir}`);
  });

  it("should not SIGBUS when opencode processes a prompt while 1000 files are mutated", async () => {
    const prompt =
      "Search the codebase for all files that define 'MaybeLocal' or 'Environment'. " +
      "List the file paths and a brief description of what each file does. " +
      "Then find all test files matching '*test*' in the 'test/' directory.";

    // Spawn opencode pointed at the real repo
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

    // Mutation loop: 1000 aggressive mutations across real files
    const mutationCount = 1000;
    let completed = 0;
    let errors = 0;

    const interval = setInterval(() => {
      if (completed >= mutationCount) {
        clearInterval(interval);
        return;
      }

      const i = completed;
      const filePath = files[i % files.length];

      try {
        switch (i % 8) {
          case 0: {
            // Append (simulates agent edit at end of file)
            appendFileSync(filePath, `// stress test append ${i}\n`);
            break;
          }
          case 1: {
            // Truncate + rewrite (editor save pattern)
            const fd = openSync(filePath, "w");
            ftruncateSync(fd, 0);
            closeSync(fd);
            writeFileSync(filePath, `// stress test rewrite ${i}\n`);
            break;
          }
          case 2: {
            // Delete + recreate
            unlinkSync(filePath);
            writeFileSync(filePath, `// stress test recreate ${i}\n`);
            break;
          }
          case 3: {
            // Rename (simulates refactor)
            const newPath = filePath + `.stress-moved-${i}`;
            renameSync(filePath, newPath);
            break;
          }
          case 4: {
            // Truncate to 0 (classic SIGBUS trigger for mmap'd files)
            const fd = openSync(filePath, "w");
            ftruncateSync(fd, 0);
            closeSync(fd);
            break;
          }
          case 5: {
            // Partial overwrite (write to first 100 bytes of a larger file)
            const fd = openSync(filePath, "r+");
            const buf = Buffer.alloc(100, 0x00);
            buf.write(`// partial ${i}\n`);
            try { writeFileSync(fd, buf); } catch { /* some fd don't support write */ }
            closeSync(fd);
            break;
          }
          case 6: {
            // Create new file in same directory
            const dir = filePath.substring(0, filePath.lastIndexOf("/"));
            writeFileSync(join(dir, `.stress-${i}.js`), `// new file ${i}\n`);
            break;
          }
          case 7: {
            // Delete a previously created stress file
            const dir = filePath.substring(0, filePath.lastIndexOf("/"));
            try { rmSync(join(dir, `.stress-${Math.max(0, i - 7)}.js`)); } catch { /* ok */ }
            break;
          }
        }
      } catch (err) {
        // EPERM, EACCES, ENOENT are all expected with aggressive mutations
        errors++;
      }

      completed++;

      // Every 50 mutations, also mutate .git/index
      if (i % 50 === 0) {
        const gitIdx = join(repoDir, ".git", "index");
        try {
          const fd = openSync(gitIdx, "w");
          ftruncateSync(fd, 0);
          closeSync(fd);
          writeFileSync(gitIdx, `stress ${i}\n` + "0".repeat(4096));
        } catch { /* ok */ }
      }

      // Every 100 mutations, create/overwrite a large file (stress mmap regions)
      if (i % 100 === 0) {
        const largePath = join(repoDir, `.stress-large-${i}.bin`);
        writeFileSync(largePath, Buffer.alloc(1024 * 1024, 0x41 + (i % 26))); // 1MB files
      }
    }, 30); // Mutate every 30ms — very aggressive on a 48K-file repo

    const opencodeResult = await new Promise((resolve) => {
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        clearInterval(interval);
        resolve({ exitCode: code, signal, stdout, stderr });
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        clearInterval(interval);
        resolve({ exitCode: -1, signal: null, stdout, stderr: err.message });
      });
    });

    // Cleanup: restore mutated files from git, remove stress artifacts
    try {
      execSync("git checkout -- .", { cwd: repoDir, timeout: 30_000, stdio: "pipe" });
      execSync("git clean -fd", { cwd: repoDir, timeout: 30_000, stdio: "pipe" });
    } catch { /* best effort */ }

    // Verify repo integrity after restore
    verifyRepoIntegrity(repoDir);

    // Critical: no signal death
    assert.notEqual(
      opencodeResult.signal,
      "SIGBUS",
      `SIGBUS on real repo! ${completed} mutations, ${errors} errors. stderr: ${opencodeResult.stderr.slice(-500)}`,
    );
    assert.notEqual(
      opencodeResult.signal,
      "SIGSEGV",
      `SIGSEGV on real repo! ${completed} mutations, ${errors} errors. stderr: ${opencodeResult.stderr.slice(-500)}`,
    );

    console.log(`  [real-repo] ${completed} mutations (${errors} fs errors)`);
    if (opencodeResult.signal) {
      console.log(`  [real-repo] opencode killed by signal: ${opencodeResult.signal}`);
    } else if (opencodeResult.exitCode !== 0) {
      console.log(`  [real-repo] opencode exited with code: ${opencodeResult.exitCode}`);
    } else {
      console.log(`  [real-repo] opencode exited cleanly`);
    }
  });
});
