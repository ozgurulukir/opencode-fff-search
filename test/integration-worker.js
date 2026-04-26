import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createProjectStructure, makeTempDir } from "./helpers/stress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";
const WORKER_PATH = join(__dirname, "mutation-worker.cjs");

describe("integration: worker-thread mutations during opencode run", () => {
  it("should not SIGBUS when a worker thread mutates 500 files while opencode is running", async () => {
    const simDir = makeTempDir("opencode-worker", __dirname);
    createProjectStructure(simDir);

    // Long prompt that forces many tool calls
    const prompt =
      "For every source file in this project that exports a 'val' constant, " +
      "read its contents and list the filename and exported value. " +
      "Also find all test files and describe what they import. " +
      "Finally, search for any TODO or FIXME comments in the codebase.";

    // Spawn opencode
    const proc = spawn(
      OPENCODE_BIN,
      ["run", prompt, "--dir", simDir, "--print-logs", "--format", "json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    // Kill opencode after 90s if still running
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 3000);
    }, 90_000);

    // Launch worker thread for maximum-speed mutations
    const worker = new Worker(WORKER_PATH, {
      workerData: { simDir, mutationCount: 500 },
    });

    const workerResult = await new Promise((resolve, reject) => {
      worker.on("message", (msg) => {
        if (msg.type === "done") resolve(msg);
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (code !== 0) reject(new Error(`worker exited with code ${code}`));
      });
    });

    // Wait for opencode to finish
    const opencodeResult = await new Promise((resolve) => {
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ exitCode: code, signal, stdout, stderr });
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, signal: null, stdout, stderr: err.message });
      });
    });

    // Cleanup
    worker.terminate();
    rmSync(simDir, { recursive: true, force: true });

    // Critical: no signal death
    assert.notEqual(
      opencodeResult.signal,
      "SIGBUS",
      `SIGBUS! Worker did ${workerResult.completed} mutations. stderr: ${opencodeResult.stderr.slice(-500)}`,
    );
    assert.notEqual(
      opencodeResult.signal,
      "SIGSEGV",
      `SIGSEGV! Worker did ${workerResult.completed} mutations. stderr: ${opencodeResult.stderr.slice(-500)}`,
    );

    console.log(`  [worker-thread] ${workerResult.completed} mutations completed`);
    if (opencodeResult.signal) {
      console.log(`  [worker-thread] opencode killed by signal: ${opencodeResult.signal}`);
    } else if (opencodeResult.exitCode !== 0) {
      console.log(`  [worker-thread] opencode exited with code: ${opencodeResult.exitCode}`);
    } else {
      console.log(`  [worker-thread] opencode exited cleanly`);
    }
  });
});
