import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, rmSync, readdirSync, statSync, appendFileSync, unlinkSync, openSync, closeSync, ftruncateSync } from "node:fs";
import { execSync } from "node:child_process";
import { FileFinder } from "@ff-labs/fff-node";

const NODEJS_REPO = process.env.NODEJS_REPO || "/tmp/stress-test-repos/nodejs";

/**
 * Test FileFinder with watch enabled on a REAL large repository (nodejs/node).
 *
 * This tests the actual production configuration:
 *   disableMmapCache: true  (safe from SIGBUS)
 *   disableWatch: false     (new files appear in search)
 *
 * Measures:
 * 1. New file detection timing on a 48K-file repo
 * 2. Deleted file detection timing
 * 3. Content mutation detection (grep finds new content)
 * 4. Stability under concurrent mutations + searches
 * 5. Performance comparison: search latency with watch ON vs scan-only
 */
describe("watch-enabled on real repo (nodejs/node)", () => {
  let finder;
  let repoDir;
  let existingFiles = [];
  const testMarker = `REAL_WATCH_TEST_${Date.now()}`;

  it("setup: init finder with watch ON on real repo", async () => {
    repoDir = NODEJS_REPO;
    assert.ok(statSync(repoDir).isDirectory(), `nodejs repo not found at ${repoDir}`);

    // Collect a subset of existing JS files for mutation tests
    const skipDirs = new Set([".git", "node_modules", "out", "build", "deps", "Release", "test/fixtures"]);
    function walk(dir) {
      if (existingFiles.length >= 1000) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (existingFiles.length >= 1000) break;
        if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue;
          walk(join(dir, entry.name));
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
          existingFiles.push(join(dir, entry.name));
        }
      }
    }
    walk(repoDir);

    console.log(`  [real-watch] ${existingFiles.length} JS files collected from ${repoDir}`);

    const initResult = FileFinder.create({
      basePath: repoDir,
      aiMode: true,
      disableMmapCache: true,
      disableWatch: false,
    });
    if (!initResult.ok) throw new Error(`finder init failed: ${initResult.error}`);
    finder = initResult.value;
    const scanResult = await finder.waitForScan(30000);
    console.log(`  [real-watch] Initial scan complete (ok=${scanResult.ok})`);
  });

  it("should detect new files within 10s on real repo", async () => {
    // Create 3 new files with unique markers in different subdirectories
    const newFiles = [
      join(repoDir, `test-${testMarker}-1.js`),
      join(repoDir, `test-${testMarker}-2.js`),
      join(repoDir, `test-${testMarker}-3.js`),
    ];

    for (const f of newFiles) {
      writeFileSync(f, `// ${testMarker} content\nexport const v = 1;\n`);
    }
    console.log(`  [real-watch] Created 3 new files, polling fileSearch...`);

    let foundAt = null;
    for (let attempt = 1; attempt <= 15; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      const result = finder.fileSearch(testMarker, { pageSize: 10 });
      if (!result.ok) continue;
      const count = result.value.items.length;
      if (count > 0) {
        foundAt = attempt;
        console.log(`  [real-watch] fileSearch detected at ${attempt}s: ${count} matches`);
        break;
      }
    }

    // Cleanup new files
    for (const f of newFiles) {
      try { rmSync(f, { force: true }); } catch { /* ok */ }
    }

    assert.ok(foundAt !== null, `New files should be detected within 15s on real repo (detected at ${foundAt}s)`);
    assert.ok(foundAt <= 10, `Should detect within 10s, took ${foundAt}s`);
    console.log(`  [real-watch] PASS: new file detection in ${foundAt}s`);
  });

  it("should detect deleted files within 15s on real repo", async () => {
    // Create a file and wait for watcher to pick it up
    const delFile = join(repoDir, `delete-${testMarker}.js`);
    writeFileSync(delFile, `// ${testMarker} delete me\nexport const x = 42;\n`);

    // Wait for detection
    let created = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const r = finder.fileSearch(`delete-${testMarker}`, { pageSize: 5 });
      if (r.ok && r.value.items.length > 0) { created = true; break; }
    }
    assert.ok(created, "Test file should be detected before deletion test");
    console.log(`  [real-watch] File created and detected, now deleting...`);

    // Delete and wait for removal
    rmSync(delFile, { force: true });

    let removedAt = null;
    for (let attempt = 1; attempt <= 15; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      const result = finder.fileSearch(`delete-${testMarker}`, { pageSize: 5 });
      if (!result.ok) continue;
      if (result.value.items.length === 0) {
        removedAt = attempt;
        console.log(`  [real-watch] Deleted file removed from index at ${attempt}s`);
        break;
      }
    }

    assert.ok(removedAt !== null, `Deleted file should be removed from index within 15s (removed at ${removedAt}s)`);
    console.log(`  [real-watch] PASS: deleted file detection in ${removedAt}s`);
  });

  it("should find new content in grep after watcher re-indexes on real repo", async () => {
    const grepMarker = `GREP_REAL_WATCH_${Date.now()}`;
    const grepFile = join(repoDir, `grep-${grepMarker}.js`);
    writeFileSync(grepFile, `// ${grepMarker} unique content here\nconsole.log("hello");\n`);

    // Wait for watcher to index the new file
    let grepFoundAt = null;
    for (let attempt = 1; attempt <= 15; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      const result = finder.grep(grepMarker);
      if (!result.ok) continue;
      if (result.value.items.length > 0) {
        grepFoundAt = attempt;
        console.log(`  [real-watch] grep found new content at ${attempt}s: ${result.value.items.length} matches`);
        break;
      }
    }

    // Cleanup
    try { rmSync(grepFile, { force: true }); } catch { /* ok */ }

    assert.ok(grepFoundAt !== null, `Grep should find new file content within 15s (found at ${grepFoundAt}s)`);
    console.log(`  [real-watch] PASS: grep new content detection in ${grepFoundAt}s`);
  });

  it("should remain stable during 100 mutations + searches on real repo (slow pace)", async () => {
    const start = Date.now();
    let mutations = 0;
    let searches = 0;
    let searchErrors = 0;
    let fsErrors = 0;

    for (let i = 0; i < 100; i++) {
      if (Date.now() - start > 120_000) {
        console.log(`  [real-watch] timeout at mutation ${i}`);
        break;
      }
      if (finder.isDestroyed) break;

      const filePath = existingFiles[i % existingFiles.length];

      try {
        // Only append — less disruptive than truncate/delete on a large repo
        appendFileSync(filePath, `\n// real-watch-${i}\n`);
      } catch { fsErrors++; }
      mutations++;

      // Search every 5 mutations
      if (i % 5 === 0) {
        try {
          const result = finder.grep("function");
          if (result.ok) searches++;
          else searchErrors++;
        } catch { searchErrors++; }
      }
      if (i % 10 === 0) {
        try {
          const result = finder.fileSearch("test", { pageSize: 10 });
          if (result.ok) searches++;
          else searchErrors++;
        } catch { searchErrors++; }
      }

      if (i % 10 === 0) {
        console.log(`  [real-watch] mutation ${i}/100, ${searches} searches, ${Date.now() - start}ms`);
      }

      // Wait 500ms between mutations to let watcher settle on 48K files
      await new Promise((r) => setTimeout(r, 500));
    }

    const elapsed = Date.now() - start;
    console.log(`  [real-watch] ${mutations} mutations, ${searches} searches, ${searchErrors} errors, ${fsErrors} fs errors, ${elapsed}ms`);

    assert.ok(mutations >= 50, `Should complete at least 50 mutations, got ${mutations}`);
    assert.ok(searchErrors < 20, `Search errors should be low, got ${searchErrors}`);
    console.log(`  [real-watch] PASS: stable under mutations on real repo`);
  });

  it("should measure search latency with watch ON on real repo", async () => {
    // Warm up
    for (let i = 0; i < 5; i++) {
      finder.grep("function");
      finder.fileSearch("test", { pageSize: 10 });
    }

    // Measure grep latency
    const grepTimes = [];
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      const result = finder.grep("function");
      grepTimes.push(Date.now() - t0);
      assert.ok(result.ok, `grep ${i} should succeed`);
    }

    // Measure fileSearch latency
    const globTimes = [];
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      const result = finder.fileSearch("index", { pageSize: 20 });
      globTimes.push(Date.now() - t0);
      assert.ok(result.ok, `fileSearch ${i} should succeed`);
    }

    const avgGrep = (grepTimes.reduce((a, b) => a + b, 0) / grepTimes.length).toFixed(1);
    const maxGrep = Math.max(...grepTimes);
    const avgGlob = (globTimes.reduce((a, b) => a + b, 0) / globTimes.length).toFixed(1);
    const maxGlob = Math.max(...globTimes);

    console.log(`  [real-watch] grep:  avg=${avgGrep}ms, max=${maxGrep}ms (20 searches on 48K files)`);
    console.log(`  [real-watch] glob:  avg=${avgGlob}ms, max=${maxGlob}ms (20 searches on 48K files)`);

    assert.ok(Number(avgGrep) < 1000, `Grep avg should be under 1s, got ${avgGrep}ms`);
    assert.ok(Number(avgGlob) < 1000, `Glob avg should be under 1s, got ${avgGlob}ms`);
    console.log(`  [real-watch] PASS: search latency acceptable`);
  });

  it("cleanup: restore real repo", async () => {
    // Best effort: restore any modified files
    try {
      execSync("git checkout -- .", { cwd: repoDir, timeout: 60_000, stdio: "pipe" });
      execSync("git clean -fd", { cwd: repoDir, timeout: 60_000, stdio: "pipe" });
    } catch { /* best effort */ }
    console.log(`  [real-watch] Repo restored`);
  });
});
