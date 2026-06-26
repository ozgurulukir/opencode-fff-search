import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, "..");

describe("fff init fallback (throw path)", () => {
  it("falls back to fs-only mode when FileFinder.create throws", () => {
    const tmpDir = join(
      __dirname,
      `.tmp-fff-throw-${process.pid}-${Date.now()}`,
    );
    try {
      mkdirSync(join(tmpDir, "node_modules/@ff-labs/fff-node"), {
        recursive: true,
      });
      mkdirSync(join(tmpDir, "plugin"), { recursive: true });

      writeFileSync(
        join(tmpDir, "node_modules/@ff-labs/fff-node/index.js"),
        `export class FileFinder { static create() { throw new Error("mock native failure"); } }`,
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

      const script = `
        import FffPlugin from "./plugin/index.js";
        import { writeFileSync, mkdirSync } from "node:fs";

        mkdirSync("./testproj", { recursive: true });
        writeFileSync("./testproj/file.txt", "hello\\n");

        const logs = [];
        const client = {
          app: {
            log: async (entry) => logs.push(entry),
          },
        };

        const result = await FffPlugin({ directory: "./testproj", client });

        if (!result.tool?.grep?.execute) {
          console.error("FAIL: no grep tool");
          process.exit(1);
        }

        const hasWarn = logs.some(
          (l) =>
            l.body.level === "warn" &&
            (l.body.message.includes("fff native unavailable") ||
              l.body.message.includes("fff init failed")),
        );

        if (!hasWarn) {
          console.error("FAIL: missing init warning. Logs:", JSON.stringify(logs));
          process.exit(1);
        }

        const grepResult = await result.tool.grep.execute(
          { pattern: "hello" },
          {
            abort: { aborted: false },
            sessionID: "s",
            messageID: "m",
            directory: "./testproj",
          }
        );

        if (typeof grepResult !== "object" || !grepResult.output) {
          console.error("FAIL: grep returned invalid result");
          process.exit(1);
        }

        console.log("PASS");
      `;

      writeFileSync(join(tmpDir, "run-test.mjs"), script);

      const res = spawnSync("node", ["run-test.mjs"], {
        cwd: tmpDir,
        encoding: "utf8",
        timeout: 30000,
      });

      if (res.error) throw res.error;
      if (res.status !== 0) {
        assert.fail(`Process exited ${res.status}: ${res.stderr}`);
      }
      assert.ok(
        res.stdout.includes("PASS"),
        `Expected PASS, got: ${res.stdout}`,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
