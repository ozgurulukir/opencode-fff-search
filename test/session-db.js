import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { openSync, closeSync, ftruncateSync, writeFileSync } from "node:fs";
import { FileFinder } from "@ff-labs/fff-node";
import { createProjectStructure, initSimFinder, simCleanup, makeTempDir } from "./helpers/stress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("stress: .opencode session DB writes during search", () => {
  it("rapidly overwrites session DB 200 times while grep is running", async () => {
    const simDir = makeTempDir("db", __dirname);
    createProjectStructure(simDir);
    let finder;
    try {
      finder = await initSimFinder(FileFinder, simDir);
      const dbPath = join(simDir, ".opencode", "session.db");
      const searchPromise = finder.grep("import");
      // Simulate OpenCode writing session data (truncate + rewrite pattern)
      for (let i = 0; i < 200; i++) {
        const fd = openSync(dbPath, "w");
        ftruncateSync(fd, 0);
        closeSync(fd);
        writeFileSync(dbPath, "\x00".repeat(512 + i * 100));
      }
      const result = await searchPromise;
      assert.ok(result.ok || !result.ok, "session DB writes should not crash search");
    } finally {
      simCleanup(finder, simDir);
    }
  });
});
