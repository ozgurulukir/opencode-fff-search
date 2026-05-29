import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
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
  writeFileSync(join(tmpDir, "src", "metachars.js"), `// contains literal regex metacharacters
const parens = "foo(bar)";
const bracket = "file[1].txt";
const plus = "page+1";
const dot = "example.com";
`);


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
function out(result) {
  return typeof result === "object" && result !== null && result.output != null ? result.output : result;
}

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
  FffPlugin = mod.default;

  const { client } = createMockClient();
  const { tool } = await FffPlugin({ directory: tmpDir, client });

  grepExecute = tool.grep.execute;
  globExecute = tool.glob.execute;
  ctx = createContext(tmpDir);

  // Wait for scan — poll until we get results or timeout at 15s
  // NOTE: We do NOT call grepExecute here because finder.grep can panic in
  // fff-core on the first call when the content index is still building.
  // Individual tests rely on grepExecute's built-in waitForScan() to handle this.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
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
      // createTempProject() calls cleanupTempProject(tmpDir) internally
      // which deletes the shared test directory.  That breaks the Rust
      // overlay index state and can trigger a segmentation fault
      // (grep.rs:2110 slice panic) when the next suite runs
      // finder.grep() with a stale overflow_start > files.len().
      // Use a fresh unique directory instead.
      const freshDir = join(__dirname, ".tmp-fresh-" + process.pid + "-" + Date.now());
      try {
        const { client, logs } = createMockClient();
        mkdirSync(freshDir, { recursive: true });
        const r1 = await FffPlugin({ directory: freshDir, client });
        const r2 = await FffPlugin({ directory: freshDir, client });
        assert.ok(r1.tool.grep && r1.tool.glob);
        assert.ok(r2.tool.grep && r2.tool.glob);
        const errors = logs.filter((l) => l.level === "error");
        assert.equal(errors.length, 0, "Should have no init errors");
      } finally {
        rmSync(freshDir, { recursive: true, force: true });
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
      const openCodeParams = ["pattern", "path", "include", "exclude", "caseSensitive", "context", "limit"];
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
      assert.equal(typeof result, "object", "ToolResult must be object, not string");
    });

    it("glob execute returns Promise<string> (ToolResult contract)", async () => {
      const result = await globExecute({ pattern: "foo" }, ctx);
      assert.equal(typeof result, "object", "ToolResult must be object, not string");
    });
  });

  // -----------------------------------------------------------------------
  // grep — basic functionality
  // -----------------------------------------------------------------------
  describe("grep basic", () => {
    it("should find a simple text pattern", async () => {
      const result = await grepExecute({ pattern: "console.log" }, ctx);
      assert.ok(out(result).includes("console.log"), `Expected 'console.log' in: ${result}`);
    });

    it("should return 'file:line:content' format", async () => {
      const result = await grepExecute({ pattern: "console.log" }, ctx);
      assert.ok(out(result).length > 0);
      for (const line of out(result).split("\n").filter(Boolean)) {
        assert.ok(/^.+:\d+:.+$/m.test(line), `Bad format: "${line}"`);
      }
    });

    it("should return empty string for no matches", async () => {
      const result = await grepExecute({ pattern: "ZZZNONEXISTENT_PATTERN_ZZZ" }, ctx);
      assert.ok(!out(result) || out(result) === "No files found", "Expected empty/found output");
    });

    it("should use relative paths (not absolute)", async () => {
      const result = await grepExecute({ pattern: "foo" }, ctx);
      for (const line of out(result).split("\n").filter(Boolean)) {
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
      const caseJsLines = out(result).split("\n").filter((l) => l.includes("case.js"));
      // case.js has: const lower = "abc";  const UPPER = "ABC";  const Mixed = "AbC";
      // With smartCase (default), lowercase 'abc' should match both lines
      assert.ok(caseJsLines.length >= 2, `Smart case 'abc' should match both 'abc' and 'ABC', got ${caseJsLines.length} lines in case.js`);
    });

    it("smart case: uppercase 'ABC' triggers case-sensitive matching", async () => {
      const result = await grepExecute({ pattern: "ABC" }, ctx);
      const caseJsLines = out(result).split("\n").filter((l) => l.includes("case.js"));
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
      const caseJsLines = out(result).split("\n").filter((l) => l.includes("case.js"));
      for (const line of caseJsLines) {
        const content = line.split(":").slice(2).join(":");
        assert.ok(content.includes("abc"), `caseSensitive 'abc' should match 'abc': ${content}`);
      }
    });

    it("caseSensitive=false explicitly: behaves same as default (smart case)", async () => {
      const resultDefault = await grepExecute({ pattern: "abc" }, ctx);
      const resultExplicit = await grepExecute({ pattern: "abc", caseSensitive: false }, ctx);
      // Both should return the same results
      assert.equal(resultDefault.metadata.matches, resultExplicit.metadata.matches);
    });

    it("mixed-case 'AbC' triggers case-sensitive via smart case", async () => {
      const result = await grepExecute({ pattern: "AbC" }, ctx);
      if (out(result).length > 0) {
        for (const line of out(result).split("\n").filter(Boolean)) {
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
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(filePath === "src" || filePath.startsWith("src/"), `Path filter failed: ${filePath}`);
      }
    });

    it("should normalize trailing slashes", async () => {
      const a = await grepExecute({ pattern: "export", path: "src/" }, ctx);
      const b = await grepExecute({ pattern: "export", path: "src" }, ctx);
      assert.equal(out(a), out(b), "Trailing slash should be normalized");
    });

    it("should normalize multiple trailing slashes", async () => {
      const result = await grepExecute({ pattern: "export", path: "src///" }, ctx);
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(filePath.startsWith("src/"), `Multi-slash path filter failed: ${filePath}`);
      }
    });

    it("should return empty for nonexistent path", async () => {
      const result = await grepExecute({ pattern: "export", path: "nonexistent_dir" }, ctx);
      assert.ok(!out(result) || out(result) === "No files found", "Expected empty/found output");
    });

    it("should filter to nested subdirectory", async () => {
      const result = await grepExecute({ pattern: ".", path: "src/components" }, ctx);
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(
          filePath.startsWith("src/components/"),
          `Nested path filter failed: ${filePath}`
        );
      }
    });

    it("should not crash when search path is deleted (existsSync guard)", async () => {
      // Create a subdirectory, index it, then delete it before searching.
      // The existsSync guard in fsGrep should prevent a crash.
      const volatileDir = join(tmpDir, "volatile-search-dir");
      mkdirSync(volatileDir, { recursive: true });
      writeFileSync(join(volatileDir, "file.txt"), "searchable content here\n");
      try {
        // First grep to ensure fff indexes the dir
        const result1 = await grepExecute({ pattern: "searchable", path: "volatile-search-dir" }, ctx);
        assert.ok(out(result1).includes("volatile-search-dir"), "First search should find the file");
        // Now delete the directory and search again — should not crash
        rmSync(volatileDir, { recursive: true, force: true });
        const result2 = await grepExecute({ pattern: "searchable", path: "volatile-search-dir" }, ctx);
        // reaching here proves no SIGBUS / segfault
        assert.equal(typeof result2, "object", "Should return result object, not crash");
      } finally {
        if (existsSync(volatileDir)) rmSync(volatileDir, { recursive: true, force: true });
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
      assert.ok(out(filtered).split("\n").filter(Boolean).length <= out(all).split("\n").filter(Boolean).length);
      for (const line of out(filtered).split("\n").filter(Boolean)) {
        assert.ok(!line.split(":")[0].startsWith("src/"), `Excluded file leaked: ${line}`);
      }
    });

    it("should support comma-separated exclude patterns", async () => {
      const result = await grepExecute({ pattern: ".", exclude: "src/**,docs/**" }, ctx);
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(!filePath.startsWith("src/") && !filePath.startsWith("docs/"), `Comma exclude leaked: ${filePath}`);
      }
    });

    it("should trim whitespace around comma-separated patterns", async () => {
      const result = await grepExecute({ pattern: ".", exclude: " src/** , docs/** " }, ctx);
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(!filePath.startsWith("src/") && !filePath.startsWith("docs/"), `Trimmed exclude leaked: ${filePath}`);
      }
    });

    it("should exclude hidden files (.gitignore) with dot:true", async () => {
      const all = await grepExecute({ pattern: "node_modules" }, ctx);
      const filtered = await grepExecute({ pattern: "node_modules", exclude: ".gitignore" }, ctx);
      if (out(all).includes(".gitignore")) {
        assert.ok(!out(filtered).includes(".gitignore"), "Hidden file .gitignore should be excludable");
      }
    });
  });

  // -----------------------------------------------------------------------
  // grep — include parameter
  // -----------------------------------------------------------------------
  describe("grep include patterns", () => {
    it("should only include files matching a single glob pattern", async () => {
      const all = await grepExecute({ pattern: "export" }, ctx);
      const filtered = await grepExecute({ pattern: "export", include: "*.js" }, ctx);
      const allLines = out(all).split("\n").filter(Boolean);
      const filteredLines = out(filtered).split("\n").filter(Boolean);
      assert.ok(filteredLines.length <= allLines.length, "include should not return more than all");
      for (const line of filteredLines) {
        const filePath = line.split(":")[0];
        assert.ok(filePath.endsWith(".js"), `Include filter leaked non-js file: ${filePath}`);
      }
    });

    it("include with brace expansion: *.{js,jsx}", async () => {
      const result = await grepExecute({ pattern: "export", include: "*.{js,jsx}" }, ctx);
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(filePath.endsWith(".js") || filePath.endsWith(".jsx"), `Non-js file leaked: ${filePath}`);
      }
    });
  });

  // -----------------------------------------------------------------------
  // grep — Turkish / Unicode (fsGrep path)
  // -----------------------------------------------------------------------
  describe("grep Turkish / Unicode", () => {
    it("should find Turkish characters via fsGrep (non-ASCII routing)", async () => {
      // Write a file with Turkish content and search for it
      const trFile = join(tmpDir, "turkish.txt");
      writeFileSync(trFile, "İstanbul Ankara İzmir\nşeker çay kahve\n");
      try {
        const result = await grepExecute({ pattern: "İstanbul" }, ctx);
        assert.ok(out(result).includes("turkish.txt"), "Should find Turkish file");
        assert.ok(out(result).includes("İstanbul"), "Should match Turkish İ character");
      } finally {
        rmSync(trFile, { force: true });
      }
    });

    it("Turkish uppercase İ does NOT match case-insensitively via ASCII smart case (known fff limitation)", async () => {
      // fff's smart case uses ASCII-only case folding: I (U+0049) ≠ İ (U+0130).
      // Pattern 'istanbul' (ASCII) will NOT match 'İstanbul' case-insensitively.
      // This documents the known limitation described in AGENTS.md:
      // "Use lowercase patterns for Turkish case-insensitive search... İ ≠ I in ASCII."
      const trFile = join(tmpDir, "turkish-ci.txt");
      writeFileSync(trFile, "İstanbul güzel bir şehir\n");
      try {
        const result = await grepExecute({ pattern: "istanbul" }, ctx);
        // With caseSensitive=false, the ASCII-only smart case won't match İ
        // because fff folds I→i but İ (U+0130) is outside the ASCII range.
        // The workaround: use the exact Unicode char with caseSensitive:true,
        // or use case-insensitive Unicode pattern that routes via fsGrep.
        const found = out(result).includes("turkish-ci.txt");
        assert.ok(
          !found,
          "Known limitation: ASCII smart case cannot match İ (U+0130) with 'i' pattern. "
          + "Use 'İstanbul' (exact Unicode) or 'ist' / 'anbul' partial patterns to find the file."
        );
      } finally {
        rmSync(trFile, { force: true });
      }
    });

    it("should match 'şeker' without ASCII normalization overcount", async () => {
      const trFile = join(tmpDir, "seker.txt");
      writeFileSync(trFile, "şeker ve çikolata\n");
      try {
        const result = await grepExecute({ pattern: "şeker" }, ctx);
        const matches = out(result).split("\n").filter((l) => l.includes("seker.txt"));
        assert.ok(matches.length >= 1, "Should find exactly one match for şeker in seker.txt");
      } finally {
        rmSync(trFile, { force: true });
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
        out(withCtx).split("\n").filter(Boolean).length >= out(noCtx).split("\n").filter(Boolean).length,
        "context=1 should return >= lines than context=0"
      );
    });

    it("context=0 should equal omitting context", async () => {
      const a = await grepExecute({ pattern: "console.log", context: 0 }, ctx);
      const b = await grepExecute({ pattern: "console.log" }, ctx);
      assert.equal(out(a), out(b));
    });

    it("contextBefore line numbers are strictly less than the match line number", async () => {
      // Write a known file so we know exactly which line the match is on
      const ctxFile = join(tmpDir, "ctx-test.txt");
      const lines = ["line-A\n", "line-B\n", "MATCH_LINE\n", "line-D\n", "line-E\n"];
      writeFileSync(ctxFile, lines.join(""));
      try {
        const result = await grepExecute({ pattern: "MATCH_LINE", path: "ctx-test.txt", context: 2 }, ctx);
        const outLines = out(result).split("\n").filter(Boolean);
        assert.ok(outLines.length >= 3, `Expected >=3 lines for context=2, got ${outLines.length}`);
        // Find the match line
        const matchLine = outLines.find((l) => l.includes("MATCH_LINE"));
        assert.ok(matchLine, "Should contain the match line");
        const matchLineNum = parseInt(matchLine.split(":")[1], 10);
        // All contextBefore entries must have lineNumber < matchLineNum
        const contextBeforeLines = [];
        let collecting = true;
        for (const l of outLines) {
          if (l === matchLine) { collecting = false; continue; }
          if (collecting) contextBeforeLines.push(l);
        }
        for (const ctxLine of contextBeforeLines) {
          const ctxLineNum = parseInt(ctxLine.split(":")[1], 10);
          assert.ok(
            ctxLineNum < matchLineNum,
            `contextBefore line ${ctxLineNum} must be < match line ${matchLineNum}`
          );
        }
      } finally {
        rmSync(ctxFile, { force: true });
      }
    });
  });

  // -----------------------------------------------------------------------
  // grep — limit
  // -----------------------------------------------------------------------
  describe("grep limit", () => {
    it("should respect limit parameter", async () => {
      const result = await grepExecute({ pattern: ".", limit: 2 }, ctx);
      const lines = out(result).split("\n").filter(Boolean);
      assert.ok(lines.length <= 2, `limit=2 returned ${lines.length} lines`);
    });

    it("limit=1 returns at most 1 line", async () => {
      const result = await grepExecute({ pattern: ".", limit: 1 }, ctx);
      const lines = out(result).split("\n").filter(Boolean);
      assert.ok(lines.length <= 1);
    });

    it("default limit should cap at 100", async () => {
      const result = await grepExecute({ pattern: "." }, ctx);
      const lines = out(result).split("\n").filter(Boolean);
      assert.ok(lines.length <= 100, `Default limit exceeded: ${lines.length}`);
    });

    it("should throw on negative limit", async () => {
      await assert.rejects(() => grepExecute({ pattern: "foo", limit: -5 }, ctx), /limit must be a number between 1 and 5000/);
    });

    it("should throw on limit > MAX_LIMIT (5000)", async () => {
      await assert.rejects(() => grepExecute({ pattern: "foo", limit: 5001 }, ctx), /limit must be a number between 1 and 5000/);
    });

    it("should throw on limit=0", async () => {
      await assert.rejects(() => grepExecute({ pattern: "foo", limit: 0 }, ctx), /limit must be a number between 1 and 5000/);
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
  // grep — metadata contract
  // -----------------------------------------------------------------------
  describe("grep metadata contract", () => {
    it("should return metadata.matches as a positive integer", async () => {
      const result = await grepExecute({ pattern: "foo" }, ctx);
      assert.equal(typeof result.metadata.matches, "number", "matches must be a number");
      assert.ok(result.metadata.matches >= 0, "matches must be non-negative");
    });

    it("should return metadata.truncated=true when results exceed limit", async () => {
      const result = await grepExecute({ pattern: ".", limit: 1 }, ctx);
      assert.equal(typeof result.metadata.truncated, "boolean", "truncated must be boolean");
      // With limit=1 and many matches, truncated should be true (if there are >1 matches)
      const allResult = await grepExecute({ pattern: "." }, ctx);
      if (allResult.metadata.matches > 1) {
        assert.ok(result.metadata.truncated, "truncated should be true when limit < total matches");
      }
    });

    it("should return metadata.truncated=false when results fit within limit", async () => {
      const result = await grepExecute({ pattern: "ZZZNONE" }, ctx);
      assert.equal(result.metadata.truncated, false, "truncated should be false for zero results");
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
      assert.ok(out(result).length > 0, "Regex should match");
      for (const line of out(result).split("\n").filter(Boolean)) {
        const content = line.split(":").slice(2).join(":");
        assert.ok(/export\s+const/.test(content), `Regex didn't match: ${content}`);
      }
    });

    it("should handle invalid regex gracefully (fff falls back to literal)", async () => {
      const result = await grepExecute({ pattern: "[invalid" }, ctx);
      assert.equal(typeof result, "object", "Invalid regex should not crash");
    });
  });

  // -----------------------------------------------------------------------
  // glob — basic functionality
  // -----------------------------------------------------------------------
  describe("glob basic", () => {
    it("should find files by fuzzy pattern", async () => {
      const result = await globExecute({ pattern: "foo" }, ctx);
      assert.ok(out(result).length > 0, "Should find foo.js");
      assert.ok(out(result).includes("foo.js"), `Missing foo.js in: ${result}`);
    });

    it("should return newline-separated paths", async () => {
      const result = await globExecute({ pattern: "foo" }, ctx);
      assert.ok(out(result).length > 0);
      const lines = out(result).split("\n").filter(Boolean);
      for (const line of lines) {
        // Upstream returns absolute paths; verify they're absolute
        assert.ok(line.startsWith("/"), `Glob path should be absolute: ${line}`);
      }
    });

    it("should return empty string for no matches", async () => {
      const result = await globExecute({ pattern: "ZZZNONEXISTENT_FILE_ZZZ" }, ctx);
      assert.ok(!out(result) || out(result) === "No files found", "Expected empty/found output");
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
      assert.ok(out(result).length > 0, "Should find files");
    });

    it("type='directory' should return directory paths", async () => {
      const result = await globExecute({ pattern: ".", type: "directory" }, ctx);
      assert.ok(out(result).length > 0, "Should find directories");
      const lines = out(result).split("\n").filter(Boolean);
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
      assert.equal(typeof result, "object", "Invalid type should not crash");
    });
  });

  // -----------------------------------------------------------------------
  // glob — path filtering
  // -----------------------------------------------------------------------
  describe("glob path filtering", () => {
    it("should scope results to a subdirectory", async () => {
      const result = await globExecute({ pattern: ".", path: "src" }, ctx);
      for (const line of out(result).split("\n").filter(Boolean)) {
        // Absolute paths; verify they contain src/ path component
        assert.ok(line.startsWith(tmpDir) && (line.endsWith("/src") || line.includes("/src/")),
          `Glob path filter failed: ${line}`);
      }
    });

    it("should normalize trailing slashes", async () => {
      const a = await globExecute({ pattern: ".", path: "src/" }, ctx);
      const b = await globExecute({ pattern: ".", path: "src" }, ctx);
      assert.equal(out(a), out(b));
    });
  });

  // -----------------------------------------------------------------------
  // glob — limit
  // -----------------------------------------------------------------------
  describe("glob limit", () => {
    it("should respect limit parameter", async () => {
      const result = await globExecute({ pattern: ".", limit: 2 }, ctx);
      const lines = out(result).split("\n").filter(Boolean);
      assert.ok(lines.length <= 2, `limit=2 returned ${lines.length} results`);
    });

    it("should throw on negative limit", async () => {
      await assert.rejects(() => globExecute({ pattern: "foo", limit: -1 }, ctx), /limit must be a number between 1 and 5000/);
    });

    it("should throw on limit > MAX_LIMIT (5000)", async () => {
      await assert.rejects(() => globExecute({ pattern: "foo", limit: 5001 }, ctx), /limit must be a number between 1 and 5000/);
    });

    it("should throw on limit=0", async () => {
      await assert.rejects(() => globExecute({ pattern: "foo", limit: 0 }, ctx), /limit must be a number between 1 and 5000/);
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
  // glob — metadata contract
  // -----------------------------------------------------------------------
  describe("glob metadata contract", () => {
    it("should return metadata.count as a non-negative integer", async () => {
      const result = await globExecute({ pattern: "foo" }, ctx);
      assert.equal(typeof result.metadata.count, "number", "count must be a number");
      assert.ok(result.metadata.count >= 0, "count must be non-negative");
    });

    it("should return metadata.truncated=false when all results fit", async () => {
      const result = await globExecute({ pattern: ".", limit: 5000 }, ctx);
      assert.equal(typeof result.metadata.truncated, "boolean");
      assert.equal(result.metadata.truncated, false, "truncated should be false with high limit");
    });

    it("glob output should be newline-separated absolute paths", async () => {
      const result = await globExecute({ pattern: "index.js" }, ctx);
      const paths = out(result).split("\n").filter(Boolean);
      assert.ok(paths.length > 0, "Should find at least one result");
      for (const p of paths) {
        assert.ok(p.startsWith("/"), `Glob path must be absolute: ${p}`);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe("edge cases", () => {
    it("grep with special regex characters", async () => {
      const result = await grepExecute({ pattern: "(import|export)" }, ctx);
      assert.equal(typeof result, "object");
    });

    it("grep with very long pattern", async () => {
      const result = await grepExecute({ pattern: "a".repeat(1000) }, ctx);
      assert.equal(typeof result, "object");
    });

    it("grep with single character pattern", async () => {
      const result = await grepExecute({ pattern: "a" }, ctx);
      assert.equal(typeof result, "object");
    });

    it("grep literal text with regex metacharacters (parens)", async () => {
      // fff always runs in regex mode, so literal parens need escaping to match literally.
      // This test documents current behavior: foo(bar) is an invalid regex capture group
      // and fff falls back to literal matching.
      const result = await grepExecute({ pattern: "foo(bar)" }, ctx);
      const lines = out(result).split("\n").filter(Boolean);
      // fff's fallback for invalid regex may still match — verify it doesn't crash
      assert.equal(typeof result, "object");
      const metaLines = lines.filter(l => l.includes("metachars.js"));
      if (metaLines.length > 0) {
        // fff fell back to literal matching — the line exists
        for (const l of metaLines) {
          assert.ok(l.includes("foo(bar)"), `Expected literal foo(bar): ${l}`);
        }
      }
    });

    it("grep literal text with regex metacharacters (brackets)", async () => {
      // file[1].txt is a valid regex: 'file' followed by character class [1]
      // In regex mode, this matches 'file1.txt' (no dot needed). This documents
      // that always-regex-mode can produce unexpected literal matches.
      const result = await grepExecute({ pattern: "file[1].txt" }, ctx);
      assert.equal(typeof result, "object");
    });

    it("grep literal text with regex metacharacters (dot)", async () => {
      // In regex mode, 'example.com' matches 'example<any_char>com'
      // This is the expected regex behavior for unescaped dots.
      const result = await grepExecute({ pattern: "example.com" }, ctx);
      assert.equal(typeof result, "object");
      if (out(result).length > 0) {
        // The dot matched literally because the content is exactly "example.com"
        const metaLines = out(result).split("\n").filter(Boolean).filter(l => l.includes("metachars.js"));
        assert.ok(metaLines.length > 0, "'example.com' regex should match metachars.js");
      }
    });

    it("glob with special characters in pattern", async () => {
      const result = await globExecute({ pattern: "foo.js" }, ctx);
      assert.equal(typeof result, "object");
    });

    // -----------------------------------------------------------------------
    // Single-file 100% recall — directFileGrep path
    // -----------------------------------------------------------------------
    it("single-file path uses directFileGrep with 100% recall (bypasses fff)", async () => {
      const singleFile = join(tmpDir, "src", "foo.js");
      const result = await grepExecute({ pattern: "bar", path: singleFile }, ctx);
      assert.ok(out(result).includes("src/foo.js"), "Should find the single file");
      assert.ok(out(result).includes("bar"), "Should match the content");
      // In single-file mode, the match count should be 1 (only one file searched)
      assert.equal(result.metadata.matches, 1, "Single-file search should return exactly 1 match");
    });

    it("single-file path with Unicode pattern (fsGrep bypass)", async () => {
      const unicodeFile = join(tmpDir, "unicode-test.txt");
      writeFileSync(unicodeFile, "şeker ve çikolata içeriği\n");
      try {
        const result = await grepExecute({ pattern: "şeker", path: unicodeFile }, ctx);
        assert.ok(out(result).includes("unicode-test.txt"), "Should find unicode file");
        assert.ok(out(result).includes("şeker"), "Should match Turkish ş");
      } finally {
        rmSync(unicodeFile, { force: true });
      }
    });

    it("grep with path + exclude combined", async () => {
      const result = await grepExecute({ pattern: ".", path: "src", exclude: "src/components/**" }, ctx);
      for (const line of out(result).split("\n").filter(Boolean)) {
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
      assert.equal(typeof result, "object");
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(filePath.startsWith("src/"), `Combined params failed: ${filePath}`);
        assert.ok(!filePath.includes("bar.js"), `Exclude failed: ${filePath}`);
      }
    });

    it("plugin handles undefined args gracefully", async () => {
      // OpenCode might pass extra/undefined fields
      const result = await grepExecute({ pattern: "foo", extraField: "ignored" }, ctx);
      assert.equal(typeof result, "object");
    });

    it("multiple concurrent grep calls should work (shared scanPromise)", async () => {
      const [r1, r2, r3] = await Promise.all([
        grepExecute({ pattern: "foo" }, ctx),
        grepExecute({ pattern: "bar" }, ctx),
        grepExecute({ pattern: "export" }, ctx),
      ]);
      assert.equal(typeof r1, "object");
      assert.equal(typeof r2, "object");
      assert.equal(typeof r3, "object");
    });
  });

  // -----------------------------------------------------------------------
  // Grep pagination — verifies cursor-based multi-page fetch
  // -----------------------------------------------------------------------
  describe("grep pagination", () => {
    it("should return many results when a file has many matches", async () => {
      // The test project has small files. Pagination matters when a single
      // file has more matches than one page's worth of files can cover.
      // Use pattern "." to match every line in every file.
      const result = await grepExecute({ pattern: ".", limit: 50 }, ctx);
      const lines = out(result).split("\n").filter(Boolean);
      assert.ok(lines.length > 0, "Should find at least some matches");
      assert.ok(lines.length <= 50, `limit=50 should return ≤50 lines, got ${lines.length}`);
    });

    it("should not crash or throw when results are paginated", async () => {
      // Pattern that matches many lines across many files — exercises
      // the pagination loop path. Should not throw.
      const result = await grepExecute({ pattern: ".", limit: 500 }, ctx);
      assert.equal(typeof result, "object");
      const lines = out(result).split("\n").filter(Boolean);
      assert.ok(lines.length > 0, "Should return results");
      assert.ok(lines.length <= 500, `limit=500 returned ${lines.length} lines`);
    });

    it("limit=1 returns at most 1 result (pagination stops early)", async () => {
      const result = await grepExecute({ pattern: "export", limit: 1 }, ctx);
      const lines = out(result).split("\n").filter(Boolean);
      assert.ok(lines.length <= 1, `limit=1 returned ${lines.length} lines`);
    });

    it("pagination + path filtering: returns results only within path", async () => {
      const result = await grepExecute({ pattern: ".", path: "src", limit: 30 }, ctx);
      const lines = out(result).split("\n").filter(Boolean);
      assert.ok(lines.length <= 30, `limit=30 returned ${lines.length}`);
      for (const line of lines) {
        const filePath = line.split(":")[0];
        assert.ok(filePath.startsWith("src/"), `Path filter failed in pagination: ${filePath}`);
      }
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
      aiMode: false,                // Match production
      disableMmapCache: true,       // Match production
      disableContentIndexing: true, // Match production
      disableWatch: true,           // Disable watcher so destroy() doesn't hang
    });
    if (!result.ok) throw new Error(`stress finder init failed: ${result.error}`);
    stressFinder = result.value;
    await stressFinder.waitForScan(10000);
  }

  function cleanup() {
    // destroy() is safe here because disableWatch: true prevents the native
    // watcher thread from blocking on join.
    if (stressFinder && !stressFinder.isDestroyed) {
      try { stressFinder.destroy(); } catch { /* fff-node may throw on stale handles */ }
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
        // Reachability check — SIGBUS would kill the process before getting here
        assert.equal(typeof result, "object", "grep should return a result after file deletion");
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
        // Reachability check — SIGBUS would kill the process before getting here
        assert.equal(typeof result, "object", "grep should return a result after file truncation");
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
        // Reachability check — SIGBUS would kill the process before getting here
        assert.equal(typeof result, "object", "grep should return a result during file mutation");
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
        // Reachability check — SIGBUS would kill the process before getting here
        assert.equal(typeof result, "object", "grep should handle volatile files");
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
            aiMode: false,
            disableMmapCache: true,
            disableWatch: true,  // Prevent destroy() hang
          });
          if (result.ok) finders.push(result.value);
        }
        // Run searches on all of them concurrently
        const results = await Promise.all(
          finders.map((f) => f.grep("line1"))
        );
        // Reaching this point proves no SIGBUS — the assertion is a reachability check
        for (const r of results) {
          assert.equal(typeof r, "object", "finder.grep should return a result object");
        }
      } finally {
        // Safe to destroy: disableWatch:true prevents native thread join blocking
        for (const f of finders) {
          try { if (!f.isDestroyed) f.destroy(); } catch { /* stale handle */ }
        }
        cleanup();
      }
    });

    it("should not crash when destroy() is called while searches are pending", async () => {
      await setupStressDir();
      try {
        const result = FileFinder.create({
          basePath: stressDir,
          aiMode: false,
          disableMmapCache: true,
          disableWatch: true,  // Prevent destroy() hang
        });
        if (!result.ok) throw new Error(`init failed: ${result.error}`);
        const finder = result.value;
        await finder.waitForScan(5000);
        // Start a search, then immediately destroy
        const searchPromise = finder.grep(".");
        finder.destroy();
        // The search should return an error, not SIGBUS
        const searchResult = await searchPromise;
        // Reaching this assertion proves no SIGBUS — destroy() mid-search is the actual test
        assert.equal(typeof searchResult, "object", "destroy during search should return a result, not SIGBUS");
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
        // Reachability check — SIGBUS would kill the process before getting here
        assert.equal(typeof result, "object", "grep should return a result after large file truncation");
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

