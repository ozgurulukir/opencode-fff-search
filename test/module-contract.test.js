import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Module Contract Tests
//
// Validates the complete public API of the opencode-fff-search plugin.
// Covers default export, named exports, tool definitions, sub-module exports,
// and the getLegacyPlugins() safety contract (no stray function exports).
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
let _dirCounter = 0;

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

function createTempDir() {
  _dirCounter++;
  const dir = join(__dirname, `.tmp-module-contract-${process.pid}-${_dirCounter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), "const foo = 'bar';\n");
  writeFileSync(join(dir, "readme.md"), "# Test\n");
  return dir;
}

function cleanupTempDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ===========================================================================
// 1. Top-level module namespace (index.js)
// ===========================================================================
describe("module contract - index.js", () => {
  let mod;
  let testApi;

  before(async () => {
    mod = await import("../index.js");
    testApi = await mod.__test();
  });

  describe("default export", () => {
    it("should be defined", () => {
      assert.ok(mod.default, "default export must exist");
    });

    it("should be a function", () => {
      assert.strictEqual(typeof mod.default, "function");
    });

    it("should be an async function (returns a promise)", () => {
      const client = { app: { log: async () => {} } };
      const result = mod.default({ directory: "/tmp", client });
      assert.ok(result instanceof Promise, "default export must return a Promise");
    });

    it("should return { tool: { grep, glob } } on success", async () => {
      const client = { app: { log: async () => {} } };
      const result = await mod.default({ directory: "/tmp", client });
      assert.ok(result, "result must be truthy");
      assert.ok(typeof result === "object", "result must be an object");
      assert.ok(result.tool, "result.tool must exist");
      assert.ok(result.tool.grep, "result.tool.grep must exist");
      assert.ok(result.tool.glob, "result.tool.glob must exist");
    });
  });

  describe("named exports", () => {
    it("should export server as the same function as default", () => {
      assert.ok(mod.server, "named export server must exist");
      assert.strictEqual(mod.server, mod.default, "server must be same reference as default");
    });

    it("should export __test as an async function", () => {
      assert.ok(mod.__test, "named export __test must exist");
      assert.strictEqual(typeof mod.__test, "function");
      assert.ok(mod.__test() instanceof Promise, "__test() must return a Promise");
    });

    it("should export exactly 2 named items: server and __test", () => {
      const exportNames = Object.keys(mod).filter((k) => k !== "default");
      assert.deepStrictEqual(
        [...exportNames].sort(),
        ["__test", "server"].sort(),
        `Expected only [server, __test] named exports, got: ${JSON.stringify(exportNames)}`,
      );
    });

    it("should NOT have stray function exports that trigger getLegacyPlugins()", () => {
      const fnExports = Object.entries(mod).filter(
        ([key, val]) => typeof val === "function" && key !== "default",
      );
      const strayFn = fnExports.filter(([k]) => k !== "server" && k !== "__test");
      assert.strictEqual(
        strayFn.length, 0,
        `Stray function exports: ${strayFn.map(([k]) => k).join(", ")}`,
      );
    });
  });

  describe("__test() API", () => {
    it("should return an object", () => {
      assert.ok(testApi);
      assert.strictEqual(typeof testApi, "object");
    });

    it("should contain all expected internal functions", () => {
      const expected = [
        "loadGitignoreFilter", "detectGrepMode", "filterByPath",
        "resolvePath", "resolvePathUnchecked", "isPathOutside",
        "getRelativePath", "isPathInsideIndex", "directFileGrep",
        "fsGrep", "globWalk", "safeLog", "waitForScan", "debugLog",
        "parsePatterns", "compilePatterns", "shouldIncludeFile",
        "shouldIncludeCompiled", "applyMinimatchFilter", "searchInFile",
        "fetchGrepPages", "lazyFff", "performGrepRouting",
      ];

      for (const name of expected) {
        assert.ok(name in testApi, `__test() must export ${name}`);
        assert.strictEqual(
          typeof testApi[name], "function",
          `${name} must be a function, got ${typeof testApi[name]}`,
        );
      }

      const actualKeys = Object.keys(testApi).sort();
      assert.strictEqual(
        actualKeys.length, expected.length,
        `Expected ${expected.length} functions, got ${actualKeys.length}. ` +
        JSON.stringify({
          unexpected: actualKeys.filter((k) => !expected.includes(k)),
          missing: expected.filter((k) => !actualKeys.includes(k)),
        }),
      );
    });
  });
});

// ===========================================================================
// 2. Tool definition shape (grep and glob)
// ===========================================================================
describe("module contract - tool definitions", () => {
  let toolResult;

  before(async () => {
    const mod = await import("../index.js");
    toolResult = await mod.default({
      directory: "/tmp",
      client: { app: { log: async () => {} } },
    });
  });

  describe("grep tool", () => {
    let grep;

    before(() => {
      grep = toolResult.tool.grep;
    });

    it("should have a description string", () => {
      assert.ok(grep.description, "grep.description must exist");
      assert.strictEqual(typeof grep.description, "string");
      assert.ok(grep.description.length > 0, "grep.description must not be empty");
    });

    it("should have an args object with pattern, path, include, exclude, caseSensitive, context, limit", () => {
      assert.ok(grep.args, "grep.args must exist");
      assert.strictEqual(typeof grep.args, "object");

      const expectedArgs = ["pattern", "path", "include", "exclude", "caseSensitive", "context", "limit"];
      for (const argName of expectedArgs) {
        assert.ok(argName in grep.args, `grep.args must contain ${argName}`);
      }

      const actualArgs = Object.keys(grep.args).sort();
      assert.deepStrictEqual(
        actualArgs, [...expectedArgs].sort(),
        `Unexpected grep args: ${JSON.stringify(actualArgs)}`,
      );
    });

    it("should have pattern as a required string schema", () => {
      const schema = grep.args.pattern;
      assert.ok(schema, "pattern schema must exist");
      assert.strictEqual(typeof schema.describe, "function");
    });

    it("should have all optional args with describe()", () => {
      const optionalArgs = ["path", "include", "exclude", "caseSensitive", "context", "limit"];
      for (const argName of optionalArgs) {
        const schema = grep.args[argName];
        assert.ok(schema, `${argName} schema must exist`);
        assert.strictEqual(typeof schema.describe, "function");
      }
    });

    it("should have an execute function with 2 params (args, context)", () => {
      assert.ok(grep.execute, "grep.execute must exist");
      assert.strictEqual(typeof grep.execute, "function");
      assert.strictEqual(grep.execute.length, 2, "grep.execute should accept 2 parameters");
    });
  });

  describe("glob tool", () => {
    let glob;

    before(() => {
      glob = toolResult.tool.glob;
    });

    it("should have a description string", () => {
      assert.ok(glob.description, "glob.description must exist");
      assert.strictEqual(typeof glob.description, "string");
      assert.ok(glob.description.length > 0);
    });

    it("should have an args object with pattern, path, type, limit", () => {
      assert.ok(glob.args, "glob.args must exist");
      assert.strictEqual(typeof glob.args, "object");

      const expectedArgs = ["pattern", "path", "type", "limit"];
      for (const argName of expectedArgs) {
        assert.ok(argName in glob.args, `glob.args must contain ${argName}`);
      }

      const actualArgs = Object.keys(glob.args).sort();
      assert.deepStrictEqual(
        actualArgs, [...expectedArgs].sort(),
        `Unexpected glob args: ${JSON.stringify(actualArgs)}`,
      );
    });

    it("should have pattern as a required string schema", () => {
      const schema = glob.args.pattern;
      assert.ok(schema, "pattern schema must exist");
      assert.strictEqual(typeof schema.describe, "function");
    });

    it("should have optional args (path, type, limit) with describe()", () => {
      const optionalArgs = ["path", "type", "limit"];
      for (const argName of optionalArgs) {
        const schema = glob.args[argName];
        assert.ok(schema, `${argName} schema must exist`);
        assert.strictEqual(typeof schema.describe, "function");
      }
    });

    it("should have an execute function with 2 params (args, context)", () => {
      assert.ok(glob.execute, "glob.execute must exist");
      assert.strictEqual(typeof glob.execute, "function");
      assert.strictEqual(glob.execute.length, 2, "glob.execute should accept 2 parameters");
    });
  });
});

// ===========================================================================
// 3. Tool return shape (output + metadata contract)
// ===========================================================================
describe("module contract - tool return shape", () => {
  describe("grep return contract", () => {
    it("should return { title, output, metadata: { matches, truncated, regexFallback } }", async () => {
      const mod = await import("../index.js");
      const { client } = createMockClient();
      const tmpDir = createTempDir();
      try {
        const { tool } = await mod.default({ directory: tmpDir, client });
        await new Promise((r) => setTimeout(r, 500));
        const result = await tool.grep.execute({ pattern: "foo" }, createContext(tmpDir));
        assert.ok(typeof result === "object", "grep result must be an object");
        assert.ok("title" in result, "grep result must have title");
        assert.ok("output" in result, "grep result must have output");
        assert.strictEqual(typeof result.output, "string", "grep output must be a string");
        assert.ok("metadata" in result, "grep result must have metadata");
        assert.ok(typeof result.metadata === "object", "grep metadata must be an object");
        assert.ok("matches" in result.metadata, "grep metadata must have matches");
        assert.strictEqual(typeof result.metadata.matches, "number", "grep matches must be a number");
        assert.ok("truncated" in result.metadata, "grep metadata must have truncated");
        assert.strictEqual(typeof result.metadata.truncated, "boolean", "grep truncated must be boolean");
        assert.ok("regexFallback" in result.metadata, "grep metadata must have regexFallback");
        assert.strictEqual(typeof result.metadata.regexFallback, "boolean", "grep regexFallback must be boolean");
      } finally {
        cleanupTempDir(tmpDir);
      }
    });
  });

  describe("glob return contract", () => {
    it("should return { title, output, metadata: { count, truncated } }", async () => {
      const mod = await import("../index.js");
      const { client } = createMockClient();
      const tmpDir = createTempDir();
      try {
        const { tool } = await mod.default({ directory: tmpDir, client });
        await new Promise((r) => setTimeout(r, 500));
        const result = await tool.glob.execute({ pattern: "*" }, createContext(tmpDir));
        assert.ok(typeof result === "object", "glob result must be an object");
        assert.ok("title" in result, "glob result must have title");
        assert.ok("output" in result, "glob result must have output");
        assert.strictEqual(typeof result.output, "string", "glob output must be a string");
        assert.ok("metadata" in result, "glob result must have metadata");
        assert.ok(typeof result.metadata === "object", "glob metadata must be an object");
        assert.ok("count" in result.metadata, "glob metadata must have count");
        assert.strictEqual(typeof result.metadata.count, "number", "glob count must be a number");
        assert.ok("truncated" in result.metadata, "glob metadata must have truncated");
        assert.strictEqual(typeof result.metadata.truncated, "boolean", "glob truncated must be boolean");
      } finally {
        cleanupTempDir(tmpDir);
      }
    });
  });
});
// ===========================================================================
// 4. Sub-module contracts
// ===========================================================================
describe("module contract - sub-modules", () => {
  describe("constants.js", () => {
    let c; before(async () => { c = await import("../constants.js"); });
    it("exports all constants", () => {
      const e = ["TRAILING_SLASH_RE","ROOT_PATH_RE","GLOB_METACHAR_RE","REGEX_METACHAR_RE","SCAN_TIMEOUT_MS","TOOL_TIMEOUT_MS","GREP_TIME_BUDGET_MS","MAX_LIMIT","DEFAULT_GREP_LIMIT","DEFAULT_GLOB_LIMIT","SKIP_DIRS"];
      for (const n of e) assert.ok(n in c);
      assert.deepStrictEqual(Object.keys(c).sort(), [...e].sort());
    });
    it("has correct types", () => {
      assert.ok(c.TRAILING_SLASH_RE instanceof RegExp);
      assert.ok(c.ROOT_PATH_RE instanceof RegExp);
      assert.ok(c.GLOB_METACHAR_RE instanceof RegExp);
      assert.ok(c.REGEX_METACHAR_RE instanceof RegExp);
      assert.strictEqual(typeof c.SCAN_TIMEOUT_MS, "number");
      assert.strictEqual(typeof c.TOOL_TIMEOUT_MS, "number");
      assert.strictEqual(typeof c.GREP_TIME_BUDGET_MS, "number");
      assert.strictEqual(typeof c.MAX_LIMIT, "number");
      assert.strictEqual(typeof c.DEFAULT_GREP_LIMIT, "number");
      assert.strictEqual(typeof c.DEFAULT_GLOB_LIMIT, "number");
      assert.ok(c.SKIP_DIRS instanceof Set);
    });
    it("has sensible defaults", () => {
      assert.strictEqual(c.DEFAULT_GREP_LIMIT, 100);
      assert.strictEqual(c.DEFAULT_GLOB_LIMIT, 100);
      assert.strictEqual(c.MAX_LIMIT, 5000);
    });
    it("SKIP_DIRS has core dirs", () => {
      for (const d of [".git","node_modules","dist","build"]) assert.ok(c.SKIP_DIRS.has(d));
    });
  });
  describe("helpers.js", () => {
    let h; before(async () => { h = await import("../helpers.js"); });
    it("exports 8 functions", () => {
      const e = ["resolvePathUnchecked","isPathOutside","resolvePath","getRelativePath","isPathInsideIndex","debugLog","safeLog","waitForScan"];
      for (const n of e) { assert.ok(n in h); assert.strictEqual(typeof h[n], "function"); }
      assert.deepStrictEqual(Object.keys(h).sort(), [...e].sort());
    });
  });
  describe("filters.js", () => {
    let f; before(async () => { f = await import("../filters.js"); });
    it("exports 6 functions", () => {
      const e = ["compilePatterns","parsePatterns","shouldIncludeCompiled","shouldIncludeFile","applyMinimatchFilter","filterByPath"];
      for (const n of e) { assert.ok(n in f); assert.strictEqual(typeof f[n], "function"); }
      assert.deepStrictEqual(Object.keys(f).sort(), [...e].sort());
    });
  });
  describe("search.js", () => {
    let s; before(async () => { s = await import("../search.js"); });
    it("exports 7 functions", () => {
      const e = ["detectGrepMode","searchInFile","directFileGrep","fsGrep","globWalk","fetchGrepPages","performGrepRouting"];
      for (const n of e) { assert.ok(n in s); assert.strictEqual(typeof s[n], "function"); }
      assert.deepStrictEqual(Object.keys(s).sort(), [...e].sort());
    });
  });
  describe("gitignore.js", () => {
    let g; before(async () => { g = await import("../gitignore.js"); });
    it("exports loadGitignoreFilter only", () => {
      assert.ok("loadGitignoreFilter" in g);
      assert.strictEqual(typeof g.loadGitignoreFilter, "function");
      assert.deepStrictEqual(Object.keys(g), ["loadGitignoreFilter"]);
    });
  });
});
// ===========================================================================
// 5. getLegacyPlugins() safety
// ===========================================================================
describe("module contract - getLegacyPlugins safety", () => {
  it("no internal functions as top-level named exports", async () => {
    const mod = await import("../index.js");
    const n = ["detectGrepMode","filterByPath","resolvePath","resolvePathUnchecked","isPathOutside","getRelativePath","isPathInsideIndex","directFileGrep","fsGrep","globWalk","safeLog","waitForScan","debugLog","parsePatterns","compilePatterns","shouldIncludeFile","shouldIncludeCompiled","applyMinimatchFilter","searchInFile","fetchGrepPages","lazyFff","performGrepRouting","loadGitignoreFilter"];
    for (const name of n) assert.ok(!(name in mod), `Internal ${name} leaked`);
  });
  it("only server and __test as function-valued named exports", async () => {
    const mod = await import("../index.js");
    const fn = Object.keys(mod).filter(k => k !== "default" && typeof mod[k] === "function");
    const unexpected = fn.filter(k => k !== "server" && k !== "__test");
    assert.strictEqual(unexpected.length, 0, `Unexpected: ${JSON.stringify(unexpected)}`);
  });
  it("survives getLegacyPlugins-style iteration", async () => {
    const mod = await import("../index.js");
    for (const val of Object.values(mod)) {
      if (typeof val === "function") {
        try {
          const result = val({ directory: "/tmp", client: { app: { log: async () => {} } } });
          if (result instanceof Promise) await result;
        } catch { assert.fail(`getLegacyPlugins call threw: ${val.name || "anon"}`); }
      }
    }
  });
});
