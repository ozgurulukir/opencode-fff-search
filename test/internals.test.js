import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempProject, cleanupTempProject } from "./helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { __test } from "../index.js";
const {
  detectGrepMode,
  filterByPath,
  resolvePath,
  getRelativePath,
  isPathInsideIndex,
  parsePatterns,
  shouldIncludeFile,
  applyMinimatchFilter,
  safeLog,
  waitForScan,
  searchInFile,
  fetchGrepPages,
  lazyFff,
  performGrepRouting,
} = await __test();

let tmpDir;

before(() => {
  tmpDir = createTempProject(".tmp-internals-" + process.pid);
});

after(() => {
  cleanupTempProject(tmpDir);
});

describe("detectGrepMode", () => {
  it("should correctly identify plain text and regex patterns", () => {
    assert.strictEqual(detectGrepMode("hello world"), "plain");
    assert.strictEqual(detectGrepMode("example.com"), "plain");
    assert.strictEqual(detectGrepMode("foo(bar)"), "plain");
    assert.strictEqual(detectGrepMode("a,b,c"), "plain");

    assert.strictEqual(detectGrepMode("\\s+"), "regex");
    assert.strictEqual(detectGrepMode("import|export"), "regex");
    assert.strictEqual(detectGrepMode("foo[0-9]"), "regex");
    assert.strictEqual(detectGrepMode("^start"), "regex");
    assert.strictEqual(detectGrepMode("end$"), "regex");
    assert.strictEqual(detectGrepMode("a\\+"), "regex");
    assert.strictEqual(detectGrepMode("a\\*"), "regex");
    assert.strictEqual(detectGrepMode("a\\?"), "regex");
    assert.strictEqual(detectGrepMode("\\d+"), "regex");
    assert.strictEqual(detectGrepMode("\\w"), "regex");
    assert.strictEqual(detectGrepMode("\\bword\\b"), "regex");
    assert.strictEqual(detectGrepMode("\\D"), "regex");
    assert.strictEqual(detectGrepMode("\\S"), "regex");
    assert.strictEqual(detectGrepMode("\\W"), "regex");
    assert.strictEqual(detectGrepMode("\\N"), "regex");
    assert.strictEqual(detectGrepMode("\\B"), "regex");
    assert.strictEqual(detectGrepMode("\\T"), "regex");
    assert.strictEqual(detectGrepMode("[^a-z]"), "regex");
    assert.strictEqual(detectGrepMode("[]"), "regex");
    assert.strictEqual(detectGrepMode("[^]"), "regex");
    assert.strictEqual(detectGrepMode("[^abc]"), "regex");
    assert.strictEqual(detectGrepMode("\\|"), "regex");
    assert.strictEqual(detectGrepMode("a.b"), "plain");
  });

  it("should handle null or undefined gracefully", () => {
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
      { path: "package.json" },
    ];

    assert.deepEqual(filterByPath(items, "path", "."), items);
    assert.deepEqual(filterByPath(items, "path", "./"), items);
    assert.deepEqual(filterByPath(items, "path", "/"), items);

    const srcItems = filterByPath(items, "path", "src");
    assert.strictEqual(srcItems.length, 2);
    assert.strictEqual(srcItems[0].path, "src/index.js");
    assert.strictEqual(srcItems[1].path, "src/utils/helper.js");

    const utilsItems = filterByPath(items, "path", "src/utils/helper.js");
    assert.strictEqual(utilsItems.length, 1);
    assert.strictEqual(utilsItems[0].path, "src/utils/helper.js");
  });
});

describe("resolvePath", () => {
  it("should correctly resolve relative paths and prevent traversal", () => {
    const workspace =
      process.platform === "win32" ? "C:\\var\\workspace" : "/var/workspace";
    const outsidePath =
      process.platform === "win32" ? "C:\\etc\\passwd" : "/etc/passwd";
    const insidePath =
      process.platform === "win32"
        ? "C:\\var\\workspace\\src"
        : "/var/workspace/src";

    assert.throws(
      () => resolvePath(workspace, outsidePath),
      /Path is outside the workspace directory/,
    );

    assert.strictEqual(resolvePath(workspace, insidePath), insidePath);

    assert.throws(
      () => resolvePath(workspace, "../etc/passwd"),
      /Path is outside the workspace directory/,
    );

    assert.strictEqual(
      resolvePath(workspace, "src/index.js"),
      path.resolve(workspace, "src/index.js"),
    );
    assert.strictEqual(
      resolvePath(workspace, "./src"),
      path.resolve(workspace, "src"),
    );

    assert.strictEqual(resolvePath(workspace, ""), path.resolve(workspace));
    assert.strictEqual(resolvePath(workspace, null), path.resolve(workspace));
  });
});

describe("getRelativePath", () => {
  it("should return null for falsy argsPath", () => {
    assert.strictEqual(getRelativePath("/var/workspace", null), null);
    assert.strictEqual(getRelativePath("/var/workspace", ""), null);
    assert.strictEqual(getRelativePath("/var/workspace", undefined), null);
  });

  it("should return argsPath as-is when it is already relative", () => {
    assert.strictEqual(
      getRelativePath("/var/workspace", "src/index.js"),
      "src/index.js",
    );
    assert.strictEqual(
      getRelativePath("/var/workspace", "./src/index.js"),
      "./src/index.js",
    );
  });

  it("should convert absolute path to relative", () => {
    assert.strictEqual(
      getRelativePath("/var/workspace", "/var/workspace/src/index.js"),
      "src/index.js",
    );
    assert.strictEqual(
      getRelativePath("/var/workspace", "/var/workspace/"),
      "",
    );
  });

  it("should produce relative paths even for outside-workspace absolutes", () => {
    assert.strictEqual(
      getRelativePath("/var/workspace", "/etc/passwd"),
      "../../etc/passwd",
    );
  });
});

describe("isPathInsideIndex", () => {
  it("should return true for falsy argsPath", () => {
    assert.strictEqual(isPathInsideIndex(null, "/var/workspace"), true);
    assert.strictEqual(isPathInsideIndex("", "/var/workspace"), true);
    assert.strictEqual(isPathInsideIndex(undefined, "/var/workspace"), true);
  });

  it("should return true for relative paths", () => {
    assert.strictEqual(isPathInsideIndex("src/index.js", "/var/workspace"), true);
    assert.strictEqual(isPathInsideIndex("../etc/passwd", "/var/workspace"), true);
  });

  it("should return true when absolute path is inside directory", () => {
    assert.strictEqual(
      isPathInsideIndex("/var/workspace/src/index.js", "/var/workspace"),
      true,
    );
  });

  it("should return true when absolute path equals directory", () => {
    assert.strictEqual(
      isPathInsideIndex("/var/workspace", "/var/workspace"),
      true,
    );
  });

  it("should return false when absolute path is outside directory", () => {
    assert.strictEqual(
      isPathInsideIndex("/etc/passwd", "/var/workspace"),
      false,
    );
    assert.strictEqual(
      isPathInsideIndex("/var/workspace-other", "/var/workspace"),
      false,
    );
  });

  it("should not match partial directory name prefix", () => {
    assert.strictEqual(
      isPathInsideIndex("/var/workspacex/file", "/var/workspace"),
      false,
    );
  });
});

describe("parsePatterns", () => {
  it("should return null for falsy input", () => {
    assert.strictEqual(parsePatterns(null), null);
    assert.strictEqual(parsePatterns(undefined), null);
    assert.strictEqual(parsePatterns(""), null);
  });

  it("should parse a single pattern", () => {
    assert.deepEqual(parsePatterns("*.js"), ["*.js"]);
  });

  it("should parse comma-separated patterns and trim whitespace", () => {
    assert.deepEqual(parsePatterns("*.js, *.ts, *.jsx"), [
      "*.js",
      "*.ts",
      "*.jsx",
    ]);
  });

  it("should filter out empty entries from commas", () => {
    assert.deepEqual(parsePatterns("*.js,,*.ts,"), ["*.js", "*.ts"]);
  });

  it("should return null for whitespace-only input", () => {
    assert.strictEqual(parsePatterns("   "), null);
  });

  it("should return null for comma-only input", () => {
    assert.strictEqual(parsePatterns(",,,"), null);
  });
});

describe("shouldIncludeFile", () => {
  it("should return true when no patterns provided", () => {
    assert.strictEqual(
      shouldIncludeFile("src/foo.js", "foo.js", null, null),
      true,
    );
  });

  it("should return true when include matches fileName", () => {
    assert.strictEqual(
      shouldIncludeFile("src/foo.js", "foo.js", ["*.js"], null),
      true,
    );
  });

  it("should return true when include matches relativePath", () => {
    assert.strictEqual(
      shouldIncludeFile("src/foo.js", "foo.js", ["src/*"], null),
      true,
    );
  });

  it("should return false when include does not match", () => {
    assert.strictEqual(
      shouldIncludeFile("src/foo.js", "foo.js", ["*.ts"], null),
      false,
    );
  });

  it("should return false when exclude matches fileName", () => {
    assert.strictEqual(
      shouldIncludeFile("src/foo.js", "foo.js", null, ["*.js"]),
      false,
    );
  });

  it("should return false when exclude matches relativePath", () => {
    assert.strictEqual(
      shouldIncludeFile("src/foo.js", "foo.js", null, ["src/**"]),
      false,
    );
  });

  it("should return false when exclude matches any path segment", () => {
    assert.strictEqual(
      shouldIncludeFile("src/components/App.vue", "App.vue", null, [
        "components",
      ]),
      false,
    );
  });

  it("should return true when exclude does not match", () => {
    assert.strictEqual(
      shouldIncludeFile("src/foo.js", "foo.js", null, ["*.ts"]),
      true,
    );
  });

  it("should apply both include and exclude", () => {
    assert.strictEqual(
      shouldIncludeFile("src/foo.js", "foo.js", ["*.js"], ["bar.*"]),
      true,
    );
    assert.strictEqual(
      shouldIncludeFile("src/bar.js", "bar.js", ["*.js"], ["bar.*"]),
      false,
    );
  });

  it("should handle dot files with dot:true", () => {
    assert.strictEqual(shouldIncludeFile(".env", ".env", [".env"], null), true);
    assert.strictEqual(
      shouldIncludeFile(".gitignore", ".gitignore", null, [".git*"]),
      false,
    );
  });

  it("should handle brace expansion in patterns", () => {
    assert.strictEqual(
      shouldIncludeFile("src/foo.ts", "foo.ts", ["*.{ts,js}"], null),
      true,
    );
    assert.strictEqual(
      shouldIncludeFile("src/foo.vue", "foo.vue", ["*.{ts,js}"], null),
      false,
    );
  });
});

describe("applyMinimatchFilter", () => {
  const items = [
    { relativePath: "src/foo.js", fileName: "foo.js" },
    { relativePath: "src/bar.ts", fileName: "bar.ts" },
    { relativePath: "README.md", fileName: "README.md" },
    { relativePath: "src/components/App.vue", fileName: "App.vue" },
  ];

  it("should return all items when no include/exclude", () => {
    assert.deepEqual(applyMinimatchFilter(items, null, null), items);
  });

  it("should return all items when include/exclude are empty strings", () => {
    assert.deepEqual(applyMinimatchFilter(items, "", ""), items);
  });

  it("should filter by include pattern", () => {
    const result = applyMinimatchFilter(items, "*.js", null);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].fileName, "foo.js");
  });

  it("should filter by exclude pattern", () => {
    const result = applyMinimatchFilter(items, null, "src/**");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].fileName, "README.md");
  });

  it("should filter by both include and exclude", () => {
    const result = applyMinimatchFilter(items, "*.js,*.ts", "src/bar.*");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].fileName, "foo.js");
  });

  it("should handle comma-separated include patterns", () => {
    const result = applyMinimatchFilter(items, "*.js,*.ts", null);
    assert.strictEqual(result.length, 2);
  });

  it("should return empty array when all items excluded", () => {
    const result = applyMinimatchFilter(items, null, "src/**,README.md,*.vue");
    assert.strictEqual(result.length, 0);
  });
});

describe("safeLog", () => {
  it("should not throw when client.app.log succeeds", async () => {
    const logs = [];
    const client = { app: { log: async ({ body }) => logs.push(body) } };
    await safeLog(client, "info", "test message");
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].level, "info");
    assert.strictEqual(logs[0].message, "test message");
  });

  it("should not throw when client.app.log throws", async () => {
    const client = {
      app: {
        log: async () => {
          throw new Error("log broken");
        },
      },
    };
    await assert.doesNotReject(() => safeLog(client, "error", "test"));
  });

  it("should not throw when client is null/undefined", async () => {
    await assert.doesNotReject(() => safeLog(null, "info", "test"));
    await assert.doesNotReject(() => safeLog(undefined, "info", "test"));
  });

  it("should not throw when client.app is missing", async () => {
    await assert.doesNotReject(() => safeLog({}, "info", "test"));
  });
});

describe("waitForScan", () => {
  it("should return true when promise resolves quickly", async () => {
    const p = Promise.resolve(undefined);
    const result = await waitForScan(p, 1000);
    assert.strictEqual(result, true);
  });

  it("should return false when promise rejects", async () => {
    const p = Promise.reject(new Error("scan failed"));
    const result = await waitForScan(p, 1000);
    assert.strictEqual(result, false);
  });

  it("should return false when timeout fires before promise resolves", async () => {
    const p = new Promise((resolve) => setTimeout(resolve, 10000));
    const result = await waitForScan(p, 50);
    assert.strictEqual(result, false);
  });

  it("should return true when promise resolves within timeout", async () => {
    const p = new Promise((resolve) => setTimeout(resolve, 10));
    const result = await waitForScan(p, 500);
    assert.strictEqual(result, true);
  });

  it("should return false for undefined promise (await undefined throws in .then)", async () => {
    const result = await waitForScan(undefined, 50);
    assert.strictEqual(result, false);
  });

  it("should return false for null promise (await null throws in .then)", async () => {
    const result = await waitForScan(null, 50);
    assert.strictEqual(result, false);
  });
});

describe("searchInFile", () => {
  it("should return matches with correct shape", async () => {
    const f = join(tmpDir, "search-test.txt");
    writeFileSync(f, "hello world\nfoo bar\nhello again\n");
    try {
      const results = [];
      const state = { filesRead: 0, linesTested: 0 };
      const re = /hello/gi;
      const hitLimit = await searchInFile(
        f,
        "search-test.txt",
        "search-test.txt",
        re,
        0,
        100,
        results,
        state,
      );
      assert.strictEqual(hitLimit, false);
      assert.strictEqual(results.length, 2);
      assert.strictEqual(state.filesRead, 1);
      assert.strictEqual(results[0].lineNumber, 1);
      assert.strictEqual(results[0].lineContent, "hello world");
      assert.strictEqual(results[1].lineNumber, 3);
      assert.strictEqual(results[1].lineContent, "hello again");
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("should return context lines when ctxLines > 0", async () => {
    const f = join(tmpDir, "ctx-search.txt");
    writeFileSync(f, "line1\nMATCH\nline3\nline4\n");
    try {
      const results = [];
      const state = { filesRead: 0, linesTested: 0 };
      const re = /MATCH/g;
      await searchInFile(
        f,
        "ctx-search.txt",
        "ctx-search.txt",
        re,
        2,
        100,
        results,
        state,
      );
      assert.strictEqual(results.length, 1);
      const match = results[0];
      assert.strictEqual(match.lineNumber, 2);
      assert.strictEqual(match.contextBefore.length, 1);
      assert.strictEqual(match.contextBefore[0], "line1");
      assert.strictEqual(match.contextAfter.length, 2);
      assert.strictEqual(match.contextAfter[0], "line3");
      assert.strictEqual(match.contextAfter[1], "line4");
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("should return false (no hitLimit) when file has no matches", async () => {
    const f = join(tmpDir, "nomatch.txt");
    writeFileSync(f, "nothing here\n");
    try {
      const results = [];
      const state = { filesRead: 0, linesTested: 0 };
      const re = /ZZZ/g;
      const hitLimit = await searchInFile(
        f,
        "nomatch.txt",
        "nomatch.txt",
        re,
        0,
        100,
        results,
        state,
      );
      assert.strictEqual(hitLimit, false);
      assert.strictEqual(results.length, 0);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("should return true (hitLimit) and stop when limit is reached", async () => {
    const f = join(tmpDir, "limit-test.txt");
    writeFileSync(f, "match\nmatch\nmatch\nmatch\n");
    try {
      const results = [];
      const state = { filesRead: 0, linesTested: 0 };
      const re = /match/g;
      const hitLimit = await searchInFile(
        f,
        "limit-test.txt",
        "limit-test.txt",
        re,
        0,
        2,
        results,
        state,
      );
      assert.strictEqual(hitLimit, true);
      assert.strictEqual(results.length, 2);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("should return false when file cannot be read", async () => {
    const results = [];
    const state = { filesRead: 0, linesTested: 0 };
    const re = /test/g;
    const hitLimit = await searchInFile(
      "/nonexistent/path/file.txt",
      "file.txt",
      "file.txt",
      re,
      0,
      100,
      results,
      state,
    );
    assert.strictEqual(hitLimit, false);
    assert.strictEqual(results.length, 0);
    assert.strictEqual(state.filesRead, 0);
  });

  it("should not count non-matching lines in linesTested", async () => {
    const f = join(tmpDir, "counting.txt");
    writeFileSync(f, "nope\nMATCH\nnope\n");
    try {
      const results = [];
      const state = { filesRead: 0, linesTested: 0 };
      const re = /MATCH/g;
      await searchInFile(
        f,
        "counting.txt",
        "counting.txt",
        re,
        0,
        100,
        results,
        state,
      );
      assert.strictEqual(state.filesRead, 1);
      assert.strictEqual(state.linesTested, 1);
    } finally {
      rmSync(f, { force: true });
    }
  });
});

describe("fetchGrepPages", () => {
  it("should collect items from a single page", async () => {
    const mockFinder = {
      grep(pattern, opts) {
        return {
          ok: true,
          value: {
            items: [
              {
                relativePath: "a.js",
                fileName: "a.js",
                lineNumber: 1,
                lineContent: "match",
              },
            ],
            totalFilesSearched: 1,
            nextCursor: null,
          },
        };
      },
    };
    const { items, regexFallbackError } = await fetchGrepPages(
      mockFinder,
      "test",
      { mode: "plain" },
      100,
      null,
      null,
    );
    assert.strictEqual(items.length, 1);
    assert.strictEqual(regexFallbackError, null);
  });

  it("should paginate when nextCursor is present", async () => {
    let callCount = 0;
    const mockFinder = {
      grep(pattern, opts) {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            value: {
              items: [
                {
                  relativePath: "a.js",
                  fileName: "a.js",
                  lineNumber: 1,
                  lineContent: "m1",
                },
              ],
              totalFilesSearched: 1,
              nextCursor: "cursor1",
            },
          };
        }
        return {
          ok: true,
          value: {
            items: [
              {
                relativePath: "b.js",
                fileName: "b.js",
                lineNumber: 2,
                lineContent: "m2",
              },
            ],
            totalFilesSearched: 2,
            nextCursor: null,
          },
        };
      },
    };
    const { items } = await fetchGrepPages(
      mockFinder,
      "test",
      { mode: "plain" },
      100,
      null,
      null,
    );
    assert.strictEqual(items.length, 2);
    assert.strictEqual(callCount, 2);
  });

  it("should stop when items reach targetLimit", async () => {
    let callCount = 0;
    const mockFinder = {
      grep() {
        callCount++;
        return {
          ok: true,
          value: {
            items: Array.from({ length: 10 }, (_, i) => ({
              relativePath: `f${i}.js`,
              fileName: `f${i}.js`,
              lineNumber: 1,
              lineContent: "match",
            })),
            totalFilesSearched: 10,
            nextCursor: "more",
          },
        };
      },
    };
    const { items } = await fetchGrepPages(
      mockFinder,
      "test",
      { mode: "plain" },
      15,
      null,
      null,
    );
    assert.ok(items.length >= 15);
    assert.strictEqual(callCount, 2);
  });

  it("should break on !result.ok", async () => {
    const mockFinder = {
      grep() {
        return { ok: false, error: "something broke" };
      },
    };
    const { items } = await fetchGrepPages(
      mockFinder,
      "test",
      { mode: "plain" },
      100,
      null,
      null,
    );
    assert.strictEqual(items.length, 0);
  });

  it("should break on empty items array", async () => {
    const mockFinder = {
      grep() {
        return {
          ok: true,
          value: { items: [], totalFilesSearched: 1, nextCursor: null },
        };
      },
    };
    const { items } = await fetchGrepPages(
      mockFinder,
      "test",
      { mode: "plain" },
      100,
      null,
      null,
    );
    assert.strictEqual(items.length, 0);
  });

  it("should break on non-array items", async () => {
    const mockFinder = {
      grep() {
        return {
          ok: true,
          value: { items: null, totalFilesSearched: 1 },
        };
      },
    };
    const { items } = await fetchGrepPages(
      mockFinder,
      "test",
      { mode: "plain" },
      100,
      null,
      null,
    );
    assert.strictEqual(items.length, 0);
  });

  it("should break when abort signal is already aborted", async () => {
    let callCount = 0;
    const mockFinder = {
      grep() {
        callCount++;
        return {
          ok: true,
          value: {
            items: [{ relativePath: "a.js", fileName: "a.js" }],
            totalFilesSearched: 1,
            nextCursor: "more",
          },
        };
      },
    };
    const ac = new AbortController();
    ac.abort();
    const { items } = await fetchGrepPages(
      mockFinder,
      "test",
      { mode: "plain" },
      100,
      ac.signal,
      null,
    );
    assert.strictEqual(items.length, 0);
    assert.strictEqual(callCount, 0);
  });

  it("should capture regexFallbackError from pageResult", async () => {
    const mockFinder = {
      grep() {
        return {
          ok: true,
          value: {
            items: [{ relativePath: "a.js", fileName: "a.js" }],
            totalFilesSearched: 1,
            regexFallbackError: "regex engine limit hit",
            nextCursor: null,
          },
        };
      },
    };
    const { regexFallbackError } = await fetchGrepPages(
      mockFinder,
      "test",
      { mode: "regex" },
      100,
      null,
      null,
    );
    assert.strictEqual(regexFallbackError, "regex engine limit hit");
  });

  it("should retry when totalFilesSearched=0 and items empty", async () => {
    let callCount = 0;
    const mockFinder = {
      grep() {
        callCount++;
        if (callCount <= 2) {
          return {
            ok: true,
            value: { items: [], totalFilesSearched: 0, nextCursor: null },
          };
        }
        return {
          ok: true,
          value: {
            items: [{ relativePath: "a.js", fileName: "a.js" }],
            totalFilesSearched: 5,
            nextCursor: null,
          },
        };
      },
    };
    const { items } = await fetchGrepPages(
      mockFinder,
      "test",
      { mode: "plain" },
      100,
      null,
      null,
    );
    assert.strictEqual(items.length, 1);
    assert.ok(callCount >= 3, `Expected >=3 calls, got ${callCount}`);
  });
});

describe("lazyFff", () => {
  it("should set FileFinder after successful import", async () => {
    const mod = await import("../index.js");
    const internals = await mod.__test();
    assert.strictEqual(typeof internals.lazyFff, "function");
  });

  it("should not throw when called with null client", async () => {
    await assert.doesNotReject(() => lazyFff(null));
  });

  it("should not throw when called with broken client", async () => {
    const brokenClient = {
      app: {
        log: async () => {
          throw new Error("broken");
        },
      },
    };
    await assert.doesNotReject(() => lazyFff(brokenClient));
  });

  it("should be idempotent (safe to call multiple times)", async () => {
    await lazyFff(null);
    await lazyFff(null);
    await lazyFff(null);
  });
});

describe("performGrepRouting", () => {
  it("should use directFileGrep when path points to a file", async () => {
    const f = join(tmpDir, "routing-test.txt");
    writeFileSync(f, "findme in routing test\n");
    try {
      const ac = new AbortController();
      const result = await performGrepRouting(
        tmpDir,
        null,
        null,
        { pattern: "findme", path: f },
        0,
        100,
        { abort: ac.signal },
      );
      assert.ok(result.matches.length >= 1);
      assert.ok(result.matches[0].lineContent.includes("findme"));
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("should use fsGrep for non-ASCII patterns (no finder)", async () => {
    const f = join(tmpDir, "unicode-routing.txt");
    writeFileSync(f, "şeker ve çay\n");
    try {
      const ac = new AbortController();
      const result = await performGrepRouting(
        tmpDir,
        null,
        null,
        { pattern: "şeker" },
        0,
        100,
        { abort: ac.signal },
      );
      assert.ok(result.matches.length >= 1);
      assert.ok(result.matches[0].lineContent.includes("şeker"));
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("should use fsGrep fallback when finder is null (ASCII, no results)", async () => {
    const f = join(tmpDir, "ascii-fallback.txt");
    writeFileSync(f, "uniquepattern123\n");
    try {
      const ac = new AbortController();
      const result = await performGrepRouting(
        tmpDir,
        null,
        null,
        { pattern: "uniquepattern123" },
        0,
        100,
        { abort: ac.signal },
      );
      assert.ok(result.matches.length >= 1);
      assert.ok(result.matches[0].lineContent.includes("uniquepattern123"));
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("should handle non-existent file path gracefully", async () => {
    const ac = new AbortController();
    const result = await performGrepRouting(
      tmpDir,
      null,
      null,
      { pattern: "test", path: join(tmpDir, "nope.txt") },
      0,
      100,
      { abort: ac.signal },
    );
    assert.ok(Array.isArray(result.matches));
  });

  it("should apply include filter", async () => {
    const f = join(tmpDir, "include-filter.js");
    writeFileSync(f, "filterme\n");
    const md = join(tmpDir, "include-filter.md");
    writeFileSync(md, "filterme\n");
    try {
      const ac = new AbortController();
      const result = await performGrepRouting(
        tmpDir,
        null,
        null,
        { pattern: "filterme", include: "*.js" },
        0,
        100,
        { abort: ac.signal },
      );
      for (const m of result.matches) {
        assert.ok(
          m.relativePath.endsWith(".js"),
          `Expected .js file, got: ${m.relativePath}`,
        );
      }
    } finally {
      rmSync(f, { force: true });
      rmSync(md, { force: true });
    }
  });

  it("should apply exclude filter", async () => {
    const f = join(tmpDir, "exclude-filter.js");
    writeFileSync(f, "excludeme\n");
    const md = join(tmpDir, "exclude-filter.md");
    writeFileSync(md, "excludeme\n");
    try {
      const ac = new AbortController();
      const result = await performGrepRouting(
        tmpDir,
        null,
        null,
        { pattern: "excludeme", exclude: "*.md" },
        0,
        100,
        { abort: ac.signal },
      );
      for (const m of result.matches) {
        assert.ok(
          !m.relativePath.endsWith(".md"),
          `Excluded .md leaked: ${m.relativePath}`,
        );
      }
    } finally {
      rmSync(f, { force: true });
      rmSync(md, { force: true });
    }
  });

  it("should handle path pointing to a directory", async () => {
    const ac = new AbortController();
    const result = await performGrepRouting(
      tmpDir,
      null,
      null,
      { pattern: "export", path: "src" },
      0,
      100,
      { abort: ac.signal },
    );
    assert.ok(Array.isArray(result.matches));
    for (const m of result.matches) {
      const normalized = m.relativePath.replace(/\\/g, "/");
      assert.ok(
        normalized.startsWith("src/"),
        `Expected src/ prefix: ${m.relativePath}`,
      );
    }
  });
});
