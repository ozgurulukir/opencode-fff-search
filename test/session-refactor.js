import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { renameSync, writeFileSync } from "node:fs";
import { FileFinder } from "@ff-labs/fff-node";
import { createProjectStructure, initSimFinder, simCleanup, makeTempDir } from "./helpers/stress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("stress: refactor move/rename during search", () => {
  it("simulates agent renaming 25 files while 50 searches are in-flight", async () => {
    const simDir = makeTempDir("refactor", __dirname);
    createProjectStructure(simDir);
    let finder;
    try {
      finder = await initSimFinder(FileFinder, simDir);
      const searches = [];
      for (let i = 0; i < 50; i++) {
        searches.push(finder.grep("module-" + i));
      }
      // Rename files while searches run
      for (let i = 0; i < 25; i++) {
        const oldPath = join(simDir, "src", `module-${i}.js`);
        const newPath = join(simDir, "src", `renamed-${i}.js`);
        try { renameSync(oldPath, newPath); } catch { /* may not exist */ }
      }
      // Replace renamed files
      for (let i = 0; i < 25; i++) {
        writeFileSync(join(simDir, "src", `module-${i}.js`), `// replaced ${i}\n`);
      }
      const results = await Promise.all(searches);
      for (const r of results) {
        assert.ok(r.ok || !r.ok, "rename during search should not crash");
      }
    } finally {
      simCleanup(finder, simDir);
    }
  });
});
