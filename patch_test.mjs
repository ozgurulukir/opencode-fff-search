import fs from 'fs';

let content = fs.readFileSync('test/index.test.js', 'utf8');

// replace TODO
content = content.replace(
  'writeFileSync(join(tmpDir, "docs", "notes.txt"), `TODO: finish this\\nFIXME: broken thing\\n`);',
  'writeFileSync(join(tmpDir, "docs", "notes.txt"), `hello world\\n`);'
);

// add missing tests inside edge cases suite
const importStr = 'const { FileFinder } = await import("@ff-labs/fff-node");';
const internalsImport = 'import { fsGrep, loadGitignoreFilter, globWalk, detectGrepMode, filterByPath, resolvePath, directFileGrep } from "../index.js";\n';
content = content.replace(importStr, internalsImport + importStr);
const newInternalsImportFs = 'const { appendFileSync, unlinkSync, openSync, closeSync, ftruncateSync, renameSync, cpSync, rmdirSync, chmodSync } = await import("node:fs");';
content = content.replace('const { appendFileSync, unlinkSync, openSync, closeSync, ftruncateSync, renameSync, cpSync, rmdirSync } = await import("node:fs");', newInternalsImportFs);

const suiteEnd = `});

// =========================================================================
// SIGBUS / stability stress tests`;

const newTests = `
  describe("fsGrep internals", () => {
    it("should handle unreadable directories gracefully in readdirSync catch block", async () => {
      const unreadableDir = join(tmpDir, "unreadable");
      mkdirSync(unreadableDir);
      chmodSync(unreadableDir, 0o000); // Remove all permissions

      try {
        const results = await fsGrep(unreadableDir, tmpDir, "anything", 0, null, null, null, 10);
        assert.deepEqual(results, [], "Should return empty array when directory is unreadable");
      } finally {
        chmodSync(unreadableDir, 0o755); // Restore permissions for cleanup
      }
    });
  });

  describe("loadGitignoreFilter", () => {
    it("should correctly parse and filter based on .gitignore", () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\\n*.log\\nbuild/\\n");
      const filter = loadGitignoreFilter(tmpDir);

      assert.strictEqual(filter("node_modules", true), true, "node_modules should be ignored");
      assert.strictEqual(filter("build", true), true, "build should be ignored");
      assert.strictEqual(filter("src", true), false, "src should not be ignored");
      assert.strictEqual(filter("index.js", false), false, "index.js should not be ignored");
      assert.strictEqual(filter(".git", true), true, ".git should be ignored (starts with .)");
      assert.strictEqual(filter(".env", false), false, ".env file should not be ignored (only directories starting with .)");
    });
  });

  describe("globWalk internals", () => {
    it("should handle unreadable directories gracefully in readdir catch block", async () => {
      const unreadableDir = join(tmpDir, "unreadable_glob");
      mkdirSync(unreadableDir);
      chmodSync(unreadableDir, 0o000); // Remove all permissions

      try {
        const results = await globWalk(unreadableDir, "*", tmpDir, 10, "file");
        assert.deepEqual(results, [], "Should return empty array when directory is unreadable");
      } finally {
        chmodSync(unreadableDir, 0o755); // Restore permissions for cleanup
      }
    });
  });

  describe("detectGrepMode", () => {
    it("should correctly identify plain text and regex patterns", () => {
      // Plain text patterns (even with symbols like dots, parens, commas)
      assert.strictEqual(detectGrepMode("hello world"), "plain");
      assert.strictEqual(detectGrepMode("example.com"), "plain");
      assert.strictEqual(detectGrepMode("foo(bar)"), "plain");
      assert.strictEqual(detectGrepMode("a,b,c"), "plain");

      // Regex patterns
      assert.strictEqual(detectGrepMode("\\\\s+"), "regex");
      assert.strictEqual(detectGrepMode("import|export"), "regex");
      assert.strictEqual(detectGrepMode("foo[0-9]"), "regex");
      assert.strictEqual(detectGrepMode("^start"), "regex");
      assert.strictEqual(detectGrepMode("end$"), "regex");
      assert.strictEqual(detectGrepMode("a\\\\+"), "regex");
      assert.strictEqual(detectGrepMode("a\\\\*"), "regex");
      assert.strictEqual(detectGrepMode("a\\\\?"), "regex");
    });

    it("should handle null or undefined gracefully", () => {
      // should return "plain" or throw, typically "plain" if pattern is falsey
      assert.strictEqual(detectGrepMode(null), "plain");
      assert.strictEqual(detectGrepMode(undefined), "plain");
      assert.strictEqual(detectGrepMode(""), "plain");
    });
  });

  describe("filterByPath", () => {
    it("should correctly include/exclude items based on target path", () => {
      const items = [
        { path: "src/index.js" },
        { path: "src/utils/helper.js" },
        { path: "docs/readme.md" },
        { path: "package.json" }
      ];

      // Root paths should return all items
      assert.deepEqual(filterByPath(items, "path", "."), items);
      assert.deepEqual(filterByPath(items, "path", "./"), items);
      assert.deepEqual(filterByPath(items, "path", "/"), items);

      // Specific path should filter
      const srcItems = filterByPath(items, "path", "src");
      assert.strictEqual(srcItems.length, 2);
      assert.strictEqual(srcItems[0].path, "src/index.js");
      assert.strictEqual(srcItems[1].path, "src/utils/helper.js");

      // Subdirectory exact match
      const utilsItems = filterByPath(items, "path", "src/utils/helper.js");
      assert.strictEqual(utilsItems.length, 1);
      assert.strictEqual(utilsItems[0].path, "src/utils/helper.js");
    });
  });

  describe("resolvePath", () => {
    it("should correctly resolve relative paths and prevent traversal", () => {
      const workspace = "/var/workspace";

      // Absolute path outside workspace now throws
      assert.throws(() => resolvePath(workspace, "/etc/passwd"), /Path is outside the workspace directory/);

      // Absolute path inside workspace resolves
      assert.strictEqual(resolvePath(workspace, "/var/workspace/src"), "/var/workspace/src");

      // Path traversal attempts throw
      assert.throws(() => resolvePath(workspace, "../etc/passwd"), /Path is outside the workspace directory/);

      // Relative path
      assert.strictEqual(resolvePath(workspace, "src/index.js"), "/var/workspace/src/index.js");
      assert.strictEqual(resolvePath(workspace, "./src"), "/var/workspace/src");

      // Falsy input
      assert.strictEqual(resolvePath(workspace, ""), "/var/workspace");
      assert.strictEqual(resolvePath(workspace, null), "/var/workspace");
    });
  });

  describe("directFileGrep", () => {
    it("should handle unreadable files gracefully in readFile catch block", async () => {
      const unreadableFile = join(tmpDir, "unreadable.txt");
      writeFileSync(unreadableFile, "secret content");
      chmodSync(unreadableFile, 0o000); // Remove all permissions

      try {
        const results = await directFileGrep(unreadableFile, tmpDir, "secret", 0);
        assert.deepEqual(results, [], "Should return empty array when file is unreadable");
      } finally {
        chmodSync(unreadableFile, 0o644); // Restore permissions for cleanup
      }
    });

    it("should handle invalid regex patterns by falling back to literal matching", async () => {
      const file = join(tmpDir, "regex.txt");
      writeFileSync(file, "content with [ symbol\\n");

      const results = await directFileGrep(file, tmpDir, "[", 0);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].lineContent, "content with [ symbol");
    });
  });

});

// =========================================================================
// SIGBUS / stability stress tests`;

content = content.replace(suiteEnd, newTests);
fs.writeFileSync('test/index.test.js', content);
console.log('patched');
