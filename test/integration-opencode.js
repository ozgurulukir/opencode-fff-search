import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import {
  openSync,
  closeSync,
  ftruncateSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { FileFinder } from "@ff-labs/fff-node";
import {
  createProjectStructure,
  initSimFinder,
  simCleanup,
  makeTempDir,
} from "./helpers/stress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";

/**
 * Run `opencode run` as a child process pointed at a project directory.
 * Returns a promise that resolves with { exitCode, signal, stdout, stderr }.
 */
function runOpenCode(dir, prompt, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      OPENCODE_BIN,
      ["run", prompt, "--dir", dir, "--print-logs", "--format", "json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 3000);
    }, timeoutMs);

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout, stderr });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Return the process so callers can check .killed
    resolve.__proc = proc;
    return proc;
  });
}

describe("integration: opencode run under filesystem churn", () => {
  it("should not SIGBUS when files are mutated while opencode processes a prompt", async () => {
    const simDir = makeTempDir("opencode-integ", __dirname);
    createProjectStructure(simDir);

    // Verify the plugin loads by doing a quick finder test
    let finder;
    try {
      finder = await initSimFinder(FileFinder, simDir);
      const testGrep = finder.grep("module");
      assert.ok(testGrep.ok, "finder should work before spawning opencode");
    } finally {
      simCleanup(finder, simDir);
      // Re-create for opencode to use (finder.destroy() may have affected state)
      createProjectStructure(simDir);
    }

    // A prompt that forces many grep/glob tool calls across the project
    const prompt =
      "List every file that exports a 'val' constant. Show the file path and the value for each. " +
      "Then find all test files and list their import statements.";

    // Spawn opencode — it will use the fff plugin for grep/glob
    const opencodePromise = runOpenCode(simDir, prompt, 120_000);

    // While opencode is running, aggressively mutate the project filesystem.
    // This runs on the event loop alongside the child process I/O.
    const mutationCount = 200;
    let mutationsDone = 0;

    const mutationInterval = setInterval(() => {
      const i = mutationsDone;
      if (i >= mutationCount) {
        clearInterval(mutationInterval);
        return;
      }
      mutationsDone++;

      const filePath = join(simDir, "src", `module-${i % 200}.js`);

      // Rotate through different mutation patterns
      switch (i % 6) {
        case 0: {
          // Append (simulates agent edit)
          try { appendFileSync(filePath, `// appended ${i}\n`); } catch { /* ok */ }
          break;
        }
        case 1: {
          // Truncate + rewrite (editor save)
          try {
            const fd = openSync(filePath, "w");
            ftruncateSync(fd, 0);
            closeSync(fd);
            writeFileSync(filePath, `// rewritten ${i}\n`);
          } catch { /* ok */ }
          break;
        }
        case 2: {
          // Delete + recreate (file replace)
          try {
            unlinkSync(filePath);
            writeFileSync(filePath, `// recreated ${i}\n`);
          } catch { /* ok */ }
          break;
        }
        case 3: {
          // Rename (refactor)
          try {
            renameSync(
              join(simDir, "src", `module-${i % 200}.js`),
              join(simDir, "src", `moved-${i}.js`),
            );
          } catch { /* ok */ }
          break;
        }
        case 4: {
          // Create new file
          writeFileSync(join(simDir, "src", `generated-${i}.js`), `// new ${i}\n`);
          break;
        }
        case 5: {
          // Delete a generated file
          try { unlinkSync(join(simDir, "src", `generated-${i - 5}.js`)); } catch { /* ok */ }
          break;
        }
      }

      // Mutate .opencode/session.db every 10 mutations
      if (i % 10 === 0) {
        const dbPath = join(simDir, ".opencode", "session.db");
        try {
          const fd = openSync(dbPath, "w");
          ftruncateSync(fd, 0);
          closeSync(fd);
          writeFileSync(dbPath, "\x00".repeat(1024 + i * 50));
        } catch { /* ok */ }
      }

      // Mutate .git/index every 15 mutations
      if (i % 15 === 0) {
        const indexPath = join(simDir, ".git", "index");
        try {
          const fd = openSync(indexPath, "w");
          ftruncateSync(fd, 0);
          closeSync(fd);
          writeFileSync(indexPath, `git index v${i}\n` + "0".repeat(2048));
        } catch { /* ok */ }
      }
    }, 50); // Mutate every 50ms — aggressive but not disk-starving

    const result = await opencodePromise;
    clearInterval(mutationInterval);

    // Cleanup
    const { rmSync } = await import("node:fs");
    rmSync(simDir, { recursive: true, force: true });

    // The critical assertion: opencode must not crash with SIGBUS (signal 7)
    // or any other fatal signal. A clean exit (code 0) or an error exit
    // (non-zero code) is acceptable — only signal death indicates a crash.
    assert.notEqual(
      result.signal,
      "SIGBUS",
      `opencode crashed with SIGBUS. ${mutationsDone} mutations executed. stderr: ${result.stderr.slice(-500)}`,
    );
    assert.notEqual(
      result.signal,
      "SIGSEGV",
      `opencode crashed with SIGSEGV. ${mutationsDone} stderr: ${result.stderr.slice(-500)}`,
    );

    // Log what happened for diagnostics (but don't fail on non-zero exit —
    // that could be an API error, timeout, etc.)
    if (result.signal) {
      console.log(`  [integration] opencode killed by signal: ${result.signal} (${mutationsDone} mutations)`);
    } else if (result.exitCode !== 0) {
      console.log(`  [integration] opencode exited with code: ${result.exitCode} (${mutationsDone} mutations)`);
    } else {
      console.log(`  [integration] opencode exited cleanly (${mutationsDone} mutations)`);
    }
  });
});
