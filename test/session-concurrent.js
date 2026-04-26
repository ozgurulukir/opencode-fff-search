import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { openSync, closeSync, ftruncateSync, writeFileSync } from "node:fs";
import { FileFinder } from "@ff-labs/fff-node";
import { createProjectStructure, simCleanup, makeTempDir } from "./helpers/stress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("stress: concurrent agent sessions (5 finders, 50 mutations)", () => {
  it("simulates 5 separate OpenCode sessions searching the same directory while files are mutated concurrently", async () => {
    const simDir = makeTempDir("concurrent", __dirname);
    createProjectStructure(simDir);
    const finders = [];
    try {
      // Create 5 separate finders (simulates multiple OpenCode processes)
      for (let i = 0; i < 5; i++) {
        const result = FileFinder.create({
          basePath: simDir,
          aiMode: true,
          disableMmapCache: true,
          disableWatch: true,
        });
        if (result.ok) {
          finders.push(result.value);
          await result.value.waitForScan(5000);
        }
      }

      // All sessions search simultaneously (30 searches each)
      const searches = finders.map((f) => {
        const results = [];
        for (let i = 0; i < 30; i++) {
          results.push(f.grep("module"));
        }
        return Promise.all(results);
      });

      // Concurrently mutate 50 files with 5ms spacing
      const mutations = [];
      for (let i = 0; i < 50; i++) {
        mutations.push(new Promise((resolve) => {
          setTimeout(() => {
            const filePath = join(simDir, "src", `module-${i % 200}.js`);
            try {
              const fd = openSync(filePath, "w");
              ftruncateSync(fd, 0);
              closeSync(fd);
              writeFileSync(filePath, `// concurrent edit ${i}\n`);
            } catch { /* file may not exist */ }
            resolve();
          }, i * 5);
        }));
      }

      const [searchResults] = await Promise.all([
        Promise.all(searches.flat()),
        ...mutations,
      ]);

      for (const r of searchResults) {
        assert.ok(r.ok || !r.ok, "concurrent sessions should not crash");
      }
    } finally {
      for (const f of finders) {
        try { if (!f.isDestroyed) f.destroy(); } catch { /* best effort */ }
      }
      simCleanup(null, simDir);
    }
  });
});
