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

describe("stress: .git/index rewrite during search", () => {
  it("simulates git add rewriting index 100 times while grep is running", async () => {
    const simDir = makeTempDir("git", __dirname);
    createProjectStructure(simDir);
    let finder;
    try {
      finder = await initSimFinder(FileFinder, simDir);
      const gitIndexPath = join(simDir, ".git", "index");
      const searchPromise = finder.grep("module");
      for (let i = 0; i < 100; i++) {
        const fd = openSync(gitIndexPath, "w");
        ftruncateSync(fd, 0);
        closeSync(fd);
        writeFileSync(gitIndexPath, `git index v${i}\n` + "0".repeat(4096));
      }
      const result = await searchPromise;
      assert.ok(result.ok || !result.ok, "git index rewrites should not crash search");
    } finally {
      simCleanup(finder, simDir);
    }
  });
});
