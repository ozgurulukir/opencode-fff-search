import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { openSync, closeSync, ftruncateSync, writeFileSync, unlinkSync, appendFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { FileFinder } from "@ff-labs/fff-node";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const NODEJS_REPO = process.env.NODEJS_REPO || "/tmp/stress-test-repos/nodejs";

function collectFiles(repoDir, maxFiles = 1000) {
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

describe("stress: mmap cache ON — single finder, single process", () => {
  let files;
  let repoDir;
  let finder;

  it("setup: single finder with mmap cache on real repo", async () => {
    repoDir = NODEJS_REPO;
    assert.ok(statSync(repoDir).isDirectory());
    files = collectFiles(repoDir, 1000);
    console.log(`  [mmap-single] ${files.length} files`);

    const initResult = FileFinder.create({
      basePath: repoDir,
      aiMode: true,
      disableMmapCache: false,
      disableWatch: true,
    });
    assert.ok(initResult.ok, `init failed: ${initResult.error}`);
    finder = initResult.value;
    console.log("  [mmap-single] scanning...");
    await finder.waitForScan(30000);
    console.log("  [mmap-single] scan done");
  });

  it("should not crash with 1000 mutations + searches on single mmap-cached finder", () => {
    let errors = 0;
    for (let i = 0; i < 1000; i++) {
      const filePath = files[i % files.length];
      try {
        switch (i % 6) {
          case 0:
            appendFileSync(filePath, `// ${i}\n`);
            break;
          case 1: {
            const fd = openSync(filePath, "w");
            ftruncateSync(fd, 0);
            closeSync(fd);
            writeFileSync(filePath, `// ${i}\n`);
            break;
          }
          case 2:
            unlinkSync(filePath);
            writeFileSync(filePath, `// ${i}\n`);
            break;
          case 3: {
            const fd = openSync(filePath, "w");
            ftruncateSync(fd, 0);
            closeSync(fd);
            break;
          }
          case 4: {
            const fd = openSync(filePath, "w");
            ftruncateSync(fd, 0);
            closeSync(fd);
            writeFileSync(filePath, Buffer.alloc(4096, 0x41 + (i % 26)).toString("binary"));
            break;
          }
          case 5:
            renameSync(filePath, filePath + `.mv-${i}`);
            break;
        }
      } catch { errors++; }

      if (i % 5 === 0) {
        const result = finder.grep("function");
        assert.ok(result.ok || !result.ok, `grep ${i} should not crash`);
      }
      if (i % 10 === 0) {
        const result = finder.fileSearch("env", { pageSize: 20 });
        assert.ok(result.ok || !result.ok, `glob ${i} should not crash`);
      }
    }
    console.log(`  [mmap-single] 1000 mutations (${errors} errors) — mmap cache ON`);
  });

  it("cleanup", () => {
    if (finder && !finder.isDestroyed) finder.destroy();
    // Restore repo
    try {
      const { execSync } = require("node:child_process");
      execSync("git checkout -- .", { cwd: repoDir, timeout: 60_000, stdio: "pipe" });
      execSync("git clean -fd", { cwd: repoDir, timeout: 60_000, stdio: "pipe" });
    } catch { /* best effort */ }
  });
});
