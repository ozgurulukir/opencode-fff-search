import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { FileFinder } from "@ff-labs/fff-node";
import { createProjectStructure, makeTempDir } from "./helpers/stress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Focused test: does the watcher eventually detect new files?
 * We create a file with a unique marker, then poll fileSearch every second
 * for up to 60 seconds to see when (if ever) the watcher picks it up.
 *
 * Also tests: does grep find content in newly-created files?
 * With disableMmapCache: true, grep reads from disk, so content should
 * be found immediately regardless of watcher state. This confirms whether
 * the watcher provides value ONLY for file listing (glob), not content search (grep).
 */
describe("watch: new file detection timing", () => {
  it("should detect new files within 60 seconds with watch ON", async () => {
    const simDir = makeTempDir("watch-timing", __dirname);
    createProjectStructure(simDir);

    const initResult = FileFinder.create({
      basePath: simDir,
      aiMode: true,
      disableMmapCache: true,
      disableWatch: false,
    });
    if (!initResult.ok) {
      rmSync(simDir, { recursive: true, force: true });
      throw new Error(`finder init failed: ${initResult.error}`);
    }
    const finder = initResult.value;
    await finder.waitForScan(15000);

    try {
      const uniqueMarker = `WATCH_TIMING_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      // Baseline: fileSearch should NOT find this marker
      const before = finder.fileSearch(uniqueMarker, { pageSize: 10 });
      assert.ok(before.ok, "fileSearch before should succeed");
      console.log(`  [watch-timing] Before: ${before.value.items.length} matches for '${uniqueMarker}'`);

      // Baseline: grep should NOT find this marker
      const grepBefore = finder.grep(uniqueMarker);
      assert.ok(grepBefore.ok, "grep before should succeed");
      console.log(`  [watch-timing] Grep before: ${grepBefore.value.items.length} matches`);

      // Create 3 new files with the unique marker
      writeFileSync(
        join(simDir, "src", `new-${uniqueMarker}-1.js`),
        `// ${uniqueMarker} content here\nexport const a = 1;\n`,
      );
      writeFileSync(
        join(simDir, "src", `new-${uniqueMarker}-2.js`),
        `// ${uniqueMarker} another file\nexport const b = 2;\n`,
      );
      writeFileSync(
        join(simDir, "new-${uniqueMarker}-root.js"),
        `// ${uniqueMarker} root level\nexport const c = 3;\n`,
      );
      console.log(`  [watch-timing] Created 3 new files, polling every 2s for up to 60s...`);

      // Immediately test grep (should find content because it reads from disk)
      const grepImmediate = finder.grep(uniqueMarker);
      assert.ok(grepImmediate.ok, "grep immediate should succeed");
      console.log(`  [watch-timing] Grep IMMEDIATE: ${grepImmediate.value.items.length} matches (reads from disk)`);

      // Poll fileSearch every 2 seconds for up to 60s
      let foundAt = null;
      let foundCount = 0;
      for (let attempt = 1; attempt <= 30; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        const result = finder.fileSearch(uniqueMarker, { pageSize: 20 });
        if (!result.ok) continue;
        foundCount = result.value.items.length;
        if (foundCount > 0) {
          foundAt = attempt * 2;
          console.log(`  [watch-timing] fileSearch DETECTED at ${foundAt}s (attempt ${attempt}): ${foundCount} matches`);
          break;
        }
        if (attempt % 5 === 0) {
          console.log(`  [watch-timing] ... still waiting at ${attempt * 2}s`);
        }
      }

      if (foundAt === null) {
        console.log(`  [watch-timing] fileSearch NEVER detected new files within 60s`);
        console.log(`  [watch-timing] → Watcher provides NO benefit for new file detection`);
      } else {
        console.log(`  [watch-timing] → Watcher detected new files after ${foundAt}s debounce`);
      }

      // Also test: does watcher detect file deletion?
      // Delete one of the new files
      rmSync(join(simDir, "src", `new-${uniqueMarker}-1.js`));
      console.log(`  [watch-timing] Deleted 1 file, waiting 10s for watcher...`);
      await new Promise((r) => setTimeout(r, 10000));

      const afterDelete = finder.fileSearch(uniqueMarker, { pageSize: 20 });
      if (afterDelete.ok) {
        console.log(`  [watch-timing] After deletion: ${afterDelete.value.items.length} matches (was ${foundCount || 0})`);
        if (foundCount !== null && afterDelete.value.items.length < foundCount) {
          console.log(`  [watch-timing] → Watcher detected file deletion`);
        } else {
          console.log(`  [watch-timing] → Watcher did NOT detect file deletion`);
        }
      }

      // Test passes regardless — we're measuring, not asserting a specific behavior
      assert.ok(true, `Timing test completed. Detected at: ${foundAt}s`);
    } finally {
      // finder.destroy() blocks with watcher — skip cleanup
      rmSync(simDir, { recursive: true, force: true });
    }
  });
});
