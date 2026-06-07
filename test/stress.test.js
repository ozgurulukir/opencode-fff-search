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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  ftruncateSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTempProject,
  cleanupTempProject,
  createMockClient,
} from "./helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { __test } from "../index.js";
import { default as FffPlugin } from "../index.js";
const { FileFinder } = await import("@ff-labs/fff-node");

describe("SIGBUS / stability stress tests", () => {
  let stressDir;
  let stressFinder;

  async function setupStressDir() {
    stressDir = join(
      __dirname,
      `.tmp-stress-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(stressDir, { recursive: true });
    for (let i = 0; i < 50; i++) {
      writeFileSync(
        join(stressDir, `file-${i}.txt`),
        `line1 of file ${i}\n${"x".repeat(200)}\nline3 of file ${i}\n`,
      );
    }
  }

  async function initFinder() {
    const result = FileFinder.create({
      basePath: stressDir,
      aiMode: false,
      disableMmapCache: true,
      disableContentIndexing: true,
      disableWatch: true,
    });
    if (!result.ok)
      throw new Error(`stress finder init failed: ${result.error}`);
    stressFinder = result.value;
    await stressFinder.waitForScan(10000);
  }

  function cleanup() {
    if (stressFinder && !stressFinder.isDestroyed) {
      try {
        stressFinder.destroy();
      } catch {
        /* fff-node may throw on stale handles */
      }
    }
    cleanupTempProject(stressDir);
  }

  describe("file mutation during search", () => {
    it("should not crash when a file is deleted between scan and grep", async () => {
      await setupStressDir();
      try {
        await initFinder();
        unlinkSync(join(stressDir, "file-25.txt"));
        const result = stressFinder.grep("line1");
        assert.equal(
          typeof result,
          "object",
          "grep should return a result after file deletion",
        );
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
        const fd = openSync(join(stressDir, "file-10.txt"), "w");
        ftruncateSync(fd, 0);
        closeSync(fd);
        const result = stressFinder.grep("file-10");
        assert.equal(
          typeof result,
          "object",
          "grep should return a result after file truncation",
        );
      } finally {
        cleanup();
      }
    });

    it("should not crash when a file is overwritten during grep", async () => {
      await setupStressDir();
      try {
        await initFinder();
        const searchPromise = stressFinder.grep("x{200}");
        for (let i = 0; i < 10; i++) {
          writeFileSync(
            join(stressDir, `file-${i}.txt`),
            `overwritten ${Date.now()}\n`,
          );
        }
        const result = await searchPromise;
        assert.equal(
          typeof result,
          "object",
          "grep should return a result during file mutation",
        );
      } finally {
        cleanup();
      }
    });

    it("should not crash when files are created and deleted rapidly", async () => {
      await setupStressDir();
      try {
        await initFinder();
        for (let i = 0; i < 100; i++) {
          const p = join(stressDir, `volatile-${i}.txt`);
          writeFileSync(p, `volatile content ${i}` + "\n");
          if (i % 2 === 0) {
            unlinkSync(p);
          }
        }
        const result = stressFinder.grep("volatile");
        assert.equal(
          typeof result,
          "object",
          "grep should handle volatile files",
        );
      } finally {
        cleanup();
      }
    });
  });

  describe("multiple native instances", () => {
    it("should not crash when creating multiple FileFinder instances for same dir", async () => {
      await setupStressDir();
      const finders = [];
      try {
        for (let i = 0; i < 5; i++) {
          const result = FileFinder.create({
            basePath: stressDir,
            aiMode: false,
            disableMmapCache: true,
            disableWatch: true,
          });
          if (result.ok) finders.push(result.value);
        }
        const results = await Promise.all(finders.map((f) => f.grep("line1")));
        for (const r of results) {
          assert.equal(
            typeof r,
            "object",
            "finder.grep should return a result object",
          );
        }
      } finally {
        for (const f of finders) {
          try {
            if (!f.isDestroyed) f.destroy();
          } catch {
            /* stale handle */
          }
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
          disableWatch: true,
        });
        if (!result.ok) throw new Error(`init failed: ${result.error}`);
        const finder = result.value;
        await finder.waitForScan(5000);
        const searchPromise = finder.grep(".");
        finder.destroy();
        const searchResult = await searchPromise;
        assert.equal(
          typeof searchResult,
          "object",
          "destroy during search should return a result, not SIGBUS",
        );
      } finally {
        cleanup();
      }
    });
  });

  describe("large file handling", () => {
    it("should not crash when grepping a large file that gets truncated", async () => {
      await setupStressDir();
      try {
        const bigFile = join(stressDir, "bigfile.txt");
        writeFileSync(bigFile, "A".repeat(1024 * 1024));

        await initFinder();

        const fd = openSync(bigFile, "w");
        ftruncateSync(fd, 0);
        closeSync(fd);

        const result = stressFinder.grep("AAAA");
        assert.equal(
          typeof result,
          "object",
          "grep should return a result after large file truncation",
        );
      } finally {
        cleanup();
      }
    });
  });

  describe("plugin-level stress", () => {
    it("should not crash when FffPlugin is called many times for the same directory", async () => {
      const tmpDir = createTempProject(".tmp-stress-plugin-" + process.pid);
      try {
        const { client } = createMockClient();
        for (let i = 0; i < 10; i++) {
          const result = await FffPlugin({ directory: tmpDir, client });
          assert.ok(result.tool.grep);
          assert.ok(result.tool.glob);
        }
      } finally {
        cleanupTempProject(tmpDir);
      }
    });

    it("should not crash when FffPlugin is called for many different directories", async () => {
      const { client } = createMockClient();
      const dirs = [];
      for (let i = 0; i < 5; i++) {
        const d = createTempProject(
          ".tmp-stress-multi-" + process.pid + "-" + i,
        );
        dirs.push(d);
        const result = await FffPlugin({ directory: d, client });
        assert.ok(result.tool.grep);
        assert.ok(result.tool.glob);
      }
      for (const d of dirs) cleanupTempProject(d);
    });
  });
});
