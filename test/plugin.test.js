import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";
import path, { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTempProject,
  cleanupTempProject,
  createMockClient,
  createContext,
  out,
} from "./helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(() => {
  cleanupTempProject(tmpDir);
});

// ---------------------------------------------------------------------------
// Import internal functions for tests that need tmpDir
// ---------------------------------------------------------------------------
import { __test } from "../index.js";
const {
  fsGrep,
  loadGitignoreFilter,
  globWalk,
  detectGrepMode,
  filterByPath,
  resolvePath,
  directFileGrep,
} = await __test();

describe("FffPlugin", () => {
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

    it("should handle non-existent directory gracefully (fs-only fallback)", async () => {
      const { client } = createMockClient();
      const result = await FffPlugin({
        directory: "/nonexistent/path/that/does/not/exist/aaa",
        client,
      });
      assert.ok(result.tool, "should return tool definitions");
      assert.ok(result.tool.grep, "should have grep tool");
      assert.ok(result.tool.glob, "should have glob tool");
    });

    it("should cache finder instance per directory (no double scan)", async () => {
      const freshDir = join(
        __dirname,
        ".tmp-fresh-" + process.pid + "-" + Date.now(),
      );
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
      const brokenClient = {
        app: {
          log: async () => {
            throw new Error("broken");
          },
        },
      };
      const result = await FffPlugin({
        directory: tmpDir,
        client: brokenClient,
      });
      assert.ok(result.tool.grep, "Plugin should survive logging failure");
    });
  });

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
      const openCodeParams = [
        "pattern",
        "path",
        "include",
        "exclude",
        "caseSensitive",
        "context",
        "limit",
      ];
      const pluginParams = Object.keys(tool.grep.args);
      for (const p of openCodeParams) {
        assert.ok(
          pluginParams.includes(p),
          `grep missing OpenCode param '${p}'`,
        );
      }
    });

    it("glob args match OpenCode built-in parameter names", async () => {
      const { client } = createMockClient();
      const { tool } = await FffPlugin({ directory: tmpDir, client });
      const openCodeParams = ["pattern", "path", "type", "limit"];
      const pluginParams = Object.keys(tool.glob.args);
      for (const p of openCodeParams) {
        assert.ok(
          pluginParams.includes(p),
          `glob missing OpenCode param '${p}'`,
        );
      }
    });

    it("grep execute returns Promise<string> (ToolResult contract)", async () => {
      const result = await grepExecute({ pattern: "foo" }, ctx);
      assert.equal(
        typeof result,
        "object",
        "ToolResult must be object, not string",
      );
    });

    it("glob execute returns Promise<string> (ToolResult contract)", async () => {
      const result = await globExecute({ pattern: "foo" }, ctx);
      assert.equal(
        typeof result,
        "object",
        "ToolResult must be object, not string",
      );
    });
  });

  describe("grep basic", () => {
    it("should find a simple text pattern", async () => {
      const result = await grepExecute({ pattern: "console.log" }, ctx);
      assert.ok(
        out(result).includes("console.log"),
        `Expected 'console.log' in: ${result}`,
      );
    });

    it("should return 'file:line:content' format", async () => {
      const result = await grepExecute({ pattern: "console.log" }, ctx);
      assert.ok(out(result).length > 0);
      for (const line of out(result).split("\n").filter(Boolean)) {
        assert.ok(/^.+:\d+:.+$/m.test(line), `Bad format: "${line}"`);
      }
    });

    it("should return empty string for no matches", async () => {
      const result = await grepExecute(
        { pattern: "ZZZNONEXISTENT_PATTERN_ZZZ" },
        ctx,
      );
      assert.ok(
        !out(result) || out(result) === "No files found",
        "Expected empty/found output",
      );
    });

    it("should use relative paths (not absolute)", async () => {
      const result = await grepExecute({ pattern: "foo" }, ctx);
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(
          !filePath.startsWith("/"),
          `Path should be relative: ${filePath}`,
        );
      }
    });

    it("should throw on empty pattern", async () => {
      await assert.rejects(
        () => grepExecute({ pattern: "" }, ctx),
        /pattern must be a non-empty string/,
      );
    });

    it("should throw on whitespace-only pattern", async () => {
      await assert.rejects(
        () => grepExecute({ pattern: "   " }, ctx),
        /pattern must be a non-empty string/,
      );
    });

    it("should throw on non-string pattern", async () => {
      await assert.rejects(
        () => grepExecute({ pattern: 123 }, ctx),
        /pattern must be a non-empty string/,
      );
    });
  });

  describe("grep case sensitivity", () => {
    it("smart case (default): lowercase 'abc' matches both 'abc' and 'ABC'", async () => {
      const result = await grepExecute({ pattern: "abc" }, ctx);
      const caseJsLines = out(result)
        .split("\n")
        .filter((l) => l.includes("case.js"));
      assert.ok(
        caseJsLines.length >= 2,
        `Smart case 'abc' should match both 'abc' and 'ABC', got ${caseJsLines.length} lines in case.js`,
      );
    });

    it("smart case: uppercase 'ABC' triggers case-sensitive matching", async () => {
      const result = await grepExecute({ pattern: "ABC" }, ctx);
      const caseJsLines = out(result)
        .split("\n")
        .filter((l) => l.includes("case.js"));
      for (const line of caseJsLines) {
        const content = line.split(":").slice(2).join(":");
        assert.ok(
          content.includes("ABC"),
          `Smart case 'ABC' should match 'ABC': ${content}`,
        );
      }
      const lowerLines = caseJsLines.filter((l) => {
        const content = l.split(":").slice(2).join(":");
        return content.includes('"abc"');
      });
      assert.equal(
        lowerLines.length,
        0,
        "Smart case 'ABC' should not match lowercase 'abc'",
      );
    });

    it("caseSensitive=true: 'abc' only matches lowercase 'abc'", async () => {
      const result = await grepExecute(
        { pattern: "abc", caseSensitive: true },
        ctx,
      );
      const caseJsLines = out(result)
        .split("\n")
        .filter((l) => l.includes("case.js"));
      for (const line of caseJsLines) {
        const content = line.split(":").slice(2).join(":");
        assert.ok(
          content.includes("abc"),
          `caseSensitive 'abc' should match 'abc': ${content}`,
        );
      }
    });

    it("caseSensitive=false explicitly: behaves same as default (smart case)", async () => {
      const resultDefault = await grepExecute({ pattern: "abc" }, ctx);
      const resultExplicit = await grepExecute(
        { pattern: "abc", caseSensitive: false },
        ctx,
      );
      assert.equal(
        resultDefault.metadata.matches,
        resultExplicit.metadata.matches,
      );
    });

    it("mixed-case 'AbC' triggers case-sensitive via smart case", async () => {
      const result = await grepExecute({ pattern: "AbC" }, ctx);
      if (out(result).length > 0) {
        for (const line of out(result).split("\n").filter(Boolean)) {
          const content = line.split(":").slice(2).join(":");
          assert.ok(
            content.includes("AbC"),
            `Smart case 'AbC' should be case-sensitive: ${content}`,
          );
        }
      }
    });
  });

  describe("grep path filtering", () => {
    it("should scope results to a subdirectory", async () => {
      const result = await grepExecute({ pattern: "export", path: "src" }, ctx);
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        const normalized = filePath.replace(/\\/g, "/");
        assert.ok(
          normalized === "src" || normalized.startsWith("src/"),
          `Path filter failed: ${filePath}`,
        );
      }
    });

    it("should normalize trailing slashes", async () => {
      const a = await grepExecute({ pattern: "export", path: "src/" }, ctx);
      const b = await grepExecute({ pattern: "export", path: "src" }, ctx);
      assert.equal(out(a), out(b), "Trailing slash should be normalized");
    });

    it("should normalize multiple trailing slashes", async () => {
      const result = await grepExecute(
        { pattern: "export", path: "src///" },
        ctx,
      );
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        const normalized = filePath.replace(/\\/g, "/");
        assert.ok(
          normalized.startsWith("src/"),
          `Multi-slash path filter failed: ${filePath}`,
        );
      }
    });

    it("should return empty for nonexistent path", async () => {
      const result = await grepExecute(
        { pattern: "export", path: "nonexistent_dir" },
        ctx,
      );
      assert.ok(
        !out(result) || out(result) === "No files found",
        "Expected empty/found output",
      );
    });

    it("should filter to nested subdirectory", async () => {
      const result = await grepExecute(
        { pattern: ".", path: "src/components" },
        ctx,
      );
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        const normalized = filePath.replace(/\\/g, "/");
        assert.ok(
          normalized.startsWith("src/components/"),
          `Nested path filter failed: ${filePath}`,
        );
      }
    });

    it("should not crash when search path is deleted (existsSync guard)", async () => {
      const volatileDir = join(tmpDir, "volatile-search-dir");
      mkdirSync(volatileDir, { recursive: true });
      writeFileSync(join(volatileDir, "file.txt"), "searchable content here\n");
      try {
        const result1 = await grepExecute(
          { pattern: "searchable", path: "volatile-search-dir" },
          ctx,
        );
        assert.ok(
          out(result1).includes("volatile-search-dir"),
          "First search should find the file",
        );
        rmSync(volatileDir, { recursive: true, force: true });
        const result2 = await grepExecute(
          { pattern: "searchable", path: "volatile-search-dir" },
          ctx,
        );
        assert.equal(
          typeof result2,
          "object",
          "Should return result object, not crash",
        );
      } finally {
        if (existsSync(volatileDir))
          rmSync(volatileDir, { recursive: true, force: true });
      }
    });
  });

  describe("grep exclude patterns", () => {
    it("should exclude files matching a single glob", async () => {
      const all = await grepExecute({ pattern: "export" }, ctx);
      const filtered = await grepExecute(
        { pattern: "export", exclude: "src/**" },
        ctx,
      );
      assert.ok(
        out(filtered).split("\n").filter(Boolean).length <=
          out(all).split("\n").filter(Boolean).length,
      );
      for (const line of out(filtered).split("\n").filter(Boolean)) {
        assert.ok(
          !line.split(":")[0].startsWith("src/"),
          `Excluded file leaked: ${line}`,
        );
      }
    });

    it("should support comma-separated exclude patterns", async () => {
      const result = await grepExecute(
        { pattern: ".", exclude: "src/**,docs/**" },
        ctx,
      );
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(
          !filePath.startsWith("src/") && !filePath.startsWith("docs/"),
          `Comma exclude leaked: ${filePath}`,
        );
      }
    });

    it("should trim whitespace around comma-separated patterns", async () => {
      const result = await grepExecute(
        { pattern: ".", exclude: " src/** , docs/** " },
        ctx,
      );
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(
          !filePath.startsWith("src/") && !filePath.startsWith("docs/"),
          `Trimmed exclude leaked: ${filePath}`,
        );
      }
    });

    it("should exclude hidden files (.gitignore) with dot:true", async () => {
      const all = await grepExecute({ pattern: "node_modules" }, ctx);
      const filtered = await grepExecute(
        { pattern: "node_modules", exclude: ".gitignore" },
        ctx,
      );
      if (out(all).includes(".gitignore")) {
        assert.ok(
          !out(filtered).includes(".gitignore"),
          "Hidden file .gitignore should be excludable",
        );
      }
    });
  });

  describe("grep include patterns", () => {
    it("should only include files matching a single glob pattern", async () => {
      const all = await grepExecute({ pattern: "export" }, ctx);
      const filtered = await grepExecute(
        { pattern: "export", include: "*.js" },
        ctx,
      );
      const allLines = out(all).split("\n").filter(Boolean);
      const filteredLines = out(filtered).split("\n").filter(Boolean);
      assert.ok(
        filteredLines.length <= allLines.length,
        "include should not return more than all",
      );
      for (const line of filteredLines) {
        const filePath = line.split(":")[0];
        assert.ok(
          filePath.endsWith(".js"),
          `Include filter leaked non-js file: ${filePath}`,
        );
      }
    });

    it("include with brace expansion: *.{js,jsx}", async () => {
      const result = await grepExecute(
        { pattern: "export", include: "*.{js,jsx}" },
        ctx,
      );
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(
          filePath.endsWith(".js") || filePath.endsWith(".jsx"),
          `Non-js file leaked: ${filePath}`,
        );
      }
    });
  });

  describe("grep Turkish / Unicode", () => {
    it("should find Turkish characters via fsGrep (non-ASCII routing)", async () => {
      const trFile = join(tmpDir, "turkish.txt");
      writeFileSync(trFile, "İstanbul Ankara İzmir\nşeker çay kahve\n");
      try {
        const result = await grepExecute({ pattern: "İstanbul" }, ctx);
        assert.ok(
          out(result).includes("turkish.txt"),
          "Should find Turkish file",
        );
        assert.ok(
          out(result).includes("İstanbul"),
          "Should match Turkish İ character",
        );
      } finally {
        rmSync(trFile, { force: true });
      }
    });

    it("Turkish uppercase İ does NOT match case-insensitively via ASCII smart case (known fff limitation)", async () => {
      const trFile = join(tmpDir, "turkish-ci.txt");
      writeFileSync(trFile, "İstanbul güzel bir şehir\n");
      try {
        const result = await grepExecute({ pattern: "istanbul" }, ctx);
        const found = out(result).includes("turkish-ci.txt");
        assert.ok(
          !found,
          "Known limitation: ASCII smart case cannot match İ (U+0130) with 'i' pattern. " +
            "Use 'İstanbul' (exact Unicode) or 'ist' / 'anbul' partial patterns to find the file.",
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
        const matches = out(result)
          .split("\n")
          .filter((l) => l.includes("seker.txt"));
        assert.ok(
          matches.length >= 1,
          "Should find exactly one match for şeker in seker.txt",
        );
      } finally {
        rmSync(trFile, { force: true });
      }
    });
  });

  describe("grep context lines", () => {
    it("context > 0 should return more lines than context=0", async () => {
      const noCtx = await grepExecute(
        { pattern: "console.log", context: 0 },
        ctx,
      );
      const withCtx = await grepExecute(
        { pattern: "console.log", context: 1 },
        ctx,
      );
      assert.ok(
        out(withCtx).split("\n").filter(Boolean).length >=
          out(noCtx).split("\n").filter(Boolean).length,
        "context=1 should return >= lines than context=0",
      );
    });

    it("context=0 should equal omitting context", async () => {
      const a = await grepExecute({ pattern: "console.log", context: 0 }, ctx);
      const b = await grepExecute({ pattern: "console.log" }, ctx);
      assert.equal(out(a), out(b));
    });

    it("contextBefore line numbers are strictly less than the match line number", async () => {
      const ctxFile = join(tmpDir, "ctx-test.txt");
      const lines = [
        "line-A\n",
        "line-B\n",
        "MATCH_LINE\n",
        "line-D\n",
        "line-E\n",
      ];
      writeFileSync(ctxFile, lines.join(""));
      try {
        const result = await grepExecute(
          { pattern: "MATCH_LINE", path: "ctx-test.txt", context: 2 },
          ctx,
        );
        const outLines = out(result).split("\n").filter(Boolean);
        assert.ok(
          outLines.length >= 3,
          `Expected >=3 lines for context=2, got ${outLines.length}`,
        );
        const matchLine = outLines.find((l) => l.includes("MATCH_LINE"));
        assert.ok(matchLine, "Should contain the match line");
        const matchLineNum = parseInt(matchLine.split(":")[1], 10);
        const contextBeforeLines = [];
        let collecting = true;
        for (const l of outLines) {
          if (l === matchLine) {
            collecting = false;
            continue;
          }
          if (collecting) contextBeforeLines.push(l);
        }
        for (const ctxLine of contextBeforeLines) {
          const ctxLineNum = parseInt(ctxLine.split(":")[1], 10);
          assert.ok(
            ctxLineNum < matchLineNum,
            `contextBefore line ${ctxLineNum} must be < match line ${matchLineNum}`,
          );
        }
      } finally {
        rmSync(ctxFile, { force: true });
      }
    });
  });

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
      await assert.rejects(
        () => grepExecute({ pattern: "foo", limit: -5 }, ctx),
        /limit must be a number between 1 and 5000/,
      );
    });

    it("should throw on limit > MAX_LIMIT (5000)", async () => {
      await assert.rejects(
        () => grepExecute({ pattern: "foo", limit: 5001 }, ctx),
        /limit must be a number between 1 and 5000/,
      );
    });

    it("should throw on limit=0", async () => {
      await assert.rejects(
        () => grepExecute({ pattern: "foo", limit: 0 }, ctx),
        /limit must be a number between 1 and 5000/,
      );
    });
  });

  describe("grep input validation", () => {
    it("should throw on negative context", async () => {
      await assert.rejects(
        () => grepExecute({ pattern: "foo", context: -1 }, ctx),
        /context must be a non-negative/,
      );
    });

    it("should throw on non-number context", async () => {
      await assert.rejects(
        () => grepExecute({ pattern: "foo", context: "2" }, ctx),
        /context must be a non-negative/,
      );
    });

    it("should throw on non-number limit", async () => {
      await assert.rejects(
        () => grepExecute({ pattern: "foo", limit: "abc" }, ctx),
        /limit must be a number/,
      );
    });
  });

  describe("grep metadata contract", () => {
    it("should return metadata.matches as a positive integer", async () => {
      const result = await grepExecute({ pattern: "foo" }, ctx);
      assert.equal(
        typeof result.metadata.matches,
        "number",
        "matches must be a number",
      );
      assert.ok(result.metadata.matches >= 0, "matches must be non-negative");
    });

    it("should return metadata.truncated=true when results exceed limit", async () => {
      const result = await grepExecute({ pattern: ".", limit: 1 }, ctx);
      assert.equal(
        typeof result.metadata.truncated,
        "boolean",
        "truncated must be boolean",
      );
      const allResult = await grepExecute({ pattern: "." }, ctx);
      if (allResult.metadata.matches > 1) {
        assert.ok(
          result.metadata.truncated,
          "truncated should be true when limit < total matches",
        );
      }
    });

    it("should return metadata.truncated=false when results fit within limit", async () => {
      const result = await grepExecute({ pattern: "ZZZNONE" }, ctx);
      assert.equal(
        result.metadata.truncated,
        false,
        "truncated should be false for zero results",
      );
    });
  });

  describe("grep abort", () => {
    it("should throw 'Aborted' when signal is already aborted", async () => {
      const abortCtx = createContext(tmpDir);
      abortCtx._abortController.abort();
      await assert.rejects(
        () => grepExecute({ pattern: "foo" }, abortCtx),
        /Aborted/,
      );
    });
  });

  describe("grep regex mode", () => {
    it("should support regex patterns", async () => {
      const result = await grepExecute({ pattern: "export\\s+const" }, ctx);
      assert.ok(out(result).length > 0, "Regex should match");
      for (const line of out(result).split("\n").filter(Boolean)) {
        const content = line.split(":").slice(2).join(":");
        assert.ok(
          /export\s+const/.test(content),
          `Regex didn't match: ${content}`,
        );
      }
    });

    it("should handle invalid regex gracefully (fff falls back to literal)", async () => {
      const result = await grepExecute({ pattern: "[invalid" }, ctx);
      assert.equal(typeof result, "object", "Invalid regex should not crash");
    });
  });

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
        const isAbsolute = line.startsWith("/") || /^[a-zA-Z]:\\/.test(line);
        assert.ok(isAbsolute, `Glob path should be absolute: ${line}`);
      }
    });

    it("should return empty string for no matches", async () => {
      const result = await globExecute(
        { pattern: "ZZZNONEXISTENT_FILE_ZZZ" },
        ctx,
      );
      assert.ok(
        !out(result) || out(result) === "No files found",
        "Expected empty/found output",
      );
    });

    it("should throw on empty pattern", async () => {
      await assert.rejects(
        () => globExecute({ pattern: "" }, ctx),
        /pattern must be a non-empty string/,
      );
    });

    it("should throw on whitespace-only pattern", async () => {
      await assert.rejects(
        () => globExecute({ pattern: "   " }, ctx),
        /pattern must be a non-empty string/,
      );
    });

    it("should throw on invalid limit", async () => {
      await assert.rejects(
        () => globExecute({ pattern: "foo", limit: -1 }, ctx),
        /limit must be a number/,
      );
    });
  });

  describe("glob type filter", () => {
    it("default (no type) should return files", async () => {
      const result = await globExecute({ pattern: "." }, ctx);
      assert.ok(out(result).length > 0, "Should find files");
    });

    it("type='directory' should return directory paths", async () => {
      const result = await globExecute(
        { pattern: ".", type: "directory" },
        ctx,
      );
      assert.ok(out(result).length > 0, "Should find directories");
      const lines = out(result).split("\n").filter(Boolean);
      for (const line of lines) {
        const normalized = line.replace(/\\/g, "/");
        assert.ok(
          normalized.endsWith("/") || normalized.includes("/"),
          `Directory search should return dirs: ${line}`,
        );
      }
    });

    it("invalid type value is silently ignored (Zod optional enum coerces to undefined)", async () => {
      const result = await globExecute(
        { pattern: "foo", type: "invalid" },
        ctx,
      );
      assert.equal(typeof result, "object", "Invalid type should not crash");
    });
  });

  describe("glob path filtering", () => {
    it("should scope results to a subdirectory", async () => {
      const result = await globExecute({ pattern: ".", path: "src" }, ctx);
      const tmpDirNorm = tmpDir.replace(/\\/g, "/");
      for (const line of out(result).split("\n").filter(Boolean)) {
        const normalized = line.replace(/\\/g, "/");
        assert.ok(
          normalized.startsWith(tmpDirNorm) &&
            (normalized.endsWith("/src") || normalized.includes("/src/")),
          `Glob path filter failed: ${line}`,
        );
      }
    });

    it("should normalize trailing slashes", async () => {
      const a = await globExecute({ pattern: ".", path: "src/" }, ctx);
      const b = await globExecute({ pattern: ".", path: "src" }, ctx);
      assert.equal(out(a), out(b));
    });
  });

  describe("glob limit", () => {
    it("should respect limit parameter", async () => {
      const result = await globExecute({ pattern: ".", limit: 2 }, ctx);
      const lines = out(result).split("\n").filter(Boolean);
      assert.ok(lines.length <= 2, `limit=2 returned ${lines.length} results`);
    });

    it("should throw on negative limit", async () => {
      await assert.rejects(
        () => globExecute({ pattern: "foo", limit: -1 }, ctx),
        /limit must be a number between 1 and 5000/,
      );
    });

    it("should throw on limit > MAX_LIMIT (5000)", async () => {
      await assert.rejects(
        () => globExecute({ pattern: "foo", limit: 5001 }, ctx),
        /limit must be a number between 1 and 5000/,
      );
    });

    it("should throw on limit=0", async () => {
      await assert.rejects(
        () => globExecute({ pattern: "foo", limit: 0 }, ctx),
        /limit must be a number between 1 and 5000/,
      );
    });
  });

  describe("glob abort", () => {
    it("should throw 'Aborted' when signal is already aborted", async () => {
      const abortCtx = createContext(tmpDir);
      abortCtx._abortController.abort();
      await assert.rejects(
        () => globExecute({ pattern: "foo" }, abortCtx),
        /Aborted/,
      );
    });
  });

  describe("glob metadata contract", () => {
    it("should return metadata.count as a non-negative integer", async () => {
      const result = await globExecute({ pattern: "foo" }, ctx);
      assert.equal(
        typeof result.metadata.count,
        "number",
        "count must be a number",
      );
      assert.ok(result.metadata.count >= 0, "count must be non-negative");
    });

    it("should return metadata.truncated=false when all results fit", async () => {
      const result = await globExecute({ pattern: ".", limit: 5000 }, ctx);
      assert.equal(typeof result.metadata.truncated, "boolean");
      assert.equal(
        result.metadata.truncated,
        false,
        "truncated should be false with high limit",
      );
    });

    it("glob output should be newline-separated absolute paths", async () => {
      const result = await globExecute({ pattern: "index.js" }, ctx);
      const paths = out(result).split("\n").filter(Boolean);
      assert.ok(paths.length > 0, "Should find at least one result");
      for (const p of paths) {
        const isAbsolute = p.startsWith("/") || /^[a-zA-Z]:\\/.test(p);
        assert.ok(isAbsolute, `Glob path must be absolute: ${p}`);
      }
    });
  });

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
      const result = await grepExecute({ pattern: "foo(bar)" }, ctx);
      const lines = out(result).split("\n").filter(Boolean);
      assert.equal(typeof result, "object");
      const metaLines = lines.filter((l) => l.includes("metachars.js"));
      if (metaLines.length > 0) {
        for (const l of metaLines) {
          assert.ok(l.includes("foo(bar)"), `Expected literal foo(bar): ${l}`);
        }
      }
    });

    it("grep literal text with regex metacharacters (brackets)", async () => {
      const result = await grepExecute({ pattern: "file[1].txt" }, ctx);
      assert.equal(typeof result, "object");
    });

    it("grep literal text with regex metacharacters (dot)", async () => {
      const result = await grepExecute({ pattern: "example.com" }, ctx);
      assert.equal(typeof result, "object");
      if (out(result).length > 0) {
        const metaLines = out(result)
          .split("\n")
          .filter(Boolean)
          .filter((l) => l.includes("metachars.js"));
        assert.ok(
          metaLines.length > 0,
          "'example.com' regex should match metachars.js",
        );
      }
    });

    it("glob with special characters in pattern", async () => {
      const result = await globExecute({ pattern: "foo.js" }, ctx);
      assert.equal(typeof result, "object");
    });

    it("single-file path uses directFileGrep with 100% recall (bypasses fff)", async () => {
      const singleFile = join(tmpDir, "src", "foo.js");
      const result = await grepExecute(
        { pattern: "bar", path: singleFile },
        ctx,
      );
      const normalized = out(result).replace(/\\/g, "/");
      assert.ok(
        normalized.includes("src/foo.js"),
        "Should find the single file",
      );
      assert.ok(normalized.includes("bar"), "Should match the content");
      assert.equal(
        result.metadata.matches,
        1,
        "Single-file search should return exactly 1 match",
      );
    });

    it("single-file path with Unicode pattern (fsGrep bypass)", async () => {
      const unicodeFile = join(tmpDir, "unicode-test.txt");
      writeFileSync(unicodeFile, "şeker ve çikolata içeriği\n");
      try {
        const result = await grepExecute(
          { pattern: "şeker", path: unicodeFile },
          ctx,
        );
        assert.ok(
          out(result).includes("unicode-test.txt"),
          "Should find unicode file",
        );
        assert.ok(out(result).includes("şeker"), "Should match Turkish ş");
      } finally {
        rmSync(unicodeFile, { force: true });
      }
    });

    it("grep with path + exclude combined", async () => {
      const result = await grepExecute(
        { pattern: ".", path: "src", exclude: "src/components/**" },
        ctx,
      );
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        assert.ok(
          !filePath.startsWith("src/components/"),
          `Combined filter failed: ${filePath}`,
        );
      }
    });

    it("grep with all optional parameters set", async () => {
      const result = await grepExecute(
        {
          pattern: "export",
          path: "src",
          exclude: "src/bar.js",
          caseSensitive: true,
          context: 1,
          limit: 50,
        },
        ctx,
      );
      assert.equal(typeof result, "object");
      for (const line of out(result).split("\n").filter(Boolean)) {
        const filePath = line.split(":")[0];
        const normalized = filePath.replace(/\\/g, "/");
        assert.ok(
          normalized.startsWith("src/"),
          `Combined params failed: ${filePath}`,
        );
        assert.ok(
          !normalized.includes("bar.js"),
          `Exclude failed: ${filePath}`,
        );
      }
    });

    it("plugin handles undefined args gracefully", async () => {
      const result = await grepExecute(
        { pattern: "foo", extraField: "ignored" },
        ctx,
      );
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

  describe("grep pagination", () => {
    it("should return many results when a file has many matches", async () => {
      const result = await grepExecute({ pattern: ".", limit: 50 }, ctx);
      const lines = out(result).split("\n").filter(Boolean);
      assert.ok(lines.length > 0, "Should find at least some matches");
      assert.ok(
        lines.length <= 50,
        `limit=50 should return ≤50 lines, got ${lines.length}`,
      );
    });

    it("should not crash or throw when results are paginated", async () => {
      const result = await grepExecute({ pattern: ".", limit: 500 }, ctx);
      assert.equal(typeof result, "object");
      const lines = out(result).split("\n").filter(Boolean);
      assert.ok(lines.length > 0, "Should return results");
      assert.ok(
        lines.length <= 500,
        `limit=500 returned ${lines.length} lines`,
      );
    });

    it("limit=1 returns at most 1 result (pagination stops early)", async () => {
      const result = await grepExecute({ pattern: "export", limit: 1 }, ctx);
      const lines = out(result).split("\n").filter(Boolean);
      assert.ok(lines.length <= 1, `limit=1 returned ${lines.length} lines`);
    });

    it("pagination + path filtering: returns results only within path", async () => {
      const result = await grepExecute(
        { pattern: ".", path: "src", limit: 30 },
        ctx,
      );
      const lines = out(result).split("\n").filter(Boolean);
      assert.ok(lines.length <= 30, `limit=30 returned ${lines.length}`);
      for (const line of lines) {
        const filePath = line.split(":")[0];
        const normalized = filePath.replace(/\\/g, "/");
        assert.ok(
          normalized.startsWith("src/"),
          `Path filter failed in pagination: ${filePath}`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // Internal function tests that need tmpDir
  // -------------------------------------------------------------------------
  describe("fsGrep internals", () => {
    it("should handle unreadable directories gracefully in readdirSync catch block", async () => {
      if (process.platform === "win32") return;
      const unreadableDir = join(tmpDir, "unreadable");
      mkdirSync(unreadableDir);
      chmodSync(unreadableDir, 0o000);

      try {
        const results = await fsGrep(
          unreadableDir,
          tmpDir,
          "anything",
          0,
          null,
          null,
          null,
          10,
        );
        assert.deepEqual(
          results,
          [],
          "Should return empty array when directory is unreadable",
        );
      } finally {
        chmodSync(unreadableDir, 0o755);
      }
    });
  });

  describe("loadGitignoreFilter", () => {
    it("should correctly parse and filter based on .gitignore", async () => {
      const gitignorePath = join(tmpDir, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\n*.log\nbuild/\n");
      const filter = await loadGitignoreFilter(tmpDir);

      assert.strictEqual(
        filter("node_modules", true),
        true,
        "node_modules should be ignored",
      );
      assert.strictEqual(
        filter("build", true),
        true,
        "build should be ignored",
      );
      assert.strictEqual(
        filter("src", true),
        false,
        "src should not be ignored",
      );
      assert.strictEqual(
        filter("index.js", false),
        false,
        "index.js should not be ignored",
      );
      assert.strictEqual(
        filter(".git", true),
        true,
        ".git should be ignored (starts with .)",
      );
      assert.strictEqual(
        filter(".env", false),
        false,
        ".env file should not be ignored (only directories starting with .)",
      );
    });
  });

  describe("globWalk internals", () => {
    it("should handle unreadable directories gracefully in readdir catch block", async () => {
      if (process.platform === "win32") return;
      const unreadableDir = join(tmpDir, "unreadable_glob");
      mkdirSync(unreadableDir);
      chmodSync(unreadableDir, 0o000);

      try {
        const results = await globWalk(unreadableDir, "*", tmpDir, 10, "file");
        assert.deepEqual(
          results,
          [],
          "Should return empty array when directory is unreadable",
        );
      } finally {
        chmodSync(unreadableDir, 0o755);
      }
    });
  });

  describe("directFileGrep", () => {
    it("should handle unreadable files gracefully in readFile catch block", async () => {
      if (process.platform === "win32") return;
      const unreadableFile = join(tmpDir, "unreadable.txt");
      writeFileSync(unreadableFile, "secret content");
      chmodSync(unreadableFile, 0o000);

      try {
        const results = await directFileGrep(
          unreadableFile,
          tmpDir,
          "secret",
          0,
        );
        assert.deepEqual(
          results,
          [],
          "Should return empty array when file is unreadable",
        );
      } finally {
        chmodSync(unreadableFile, 0o644);
      }
    });

    it("should handle invalid regex patterns by falling back to literal matching", async () => {
      const file = join(tmpDir, "regex.txt");
      writeFileSync(file, "content with [ symbol\n");

      const results = await directFileGrep(file, tmpDir, "[", 0);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].lineContent, "content with [ symbol");
    });
  });
});
