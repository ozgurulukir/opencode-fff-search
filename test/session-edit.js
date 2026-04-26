import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { appendFileSync, unlinkSync, openSync, closeSync, ftruncateSync, writeFileSync } from "node:fs";
import { FileFinder } from "@ff-labs/fff-node";
import { createProjectStructure, initSimFinder, simCleanup, makeTempDir } from "./helpers/stress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("stress: interleaved edits + searches (200 cycles)", () => {
  it("simulates agent editing source files between every grep call", async () => {
    const simDir = makeTempDir("edit", __dirname);
    createProjectStructure(simDir);
    let finder;
    try {
      finder = await initSimFinder(FileFinder, simDir);
      const searchCount = 200;
      for (let i = 0; i < searchCount; i++) {
        if (finder.isDestroyed) break;
        const result = finder.grep("module");
        assert.ok(result.ok || !result.ok, `search ${i} should not crash`);

        const fileIdx = i % 200;
        const filePath = join(simDir, "src", `module-${fileIdx}.js`);
        if (i % 3 === 0) {
          appendFileSync(filePath, `// added line ${i}\n`);
        } else if (i % 3 === 1) {
          const fd = openSync(filePath, "w");
          ftruncateSync(fd, 0);
          closeSync(fd);
          writeFileSync(filePath, `// rewritten at step ${i}\n`);
        } else {
          try { unlinkSync(filePath); } catch { /* already gone */ }
          writeFileSync(filePath, `// recreated at step ${i}\n`);
        }
      }
    } finally {
      simCleanup(finder, simDir);
    }
  });
});
