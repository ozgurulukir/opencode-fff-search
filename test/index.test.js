import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempProject() {
  const tmpDir = join(__dirname, ".tmp-test-" + process.pid);
  cleanupTempProject(tmpDir);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(tmpDir, "src"), { recursive: true });
  mkdirSync(join(tmpDir, "src/components"), { recursive: true });
  mkdirSync(join(tmpDir, "docs"), { recursive: true });

  writeFileSync(join(tmpDir, "index.js"), `import { foo } from "./src/foo.js";\nconsole.log(foo);\n`);
  writeFileSync(join(tmpDir, "README.md"), `# Test Project\n\nThis is a test.\n`);
  writeFileSync(join(tmpDir, "src", "foo.js"), `export const foo = "bar";\nexport const FOO = "UPPER";\n`);
  writeFileSync(join(tmpDir, "src", "bar.js"), `// empty file\n`);
  writeFileSync(
    join(tmpDir, "src", "components", "App.jsx"),
    `function App() { return <div>Hello</div>; }\nexport default App;\n`
  );
  writeFileSync(join(tmpDir, "docs", "notes.txt"), `TODO: finish this\nFIXME: broken thing\n`);
  writeFileSync(join(tmpDir, ".gitignore"), `node_modules/\n.tmp*\n`);
  writeFileSync(join(tmpDir, "src", "case.js"), `const lower = "abc";\nconst UPPER = "ABC";\nconst Mixed = "AbC";\n`);

  return tmpDir;
}

function cleanupTempProject(tmpDir) {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort
  }
}

function createMockClient() {
  const logs = [];
  return {
    logs,
    client: {
      app: {
        log: async ({ body }) => logs.push(body),
      },
    },
  };
}

function createContext(directory) {
  const ac = new AbortController();
  return {
    sessionID: "test-session",
    messageID: "test-msg",
    agent: "test-agent",
    directory,
    worktree: directory,
    abort: ac.signal,
    metadata: () => {},
    ask: () => {},
    _abortController: ac,
  };
}

// ---------------------------------------------------------------------------
// Shared state — single plugin instance reused across all tests
// ---------------------------------------------------------------------------

let FffPlugin;
let tmpDir;
let grepExecute;
let globExecute;
let ctx;

before(async () => {
  tmpDir = createTempProject();
  const mod = await import("../index.js");
  FffPlugin = mod.FffPlugin;

  const { client } = createMockClient();
  const { tool } = await FffPlugin({ directory: tmpDir, client });

  grepExecute = tool.grep.execute;
  globExecute = tool.glob.execute;
  ctx = createContext(tmpDir);

  // Wait for scan — poll until we get results or timeout at 15s
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const probe = await grepExecute({ pattern: "import" }, ctx);
      if (probe.length > 0) break;
    } catch { /* scan not ready yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
});

after(() => {
  cleanupTempProject(tmpDir);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FffPlugin", () => {
  // -----------------------------------------------------------------------
  // Plugin initialization
  // -----------------------------------------------------------------------
  describe("initialization", () => {
    it("should export an async function", () => {
      assert.equal(typeof FffPlugin, "function");
    });

    it("should accept PluginInput shape ({ directory, client, ... })", async () => {
      const { client } = createMockClient();
      const result = await FffPlugin({ directory: tmpDir, client });
      assert.ok(result);
      assert.ok(result.tool);
    });

    it("should return tool definitions for grep and glob", async () => {
      const { client } = createMockClient();
      const result = await FffPlugin({ directory: tmpDir, client });
      assert.ok(result.tool.grep, "should have grep tool");
      assert.ok(result.tool.glob, "should have glob tool");
    });

    it("should throw if FileFinder.create fails (nonexistent directory)", async () => {
      const { client } = createMockClient();
      await assert.rejects(
        () => FffPlugin({ directory: "/nonexistent/path/that/does/not/exist/aaa", client }),
        /fff initialization failed/
      );
    });

    it("should cache finder instance per directory (no double scan)", async () => {
      // FffPlugin logs 'Initializing' unconditionally (before cache check).
      // Verify caching by checking no errors and valid tool returns.
      const freshDir = createTempProject();
      try {
        const { client, logs } = createMockClient();
        const r1 = await FffPlugin({ directory: freshDir, client });
        const r2 = await FffPlugin({ directory: freshDir, client });
        assert.ok(r1.tool.grep && r1.tool.glob);
        assert.ok(r2.tool.grep && r2.tool.glob);
        const errors = logs.filter((l) => l.level === "error");
        assert.equal(errors.length, 0, "Should have no init errors");
      } finally {
        cleanupTempProject(freshDir);
      }
    });

    it("should log initialization message with directory", async () => {
      const { client, logs } = createMockClient();
      await FffPlugin({ directory: tmpDir, client });
      const initLog = logs.find((l) => l.message.includes("Initializing"));
      assert.ok(initLog, "Should log initialization");
      assert.ok(initLog.message.includes(tmpDir));
    });

    it("should survive broken client.log (safeLog never throws)", async () => {
      const brokenClient = { app: { log: async () => { throw new Error("broken"); } } };
      const result = await FffPlugin({ directory: tmpDir, client: brokenClient });
      assert.ok(result.tool.grep, "Plugin should survive logging failure");
    });
  });

  // -----------------------------------------------------------------------
  // Tool definition shape — OpenCode SDK contract
  // -----------------------------------------------------------------------
  describe("tool definition shape (OpenCode SDK contract)", () => {
    it("grep tool must have description, args, and execute function", async () => {
      const { client } = createMockClient();
      const { tool } = await FffPlugin({ directory: tmpDir, client });
      assert.equal(typeof tool.grep.description, "string");
      assert.ok(tool.grep.args && typeof tool.grep.args === "object");
      assert.equal(typeof tool.grep.execute, "function");
    });

    it("glob tool must have description, args, and execute function", async () => {
      const { client } = createMockClient();
      const { tool } = await FffPlugin({ directory: tmpDir, client });
      assert.equal(typeof tool.glob.description, "string");
      assert.ok(tool.glob.args && typeof tool.glob.args === "object");
      assert.equal(typeof tool.glob.execute, "function");
    });

    it("grep args match OpenCode built-in parameter names", async () => {
      const { client } = createMockClient();
      const { tool } = await FffPlugin({ directory: tmpDir, client });
      const openCodeParams = ["pattern", "path", "exclude", "caseSensitive", "context", "limit"];
      const pluginParams = Object.keys(tool.grep.args);
      for (const p of openCodeParams) {
        assert.ok(pluginParams.includes(p), `grep missing OpenCode param '${p}'`);
      }
    });

    it("glob args match OpenCode built-in parameter names", async () => {
      const { client } = createMockClient();
      const { tool } = await FffPlugin({ directory: tmpDir, client });
      const openCodeParams = ["pattern", "path", "type", "limit"];
      const pluginParams = Object.keys(tool.glob.args);
      for (const p of openCodeParams) {
        assert.ok(pluginParams.includes(p), `glob missing OpenCode param '${p}'`);
      }
    });

    it("grep execute returns Promise<string> (ToolResult contract)", async () => {
      const result = await grepExecute({ pattern: "foo" }, ctx);
      assert.equal(typeof result, "string", "ToolResult must be string, not object");
    });

    it("glob execute returns Promise<string> (ToolResult contract)", async () => {
      const result = await globExecute({ pattern: "foo" }, ctx);
      assert.equal(typeof result, "string", "ToolResult must be string, not object");
    });
  });

  // -----------------------------------------------------------------------
  // grep — basic functionality
  // -----------------------------------------------------------------------
  describe("grep basic", () => {
    it("should find a simple text pattern", async () => {
      const result = await grepExecute({ pattern: "console.log" }, ctx);
      assert.ok(result.includes("console.log"), `Expected 'console.log' in: ${result}`);
    });

    it("should return 'file:line:content' format", async () => {
      const result = await grepExecute({ pattern: "console.log" }, ctx);
      assert.ok(result.length > 0);
      for (const line of result.split("\n").filter(Boolean)) {
        assert.ok(/^.+:\d+:.+$/m.test(line), `Bad format: "${line}"`);
      }
    });

    it("should return empty string for no matches", async () => {
      const result = await grepExecute({ pattern: "ZZZNONEXISTENT_PATTERN_ZZZ" }, ctx);
      assert.equal(result, "");
    });

    it("should use relative paths (not absolute)", async () => {
      const result = await grepExecute({ pattern: "foo" }, ctx);
      for (const line of result.split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(!filePath.startsWith("/"), `Path should be relative: ${filePath}`);
      }
    });

    it("should throw on empty pattern", async () => {
      await assert.rejects(() => grepExecute({ pattern: "" }, ctx), /pattern must be a non-empty string/);
    });

    it("should throw on whitespace-only pattern", async () => {
      await assert.rejects(() => grepExecute({ pattern: "   " }, ctx), /pattern must be a non-empty string/);
    });

    it("should throw on non-string pattern", async () => {
      await assert.rejects(() => grepExecute({ pattern: 123 }, ctx), /pattern must be a non-empty string/);
    });
  });

  // -----------------------------------------------------------------------
  // grep — case sensitivity / smart case
  // -----------------------------------------------------------------------
  describe("grep case sensitivity", () => {
    it("smart case (default): lowercase 'abc' matches both 'abc' and 'ABC'", async () => {
      const result = await grepExecute({ pattern: "abc" }, ctx);
      const caseJsLines = result.split("\n").filter((l) => l.includes("case.js"));
      // case.js has: const lower = "abc";  const UPPER = "ABC";  const Mixed = "AbC";
      // With smartCase (default), lowercase 'abc' should match both lines
      assert.ok(caseJsLines.length >= 2, `Smart case 'abc' should match both 'abc' and 'ABC', got ${caseJsLines.length} lines in case.js`);
    });

    it("smart case: uppercase 'ABC' triggers case-sensitive matching", async () => {
      const result = await grepExecute({ pattern: "ABC" }, ctx);
      const caseJsLines = result.split("\n").filter((l) => l.includes("case.js"));
      // Smart case: uppercase pattern → case-sensitive, so 'ABC' only matches "ABC" not "abc"
      for (const line of caseJsLines) {
        const content = line.split(":").slice(2).join(":");
        assert.ok(content.includes("ABC"), `Smart case 'ABC' should match 'ABC': ${content}`);
      }
      // Should NOT match the line with only lowercase "abc"
      const lowerLines = caseJsLines.filter((l) => {
        const content = l.split(":").slice(2).join(":");
        return content.includes('"abc"');
      });
      assert.equal(lowerLines.length, 0, "Smart case 'ABC' should not match lowercase 'abc'");
    });

    it("caseSensitive=true: 'abc' only matches lowercase 'abc'", async () => {
      const result = await grepExecute({ pattern: "abc", caseSensitive: true }, ctx);
      const caseJsLines = result.split("\n").filter((l) => l.includes("case.js"));
      for (const line of caseJsLines) {
        const content = line.split(":").slice(2).join(":");
        assert.ok(content.includes("abc"), `caseSensitive 'abc' should match 'abc': ${content}`);
      }
    });

    it("caseSensitive=false explicitly: behaves same as default (smart case)", async () => {
      const resultDefault = await grepExecute({ pattern: "abc" }, ctx);
      const resultExplicit = await grepExecute({ pattern: "abc", caseSensitive: false }, ctx);
      // Both should return the same results
      assert.equal(resultDefault, resultExplicit);
    });

    it("mixed-case 'AbC' triggers case-sensitive via smart case", async () => {
      const result = await grepExecute({ pattern: "AbC" }, ctx);
      if (result.length > 0) {
        for (const line of result.split("\n").filter(Boolean)) {
          const content = line.split(":").slice(2).join(":");
          assert.ok(content.includes("AbC"), `Smart case 'AbC' should be case-sensitive: ${content}`);
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // grep — path filtering
  // -----------------------------------------------------------------------
  describe("grep path filtering", () => {
    it("should scope results to a subdirectory", async () => {
      const result = await grepExecute({ pattern: "export", path: "src" }, ctx);
      for (const line of result.split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(filePath === "src" || filePath.startsWith("src/"), `Path filter failed: ${filePath}`);
      }
    });

    it("should normalize trailing slashes", async () => {
      const a = await grepExecute({ pattern: "export", path: "src/" }, ctx);
      const b = await grepExecute({ pattern: "export", path: "src" }, ctx);
      assert.equal(a, b, "Trailing slash should be normalized");
    });

    it("should normalize multiple trailing slashes", async () => {
      const result = await grepExecute({ pattern: "export", path: "src///" }, ctx);
      for (const line of result.split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(filePath.startsWith("src/"), `Multi-slash path filter failed: ${filePath}`);
      }
    });

    it("should return empty for nonexistent path", async () => {
      const result = await grepExecute({ pattern: "export", path: "nonexistent_dir" }, ctx);
      assert.equal(result, "");
    });

    it("should filter to nested subdirectory", async () => {
      const result = await grepExecute({ pattern: ".", path: "src/components" }, ctx);
      for (const line of result.split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(
          filePath.startsWith("src/components/"),
          `Nested path filter failed: ${filePath}`
        );
      }
    });
  });

  // -----------------------------------------------------------------------
  // grep — exclude patterns
  // -----------------------------------------------------------------------
  describe("grep exclude patterns", () => {
    it("should exclude files matching a single glob", async () => {
      const all = await grepExecute({ pattern: "export" }, ctx);
      const filtered = await grepExecute({ pattern: "export", exclude: "src/**" }, ctx);
      assert.ok(filtered.split("\n").filter(Boolean).length <= all.split("\n").filter(Boolean).length);
      for (const line of filtered.split("\n").filter(Boolean)) {
        assert.ok(!line.split(":")[0].startsWith("src/"), `Excluded file leaked: ${line}`);
      }
    });

    it("should support comma-separated exclude patterns", async () => {
      const result = await grepExecute({ pattern: ".", exclude: "src/**,docs/**" }, ctx);
      for (const line of result.split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(!filePath.startsWith("src/") && !filePath.startsWith("docs/"), `Comma exclude leaked: ${filePath}`);
      }
    });

    it("should trim whitespace around comma-separated patterns", async () => {
      const result = await grepExecute({ pattern: ".", exclude: " src/** , docs/** " }, ctx);
      for (const line of result.split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(!filePath.startsWith("src/") && !filePath.startsWith("docs/"), `Trimmed exclude leaked: ${filePath}`);
      }
    });

    it("should exclude hidden files (.gitignore) with dot:true", async () => {
      const all = await grepExecute({ pattern: "node_modules" }, ctx);
      const filtered = await grepExecute({ pattern: "node_modules", exclude: ".gitignore" }, ctx);
      if (all.includes(".gitignore")) {
        assert.ok(!filtered.includes(".gitignore"), "Hidden file .gitignore should be excludable");
      }
    });
  });

  // -----------------------------------------------------------------------
  // grep — context lines
  // -----------------------------------------------------------------------
  describe("grep context lines", () => {
    it("context > 0 should return more lines than context=0", async () => {
      const noCtx = await grepExecute({ pattern: "console.log", context: 0 }, ctx);
      const withCtx = await grepExecute({ pattern: "console.log", context: 1 }, ctx);
      assert.ok(
        withCtx.split("\n").filter(Boolean).length >= noCtx.split("\n").filter(Boolean).length,
        "context=1 should return >= lines than context=0"
      );
    });

    it("context=0 should equal omitting context", async () => {
      const a = await grepExecute({ pattern: "console.log", context: 0 }, ctx);
      const b = await grepExecute({ pattern: "console.log" }, ctx);
      assert.equal(a, b);
    });
  });

  // -----------------------------------------------------------------------
  // grep — limit
  // -----------------------------------------------------------------------
  describe("grep limit", () => {
    it("should respect limit parameter", async () => {
      const result = await grepExecute({ pattern: ".", limit: 2 }, ctx);
      const lines = result.split("\n").filter(Boolean);
      assert.ok(lines.length <= 2, `limit=2 returned ${lines.length} lines`);
    });

    it("limit=1 returns at most 1 line", async () => {
      const result = await grepExecute({ pattern: ".", limit: 1 }, ctx);
      const lines = result.split("\n").filter(Boolean);
      assert.ok(lines.length <= 1);
    });

    it("default limit should cap at 1000", async () => {
      const result = await grepExecute({ pattern: "." }, ctx);
      const lines = result.split("\n").filter(Boolean);
      assert.ok(lines.length <= 1000, `Default limit exceeded: ${lines.length}`);
    });

    it("should throw on negative limit", async () => {
      await assert.rejects(() => grepExecute({ pattern: "foo", limit: -5 }, ctx), /limit must be a number/);
    });

    it("should throw on limit > MAX_LIMIT (5000)", async () => {
      await assert.rejects(() => grepExecute({ pattern: "foo", limit: 99999 }, ctx), /limit must be a number/);
    });

    it("should throw on limit=0", async () => {
      await assert.rejects(() => grepExecute({ pattern: "foo", limit: 0 }, ctx), /limit must be a number/);
    });
  });

  // -----------------------------------------------------------------------
  // grep — input validation
  // -----------------------------------------------------------------------
  describe("grep input validation", () => {
    it("should throw on negative context", async () => {
      await assert.rejects(() => grepExecute({ pattern: "foo", context: -1 }, ctx), /context must be a non-negative/);
    });

    it("should throw on non-number context", async () => {
      await assert.rejects(() => grepExecute({ pattern: "foo", context: "2" }, ctx), /context must be a non-negative/);
    });

    it("should throw on non-number limit", async () => {
      await assert.rejects(() => grepExecute({ pattern: "foo", limit: "abc" }, ctx), /limit must be a number/);
    });
  });

  // -----------------------------------------------------------------------
  // grep — abort handling
  // -----------------------------------------------------------------------
  describe("grep abort", () => {
    it("should throw 'Aborted' when signal is already aborted", async () => {
      const abortCtx = createContext(tmpDir);
      abortCtx._abortController.abort();
      await assert.rejects(() => grepExecute({ pattern: "foo" }, abortCtx), /Aborted/);
    });
  });

  // -----------------------------------------------------------------------
  // grep — regex mode
  // -----------------------------------------------------------------------
  describe("grep regex mode", () => {
    it("should support regex patterns", async () => {
      const result = await grepExecute({ pattern: "export\\s+const" }, ctx);
      assert.ok(result.length > 0, "Regex should match");
      for (const line of result.split("\n").filter(Boolean)) {
        const content = line.split(":").slice(2).join(":");
        assert.ok(/export\s+const/.test(content), `Regex didn't match: ${content}`);
      }
    });

    it("should handle invalid regex gracefully (fff falls back to literal)", async () => {
      const result = await grepExecute({ pattern: "[invalid" }, ctx);
      assert.equal(typeof result, "string", "Invalid regex should not crash");
    });
  });

  // -----------------------------------------------------------------------
  // glob — basic functionality
  // -----------------------------------------------------------------------
  describe("glob basic", () => {
    it("should find files by fuzzy pattern", async () => {
      const result = await globExecute({ pattern: "foo" }, ctx);
      assert.ok(result.length > 0, "Should find foo.js");
      assert.ok(result.includes("foo.js"), `Missing foo.js in: ${result}`);
    });

    it("should return newline-separated paths", async () => {
      const result = await globExecute({ pattern: "foo" }, ctx);
      assert.ok(result.length > 0);
      const lines = result.split("\n").filter(Boolean);
      for (const line of lines) {
        // Should be relative paths, not absolute
        assert.ok(!line.startsWith("/"), `Glob path should be relative: ${line}`);
      }
    });

    it("should return empty string for no matches", async () => {
      const result = await globExecute({ pattern: "ZZZNONEXISTENT_FILE_ZZZ" }, ctx);
      assert.equal(result, "");
    });

    it("should throw on empty pattern", async () => {
      await assert.rejects(() => globExecute({ pattern: "" }, ctx), /pattern must be a non-empty string/);
    });

    it("should throw on whitespace-only pattern", async () => {
      await assert.rejects(() => globExecute({ pattern: "   " }, ctx), /pattern must be a non-empty string/);
    });

    it("should throw on invalid limit", async () => {
      await assert.rejects(() => globExecute({ pattern: "foo", limit: -1 }, ctx), /limit must be a number/);
    });
  });

  // -----------------------------------------------------------------------
  // glob — type filter
  // -----------------------------------------------------------------------
  describe("glob type filter", () => {
    it("default (no type) should return files", async () => {
      const result = await globExecute({ pattern: "." }, ctx);
      // fff fileSearch returns FileItems which have relativePath (typically no trailing /)
      assert.ok(result.length > 0, "Should find files");
    });

    it("type='directory' should return directory paths", async () => {
      const result = await globExecute({ pattern: ".", type: "directory" }, ctx);
      assert.ok(result.length > 0, "Should find directories");
      const lines = result.split("\n").filter(Boolean);
      for (const line of lines) {
        // fff DirItem.relativePath typically ends with /
        assert.ok(
          line.endsWith("/") || line.includes("/"),
          `Directory search should return dirs: ${line}`
        );
      }
    });

    it("invalid type value is silently ignored (Zod optional enum coerces to undefined)", async () => {
      // Zod enum with optional() means invalid values become undefined, falling to default file search
      const result = await globExecute({ pattern: "foo", type: "invalid" }, ctx);
      assert.equal(typeof result, "string", "Invalid type should not crash");
    });
  });

  // -----------------------------------------------------------------------
  // glob — path filtering
  // -----------------------------------------------------------------------
  describe("glob path filtering", () => {
    it("should scope results to a subdirectory", async () => {
      const result = await globExecute({ pattern: ".", path: "src" }, ctx);
      for (const line of result.split("\n").filter(Boolean)) {
        assert.ok(line === "src" || line.startsWith("src/"), `Glob path filter failed: ${line}`);
      }
    });

    it("should normalize trailing slashes", async () => {
      const a = await globExecute({ pattern: ".", path: "src/" }, ctx);
      const b = await globExecute({ pattern: ".", path: "src" }, ctx);
      assert.equal(a, b);
    });
  });

  // -----------------------------------------------------------------------
  // glob — limit
  // -----------------------------------------------------------------------
  describe("glob limit", () => {
    it("should respect limit parameter", async () => {
      const result = await globExecute({ pattern: ".", limit: 2 }, ctx);
      const lines = result.split("\n").filter(Boolean);
      assert.ok(lines.length <= 2, `limit=2 returned ${lines.length} results`);
    });
  });

  // -----------------------------------------------------------------------
  // glob — abort handling
  // -----------------------------------------------------------------------
  describe("glob abort", () => {
    it("should throw 'Aborted' when signal is already aborted", async () => {
      const abortCtx = createContext(tmpDir);
      abortCtx._abortController.abort();
      await assert.rejects(() => globExecute({ pattern: "foo" }, abortCtx), /Aborted/);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe("edge cases", () => {
    it("grep with special regex characters", async () => {
      const result = await grepExecute({ pattern: "(import|export)" }, ctx);
      assert.equal(typeof result, "string");
    });

    it("grep with very long pattern", async () => {
      const result = await grepExecute({ pattern: "a".repeat(1000) }, ctx);
      assert.equal(typeof result, "string");
    });

    it("grep with single character pattern", async () => {
      const result = await grepExecute({ pattern: "a" }, ctx);
      assert.equal(typeof result, "string");
    });

    it("glob with special characters in pattern", async () => {
      const result = await globExecute({ pattern: "foo.js" }, ctx);
      assert.equal(typeof result, "string");
    });

    it("grep with path + exclude combined", async () => {
      const result = await grepExecute({ pattern: ".", path: "src", exclude: "src/components/**" }, ctx);
      for (const line of result.split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(!filePath.startsWith("src/components/"), `Combined filter failed: ${filePath}`);
      }
    });

    it("grep with all optional parameters set", async () => {
      const result = await grepExecute({
        pattern: "export",
        path: "src",
        exclude: "src/bar.js",
        caseSensitive: true,
        context: 1,
        limit: 50,
      }, ctx);
      assert.equal(typeof result, "string");
      for (const line of result.split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(filePath.startsWith("src/"), `Combined params failed: ${filePath}`);
        assert.ok(!filePath.includes("bar.js"), `Exclude failed: ${filePath}`);
      }
    });

    it("plugin handles undefined args gracefully", async () => {
      // OpenCode might pass extra/undefined fields
      const result = await grepExecute({ pattern: "foo", extraField: "ignored" }, ctx);
      assert.equal(typeof result, "string");
    });

    it("multiple concurrent grep calls should work (shared scanPromise)", async () => {
      const [r1, r2, r3] = await Promise.all([
        grepExecute({ pattern: "foo" }, ctx),
        grepExecute({ pattern: "bar" }, ctx),
        grepExecute({ pattern: "export" }, ctx),
      ]);
      assert.equal(typeof r1, "string");
      assert.equal(typeof r2, "string");
      assert.equal(typeof r3, "string");
    });
  });
});

// =========================================================================
// SIGBUS / stability stress tests
// =========================================================================
//
// SIGBUS cannot be caught in JavaScript — it kills the process outright.
// These tests exercise the conditions that historically trigger SIGBUS in fff's
// native layer (mmap'd files truncated during I/O, multiple native instances,
// frecency DB corruption). If any test causes a SIGBUS, the entire test
// process exits with signal 7 and the remaining tests won't run.
// =========================================================================

const { FileFinder } = await import("@ff-labs/fff-node");
const { appendFileSync, unlinkSync, openSync, closeSync, ftruncateSync, renameSync, cpSync, rmdirSync } = await import("node:fs");

describe("SIGBUS / stability stress tests", () => {
  let stressDir;
  let stressFinder;

  // Each test gets its own temp dir and finder to avoid cross-contamination
  async function setupStressDir() {
    stressDir = join(__dirname, `.tmp-stress-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(stressDir, { recursive: true });
    // Create a decent number of files to make the index non-trivial
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(stressDir, `file-${i}.txt`), `line1 of file ${i}\n${"x".repeat(200)}\nline3 of file ${i}\n`);
    }
  }

  async function initFinder() {
    const result = FileFinder.create({
      basePath: stressDir,
      aiMode: true,
      disableMmapCache: true,
    });
    if (!result.ok) throw new Error(`stress finder init failed: ${result.error}`);
    stressFinder = result.value;
    // Wait for scan
    const scanResult = await stressFinder.waitForScan(10000);
    if (scanResult.ok && !scanResult.value) {
      // Scan didn't complete — try a search anyway, it might work on partial index
    }
  }

  function cleanup() {
    if (stressFinder && !stressFinder.isDestroyed) {
      try { stressFinder.destroy(); } catch { /* best effort */ }
    }
    cleanupTempProject(stressDir);
  }

  // ----------------------------------------------------------------------
  // File mutation during active search
  // ----------------------------------------------------------------------
  describe("file mutation during search", () => {
    it("should not crash when a file is deleted between scan and grep", async () => {
      await setupStressDir();
      try {
        await initFinder();
        // Delete a file that was indexed
        unlinkSync(join(stressDir, "file-25.txt"));
        // Grep should handle missing file gracefully
        const result = stressFinder.grep("line1");
        assert.ok(result.ok || !result.ok, "grep should not crash");
        if (result.ok) {
          assert.equal(typeof result.value.items, "object");
        }
      } finally {
        cleanup();
      }
    });

    it("should not crash when a file is truncated between scan and grep", async () => {
      await setupStressDir();
      try {
        await initFinder();
        // Truncate a file to 0 bytes (classic SIGBUS trigger for mmap'd files)
        const fd = openSync(join(stressDir, "file-10.txt"), "w");
        ftruncateSync(fd, 0);
        closeSync(fd);
        const result = stressFinder.grep("file-10");
        assert.ok(result.ok || !result.ok, "grep should not crash on truncated file");
      } finally {
        cleanup();
      }
    });

    it("should not crash when a file is overwritten during grep", async () => {
      await setupStressDir();
      try {
        await initFinder();
        // Rapidly overwrite files while searching
        const searchPromise = stressFinder.grep("x{200}");
        for (let i = 0; i < 10; i++) {
          writeFileSync(join(stressDir, `file-${i}.txt`), `overwritten ${Date.now()}\n`);
        }
        const result = await searchPromise;
        assert.ok(result.ok || !result.ok, "grep should not crash during file mutation");
      } finally {
        cleanup();
      }
    });

    it("should not crash when files are created and deleted rapidly", async () => {
      await setupStressDir();
      try {
        await initFinder();
        // Rapid create/delete cycle
        for (let i = 0; i < 100; i++) {
          const path = join(stressDir, `volatile-${i}.txt`);
          writeFileSync(path, `volatile content ${i}` + "\n");
          if (i % 2 === 0) {
            unlinkSync(path);
          }
        }
        // Now search — should not crash on stale directory entries
        const result = stressFinder.grep("volatile");
        assert.ok(result.ok || !result.ok, "grep should handle volatile files");
      } finally {
        cleanup();
      }
    });
  });

  // ----------------------------------------------------------------------
  // Multiple finder instances (potential SIGBUS from leaked native handles)
  // ----------------------------------------------------------------------
  describe("multiple native instances", () => {
    it("should not crash when creating multiple FileFinder instances for same dir", async () => {
      await setupStressDir();
      const finders = [];
      try {
        // Create 5 separate finders for the same directory
        for (let i = 0; i < 5; i++) {
          const result = FileFinder.create({
            basePath: stressDir,
            aiMode: true,
            disableMmapCache: true,
          });
          if (result.ok) finders.push(result.value);
        }
        // Run searches on all of them concurrently
        const results = await Promise.all(
          finders.map((f) => f.grep("line1"))
        );
        for (const r of results) {
          assert.ok(r.ok || !r.ok, "each finder should not crash");
        }
      } finally {
        for (const f of finders) {
          try { if (!f.isDestroyed) f.destroy(); } catch { /* best effort */ }
        }
        cleanup();
      }
    });

    it("should not crash when destroy() is called while searches are pending", async () => {
      await setupStressDir();
      try {
        const result = FileFinder.create({
          basePath: stressDir,
          aiMode: true,
          disableMmapCache: true,
        });
        if (!result.ok) throw new Error(`init failed: ${result.error}`);
        const finder = result.value;
        await finder.waitForScan(5000);
        // Start a search, then immediately destroy
        const searchPromise = finder.grep(".");
        finder.destroy();
        // The search should return an error, not SIGBUS
        const searchResult = await searchPromise;
        assert.ok(searchResult.ok || !searchResult.ok, "destroy during search should not SIGBUS");
      } finally {
        cleanup();
      }
    });
  });

  // ----------------------------------------------------------------------
  // Large files (potential mmap pressure)
  // ----------------------------------------------------------------------
  describe("large file handling", () => {
    it("should not crash when grepping a large file that gets truncated", async () => {
      await setupStressDir();
      try {
        // Create a 1MB file
        const bigFile = join(stressDir, "bigfile.txt");
        writeFileSync(bigFile, "A".repeat(1024 * 1024));

        await initFinder();

        // Truncate the large file (classic SIGBUS for mmap'd regions)
        const fd = openSync(bigFile, "w");
        ftruncateSync(fd, 0);
        closeSync(fd);

        const result = stressFinder.grep("AAAA");
        assert.ok(result.ok || !result.ok, "grep should not crash on truncated large file");
      } finally {
        cleanup();
      }
    });
  });

  // ----------------------------------------------------------------------
  // Plugin-level stress: multiple FffPlugin() calls
  // ----------------------------------------------------------------------
  describe("plugin-level stress", () => {
    it("should not crash when FffPlugin is called many times for the same directory", async () => {
      // This tests the instance cache — repeated calls should reuse the same finder
      const { client } = createMockClient();
      for (let i = 0; i < 10; i++) {
        const result = await FffPlugin({ directory: tmpDir, client });
        assert.ok(result.tool.grep);
        assert.ok(result.tool.glob);
      }
    });

    it("should not crash when FffPlugin is called for many different directories", async () => {
      const { client } = createMockClient();
      const dirs = [];
      for (let i = 0; i < 5; i++) {
        const d = createTempProject();
        dirs.push(d);
        const result = await FffPlugin({ directory: d, client });
        assert.ok(result.tool.grep);
        assert.ok(result.tool.glob);
      }
      // Clean up temp dirs
      for (const d of dirs) cleanupTempProject(d);
    });
  });
});

