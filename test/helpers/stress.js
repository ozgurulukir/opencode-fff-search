import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Create a realistic OpenCode project structure for stress tests.
 * 200 source files across 7 subdirectories, 60 test files, git internals,
 * .opencode session DB, node_modules, and 10 large files (5KB-50KB).
 */
export function createProjectStructure(simDir) {
  mkdirSync(simDir, { recursive: true });

  mkdirSync(join(simDir, ".opencode"), { recursive: true });
  mkdirSync(join(simDir, "src"), { recursive: true });
  mkdirSync(join(simDir, "src", "components"), { recursive: true });
  mkdirSync(join(simDir, "src", "utils"), { recursive: true });
  mkdirSync(join(simDir, "src", "hooks"), { recursive: true });
  mkdirSync(join(simDir, "src", "services"), { recursive: true });
  mkdirSync(join(simDir, "src", "types"), { recursive: true });
  mkdirSync(join(simDir, "tests"), { recursive: true });
  mkdirSync(join(simDir, "tests", "unit"), { recursive: true });
  mkdirSync(join(simDir, "tests", "integration"), { recursive: true });
  mkdirSync(join(simDir, "node_modules", "some-pkg", "lib"), { recursive: true });
  mkdirSync(join(simDir, ".git", "objects"), { recursive: true });
  mkdirSync(join(simDir, ".git", "refs"), { recursive: true });

  // Session DB (OpenCode writes these)
  writeFileSync(join(simDir, ".opencode", "session.db"), "\x00".repeat(4096));

  // Source files — 200 files across 7 subdirectories
  const subdirs = ["", "components", "utils", "hooks", "services", "types", ""];
  for (let i = 0; i < 200; i++) {
    const dir = join(simDir, "src", subdirs[i % subdirs.length]);
    writeFileSync(
      join(dir, `module-${i}.js`),
      `// module ${i}\nexport const val = ${i};\n`.repeat(20),
    );
  }
  writeFileSync(join(simDir, "index.js"), `import './src/module-0.js';\n`);
  writeFileSync(join(simDir, "package.json"), '{"name":"sim-project","type":"module"}\n');

  // Test files — 60 across nested dirs
  for (let i = 0; i < 60; i++) {
    const dir = i < 30 ? "tests" : i < 45 ? "tests/unit" : "tests/integration";
    writeFileSync(join(simDir, dir, `test-${i}.test.js`), `import t from 'node:test';\n`.repeat(5));
  }

  // Git internals
  writeFileSync(join(simDir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(simDir, ".git", "index"), "fake git index\n".repeat(100));

  // Lock files and config
  writeFileSync(join(simDir, ".opencode", "plugin.lock"), "locked\n");
  writeFileSync(join(simDir, ".opencode", "config.jsonc"), "{}\n");

  // Node module file
  writeFileSync(
    join(simDir, "node_modules", "some-pkg", "lib", "index.js"),
    "module.exports = {};\n",
  );

  // Larger files (5KB-50KB) to stress mmap regions
  for (let i = 0; i < 10; i++) {
    writeFileSync(
      join(simDir, "src", `large-${i}.js`),
      "// large file\n".repeat(100 + i * 100),
    );
  }
}

/**
 * Create a FileFinder with safety flags (disableMmapCache, disableWatch).
 */
export async function initSimFinder(FileFinder, simDir) {
  const result = FileFinder.create({
    basePath: simDir,
    aiMode: true,
    disableMmapCache: true,
    disableWatch: true,
  });
  if (!result.ok) throw new Error(`sim finder init failed: ${result.error}`);
  const finder = result.value;
  const scan = await finder.waitForScan(15000);
  if (scan.ok && !scan.value) {
    // partial scan ok
  }
  return finder;
}

/**
 * Clean up a finder and its temp directory.
 */
export function simCleanup(finder, simDir) {
  if (finder && !finder.isDestroyed) {
    try { finder.destroy(); } catch { /* best effort */ }
  }
  rmSync(simDir, { recursive: true, force: true });
}

/**
 * Generate a unique temp directory path.
 */
export function makeTempDir(prefix, __dirname) {
  return join(__dirname, `.tmp-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}
