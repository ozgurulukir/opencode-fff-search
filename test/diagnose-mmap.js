import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { FileFinder } from "@ff-labs/fff-node";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const NODEJS_REPO = process.env.NODEJS_REPO || "/tmp/stress-test-repos/nodejs";

function collectFiles(repoDir, maxFiles = 500) {
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

describe("diagnose: mmap cache on real repo — isolate the crash", () => {
  let files;
  let repoDir;

  it("collect files", () => {
    repoDir = NODEJS_REPO;
    assert.ok(statSync(repoDir).isDirectory());
    files = collectFiles(repoDir, 500);
    console.log(`  [diagnose] ${files.length} files`);
  });

  it("init finder with mmap cache ON (no mutations)", async () => {
    const initResult = FileFinder.create({
      basePath: repoDir,
      aiMode: true,
      disableMmapCache: false,
      disableWatch: true,
    });
    assert.ok(initResult.ok, `init failed: ${initResult.error}`);
    const finder = initResult.value;
    console.log("  [diagnose] scan starting...");
    const scan = await finder.waitForScan(30000);
    console.log("  [diagnose] scan done:", scan.ok ? "ok" : "not ok");
    // Just one grep
    const result = finder.grep("function");
    console.log("  [diagnose] grep done:", result.ok ? "ok" : `error: ${result.error}`);
    finder.destroy();
    assert.ok(result.ok || !result.ok, "should not crash");
  });

  it("init finder with mmap cache ON, then truncate 50 files", async () => {
    const { openSync, closeSync, ftruncateSync } = await import("node:fs");
    const initResult = FileFinder.create({
      basePath: repoDir,
      aiMode: true,
      disableMmapCache: false,
      disableWatch: true,
    });
    assert.ok(initResult.ok, `init failed: ${initResult.error}`);
    const finder = initResult.value;
    await finder.waitForScan(30000);
    console.log("  [diagnose] scan done, truncating 50 files...");

    for (let i = 0; i < 50; i++) {
      const filePath = files[i];
      try {
        const fd = openSync(filePath, "w");
        ftruncateSync(fd, 0);
        closeSync(fd);
      } catch { /* ok */ }
    }

    console.log("  [diagnose] truncated, now searching...");
    const result = finder.grep("function");
    console.log("  [diagnose] grep done:", result.ok ? "ok" : `error: ${result.error}`);
    finder.destroy();
    assert.ok(result.ok || !result.ok, "should not crash");
  });

  it("init finder with mmap cache ON, truncate then grep in a loop", async () => {
    const { openSync, closeSync, ftruncateSync } = await import("node:fs");
    const initResult = FileFinder.create({
      basePath: repoDir,
      aiMode: true,
      disableMmapCache: false,
      disableWatch: true,
    });
    assert.ok(initResult.ok, `init failed: ${initResult.error}`);
    const finder = initResult.value;
    await finder.waitForScan(30000);
    console.log("  [diagnose] scan done, running truncate+grep loop...");

    for (let i = 0; i < 200; i++) {
      const filePath = files[i % files.length];
      try {
        const fd = openSync(filePath, "w");
        ftruncateSync(fd, 0);
        closeSync(fd);
      } catch { /* ok */ }

      if (i % 10 === 0) {
        console.log(`  [diagnose] cycle ${i}...`);
        const result = finder.grep("function");
        assert.ok(result.ok || !result.ok, `grep ${i} should not crash`);
      }
    }

    finder.destroy();
    console.log("  [diagnose] all 200 cycles done");
  });
});
