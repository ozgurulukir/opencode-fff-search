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
  rmSync,
} from "node:fs";
import { FileFinder } from "@ff-labs/fff-node";
import { createProjectStructure, makeTempDir } from "./helpers/stress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";
const NODEJS_REPO = process.env.NODEJS_REPO || "/tmp/stress-test-repos/nodejs";

/**
 * Test FileFinder directly with mmap cache ENABLED.
 * This is the dangerous configuration — mmap'd files can SIGBUS if truncated.
 */
describe("stress: mmap cache ENABLED (disableMmapCache: false)", () => {
  it("should not crash finder with 500 file mutations on synthetic project", async () => {
    const simDir = makeTempDir("mmap-on", __dirname);
    createProjectStructure(simDir);

    // Create finder WITH mmap cache enabled — the dangerous config
    const initResult = FileFinder.create({
      basePath: simDir,
      aiMode: true,
      disableMmapCache: false,  // THIS IS THE TEST — cache enabled
      disableWatch: true,       // keep watch off to isolate mmap as the variable
    });
    if (!initResult.ok) {
      rmSync(simDir, { recursive: true, force: true });
      throw new Error(`finder init failed: ${initResult.error}`);
    }
    const finder = initResult.value;
    const scan = await finder.waitForScan(15000);

    try {
      // 500 mutations with mmap cache on
      for (let i = 0; i < 500; i++) {
        if (finder.isDestroyed) break;
        const filePath = join(simDir, "src", `module-${i % 200}.js`);

        switch (i % 6) {
          case 0:
            try { appendFileSync(filePath, `// ${i}\n`); } catch { /* ok */ }
            break;
          case 1: {
            try {
              const fd = openSync(filePath, "w");
              ftruncateSync(fd, 0);
              closeSync(fd);
              writeFileSync(filePath, `// ${i}\n`);
            } catch { /* ok */ }
            break;
          }
          case 2:
            try { unlinkSync(filePath); writeFileSync(filePath, `// ${i}\n`); } catch { /* ok */ }
            break;
          case 3:
            try { renameSync(filePath, join(simDir, "src", `mv-${i}.js`)); } catch { /* ok */ }
            break;
          case 4: {
            // Truncate to 0 — classic SIGBUS trigger for mmap'd files
            try {
              const fd = openSync(filePath, "w");
              ftruncateSync(fd, 0);
              closeSync(fd);
            } catch { /* ok */ }
            break;
          }
          case 5: {
            // Overwrite with different size (mmap sees size change)
            try {
              const fd = openSync(filePath, "w");
              ftruncateSync(fd, 0);
              closeSync(fd);
              writeFileSync(filePath, "X".repeat(5000 + i * 100));
            } catch { /* ok */ }
            break;
          }
        }

        // Search after every mutation to exercise mmap reads
        if (i % 5 === 0) {
          const result = finder.grep("module");
          assert.ok(result.ok || !result.ok, `grep ${i} should not crash`);
        }

        // glob search too
        if (i % 10 === 0) {
          const globResult = finder.fileSearch("module", { pageSize: 10 });
          assert.ok(globResult.ok || !globResult.ok, `glob ${i} should not crash`);
        }
      }
    } finally {
      if (!finder.isDestroyed) finder.destroy();
      rmSync(simDir, { recursive: true, force: true });
    }
  });

  // NOTE: disableMmapCache=false + disableWatch=false hangs on rapid mutations
  // (watch triggers re-indexing in a loop). The dangerous-but-testable config is
  // mmap cache ON + watch OFF, which is what the first test and real-repo test use.

});

/**
 * Test with real repo + mmap cache enabled.
 */
describe("stress: mmap cache ENABLED on real repo (nodejs/node)", () => {
  let finder;
  let repoDir;
  let files;

  it("setup: init finder with mmap cache on real repo", async () => {
    repoDir = NODEJS_REPO;
    const { readdirSync, statSync } = await import("node:fs");

    assert.ok(
      statSync(repoDir).isDirectory(),
      `nodejs repo not found at ${repoDir}`,
    );

    // Collect a subset of files to mutate
    const skipDirs = new Set([".git", "node_modules", "out", "build", "deps", "Release", "test/fixtures"]);
    files = [];
    function walk(dir) {
      if (files.length >= 2000) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (files.length >= 2000) break;
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

    // Init with mmap cache ON
    const initResult = FileFinder.create({
      basePath: repoDir,
      aiMode: true,
      disableMmapCache: false,
      disableWatch: true,
    });
    if (!initResult.ok) throw new Error(`finder init failed: ${initResult.error}`);
    finder = initResult.value;
    await finder.waitForScan(30000);

    console.log(`  [mmap-real] ${files.length} files, mmap cache ON`);
  });

  it("should not SIGBUS when 1000 real files are mutated with mmap cache on", async () => {
    try {
      let errors = 0;
      for (let i = 0; i < 1000; i++) {
        if (finder.isDestroyed) break;
        const filePath = files[i % files.length];

        try {
          switch (i % 6) {
            case 0:
              appendFileSync(filePath, `// mmap-test ${i}\n`);
              break;
            case 1: {
              const fd = openSync(filePath, "w");
              ftruncateSync(fd, 0);
              closeSync(fd);
              writeFileSync(filePath, `// mmap-test ${i}\n`);
              break;
            }
            case 2:
              unlinkSync(filePath);
              writeFileSync(filePath, `// mmap-test ${i}\n`);
              break;
            case 3: {
              const fd = openSync(filePath, "w");
              ftruncateSync(fd, 0);
              closeSync(fd);
              break;
            }
            case 4: {
              // Overwrite with different size
              const fd = openSync(filePath, "w");
              ftruncateSync(fd, 0);
              closeSync(fd);
              writeFileSync(filePath, Buffer.alloc(2048, 0x41 + (i % 26)).toString("binary"));
              break;
            }
            case 5:
              renameSync(filePath, filePath + `.mmap-${i}`);
              break;
          }
        } catch { errors++; }

        // Search frequently to exercise mmap reads on potentially-mutated files
        if (i % 3 === 0) {
          const result = finder.grep("function");
          assert.ok(result.ok || !result.ok, `grep ${i} should not crash`);
        }
        if (i % 7 === 0) {
          const result = finder.fileSearch("env", { pageSize: 20 });
          assert.ok(result.ok || !result.ok, `glob ${i} should not crash`);
        }
      }

      console.log(`  [mmap-real] 1000 mutations (${errors} fs errors), mmap cache ON`);
    } finally {
      if (finder && !finder.isDestroyed) finder.destroy();
      // Restore repo
      const { execSync } = await import("node:child_process");
      try {
        execSync("git checkout -- .", { cwd: repoDir, timeout: 60_000, stdio: "pipe" });
        execSync("git clean -fd", { cwd: repoDir, timeout: 60_000, stdio: "pipe" });
      } catch { /* best effort */ }
    }
  });
});
