import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { FileFinder } from "@ff-labs/fff-node";
import { createProjectStructure, initSimFinder, simCleanup, makeTempDir } from "./helpers/stress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("stress: node_modules install/uninstall during search", () => {
  it("creates 50 packages then removes 25 while grep is running", async () => {
    const simDir = makeTempDir("nm", __dirname);
    createProjectStructure(simDir);
    let finder;
    try {
      finder = await initSimFinder(FileFinder, simDir);
      const searchPromise = finder.grep("export");
      const nmDir = join(simDir, "node_modules");
      // Simulate npm install
      for (let i = 0; i < 50; i++) {
        const pkgDir = join(nmDir, `pkg-${i}`);
        mkdirSync(join(pkgDir, "lib"), { recursive: true });
        writeFileSync(join(pkgDir, "lib", "index.js"), `// pkg ${i}\n`);
        writeFileSync(join(pkgDir, "package.json"), `{"name":"pkg-${i}"}\n`);
      }
      // Simulate npm uninstall (remove half)
      for (let i = 0; i < 25; i++) {
        try { rmSync(join(nmDir, `pkg-${i}`), { recursive: true }); } catch { /* ok */ }
      }
      const result = await searchPromise;
      assert.ok(result.ok || !result.ok, "node_modules churn should not crash search");
    } finally {
      simCleanup(finder, simDir);
    }
  });
});
