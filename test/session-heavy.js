import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { openSync, closeSync, ftruncateSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { FileFinder } from "@ff-labs/fff-node";
import { createProjectStructure, initSimFinder, simCleanup, makeTempDir } from "./helpers/stress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("stress: heavy interleaved agent session (500 cycles)", () => {
  it("simulates 500 cycles of grep, glob, file edits, creates, deletes, renames, and session DB writes", async () => {
    const simDir = makeTempDir("heavy", __dirname);
    createProjectStructure(simDir);
    let finder;
    try {
      finder = await initSimFinder(FileFinder, simDir);
      for (let cycle = 0; cycle < 500; cycle++) {
        if (finder.isDestroyed) break;

        // grep (agent reads code)
        const grepResult = finder.grep("export const");
        assert.ok(grepResult.ok || !grepResult.ok, `cycle ${cycle} grep`);

        // glob (agent finds files)
        const globResult = finder.fileSearch("module", { pageSize: 10 });
        assert.ok(globResult.ok || !globResult.ok, `cycle ${cycle} glob`);

        // File mutation (agent writes code) — every 5 cycles
        if (cycle % 5 === 0) {
          const filePath = join(simDir, "src", `module-${cycle % 200}.js`);
          const fd = openSync(filePath, "w");
          ftruncateSync(fd, 0);
          closeSync(fd);
          writeFileSync(filePath, `// modified at cycle ${cycle}\n`.repeat(5));
        }

        // Create new file (agent creates new module) — every 10 cycles
        if (cycle % 10 === 0) {
          writeFileSync(
            join(simDir, "src", `new-module-${cycle}.js`),
            `// new module ${cycle}\n`,
          );
        }

        // Delete file (agent removes old module) — every 15 cycles
        if (cycle % 15 === 0) {
          try { unlinkSync(join(simDir, "src", `module-${cycle % 200}.js`)); } catch { /* ok */ }
        }

        // Rename file (agent refactors) — every 20 cycles
        if (cycle % 20 === 0) {
          try {
            renameSync(
              join(simDir, "src", `module-${cycle % 200}.js`),
              join(simDir, "src", `refactored-${cycle}.js`),
            );
          } catch { /* may not exist */ }
        }

        // Session DB write (OpenCode updates session) — every 7 cycles
        if (cycle % 7 === 0) {
          const dbPath = join(simDir, ".opencode", "session.db");
          const fd = openSync(dbPath, "w");
          ftruncateSync(fd, 0);
          closeSync(fd);
          writeFileSync(dbPath, "\x00".repeat(1024 + cycle * 50));
        }
      }
    } finally {
      simCleanup(finder, simDir);
    }
  });
});
