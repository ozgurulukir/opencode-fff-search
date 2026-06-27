import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, "..");

function setupMockEnv(tmpDir, mockModule) {
  mkdirSync(join(tmpDir, "node_modules/@ff-labs/fff-node"), {
    recursive: true,
  });
  mkdirSync(join(tmpDir, "plugin"), { recursive: true });

  writeFileSync(
    join(tmpDir, "node_modules/@ff-labs/fff-node/index.js"),
    mockModule,
  );

  for (const f of [
    "index.js",
    "search.js",
    "helpers.js",
    "filters.js",
    "gitignore.js",
    "constants.js",
  ]) {
    writeFileSync(
      join(tmpDir, "plugin", f),
      readFileSync(join(PLUGIN_DIR, f), "utf8"),
    );
  }
}

function runScript(tmpDir, scriptBody) {
  writeFileSync(join(tmpDir, "run-test.mjs"), scriptBody);
  return spawnSync("node", ["run-test.mjs"], {
    cwd: tmpDir,
    encoding: "utf8",
    timeout: 30000,
  });
}

describe("glob fff error paths (subprocess)", () => {
  it("should throw when directorySearch returns !ok", () => {
    const tmpDir = join(
      __dirname,
      `.tmp-glob-err-${process.pid}-${Date.now()}`,
    );
    try {
      setupMockEnv(
        tmpDir,
        `export class FileFinder {
          static create() {
            return { ok: true, value: {
              waitForScan: () => Promise.resolve(true),
              fileSearch: () => ({ ok: true, value: { items: [] } }),
              directorySearch: () => ({ ok: false, error: "native dir crash" }),
              grep: () => ({ ok: true, value: { items: [], totalFilesSearched: 1 } }),
              destroy: () => {},
            }};
          }
        }`,
      );

      const res = runScript(
        tmpDir,
        `
        import FffPlugin from "./plugin/index.js";
        import { mkdirSync } from "node:fs";
        mkdirSync("./testproj", { recursive: true });
        const client = { app: { log: async () => {} } };
        const { tool } = await FffPlugin({ directory: "./testproj", client });
        try {
          await tool.glob.execute(
            { pattern: "test", type: "directory" },
            { abort: { aborted: false }, sessionID: "s", messageID: "m", directory: "./testproj" }
          );
          console.error("FAIL: should have thrown");
          process.exit(1);
        } catch (e) {
          if (e.message.includes("fff dirSearch error")) {
            console.log("PASS");
            process.exit(0);
          }
          console.error("FAIL: wrong error:", e.message);
          process.exit(1);
        }
        `,
      );

      if (res.error) throw res.error;
      assert.ok(res.stdout.includes("PASS"), `Expected PASS: ${res.stderr}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should throw when fileSearch returns !ok", () => {
    const tmpDir = join(
      __dirname,
      `.tmp-glob-file-err-${process.pid}-${Date.now()}`,
    );
    try {
      setupMockEnv(
        tmpDir,
        `export class FileFinder {
          static create() {
            return { ok: true, value: {
              waitForScan: () => Promise.resolve(true),
              fileSearch: () => ({ ok: false, error: "native file crash" }),
              directorySearch: () => ({ ok: true, value: { items: [] } }),
              grep: () => ({ ok: true, value: { items: [], totalFilesSearched: 1 } }),
              destroy: () => {},
            }};
          }
        }`,
      );

      const res = runScript(
        tmpDir,
        `
        import FffPlugin from "./plugin/index.js";
        import { mkdirSync } from "node:fs";
        mkdirSync("./testproj", { recursive: true });
        const client = { app: { log: async () => {} } };
        const { tool } = await FffPlugin({ directory: "./testproj", client });
        try {
          await tool.glob.execute(
            { pattern: "test" },
            { abort: { aborted: false }, sessionID: "s", messageID: "m", directory: "./testproj" }
          );
          console.error("FAIL: should have thrown");
          process.exit(1);
        } catch (e) {
          if (e.message.includes("fff fileSearch error")) {
            console.log("PASS");
            process.exit(0);
          }
          console.error("FAIL: wrong error:", e.message);
          process.exit(1);
        }
        `,
      );

      if (res.error) throw res.error;
      assert.ok(res.stdout.includes("PASS"), `Expected PASS: ${res.stderr}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("plugin outer catch (subprocess)", () => {
  it("should return { tool: {} } when waitForScan throws synchronously", () => {
    const tmpDir = join(
      __dirname,
      `.tmp-outer-catch-${process.pid}-${Date.now()}`,
    );
    try {
      setupMockEnv(
        tmpDir,
        `export class FileFinder {
          static create() {
            return { ok: true, value: {
              waitForScan: () => { throw new Error("scan sync crash"); },
            }};
          }
        }`,
      );

      const res = runScript(
        tmpDir,
        `
        import FffPlugin from "./plugin/index.js";
        import { mkdirSync } from "node:fs";
        mkdirSync("./testproj", { recursive: true });
        const logs = [];
        const client = { app: { log: async (entry) => logs.push(entry) } };
        const result = await FffPlugin({ directory: "./testproj", client });
        const hasError = logs.some(
          (l) => l.body.level === "error" && l.body.message.includes("Plugin error"),
        );
        if (hasError && result.tool && Object.keys(result.tool).length === 0) {
          console.log("PASS");
          process.exit(0);
        }
        console.error("FAIL: tool keys:", Object.keys(result.tool || {}), "logs:", JSON.stringify(logs.map(l => l.body)));
        process.exit(1);
        `,
      );

      if (res.error) throw res.error;
      assert.ok(res.stdout.includes("PASS"), `Expected PASS: ${res.stderr}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
