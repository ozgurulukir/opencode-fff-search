import { tool } from "@opencode-ai/plugin";
import { FileFinder } from "@ff-labs/fff-node";
import { minimatch } from "minimatch";

// Module-level constants
const TRAILING_SLASH_RE = /\/+$/;
const SCAN_TIMEOUT_MS = 15000;
const TOOL_TIMEOUT_MS = 5000;
const MAX_LIMIT = 5000;
const DEFAULT_GREP_LIMIT = 1000;
const DEFAULT_GLOB_LIMIT = 100;
const DEFAULT_MAX_MATCHES_PER_FILE = 100;

/**
 * FFF Plugin - Replaces OpenCode's default file search (grep, glob)
 * with fff.nvim's fast, typo-resistant, frecency-ranked search.
 */

/**
 * Safe logging helper - never throws, prevents logging from crashing the plugin.
 * @param {object} client - The OpenCode client
 * @param {string} level - Log level
 * @param {string} message - Log message
 */
async function safeLog(client, level, message) {
  try {
    await client.app.log({ body: { service: "fff-plugin", level, message } });
  } catch {
    // Intentionally swallowed — logging must never crash the plugin
  }
}

/**
 * Wait for the scan to complete or timeout.
 * @param {Promise} scanPromise - The scan promise to wait for
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<boolean>} - True if scan completed, false otherwise
 */
async function waitForScan(scanPromise, timeoutMs) {
  try {
    return await Promise.race([
      scanPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  } catch {
    return false;
  }
}

/**
 * Normalize path by removing trailing slashes.
 * @param {string} path - The path to normalize
 * @returns {string} - Normalized path without trailing slashes
 */
function normalizePath(path) {
  return path.replace(TRAILING_SLASH_RE, "");
}

// Module-level instance cache to prevent leaking native resources (watcher threads,
// mmap handles). Only one FileFinder per directory is allowed.
const instances = new Map();

export const FffPlugin = async ({ directory, client }) => {
  await safeLog(client, "info", `Initializing in ${directory}`);

  if (!instances.has(directory)) {
    const initResult = FileFinder.create({
      basePath: directory,
      aiMode: true,
      disableMmapCache: true,
      disableWatch: false,
    });
    if (!initResult.ok) {
      await safeLog(client, "error", `fff init failed: ${initResult.error}`);
      throw new Error(`fff initialization failed: ${initResult.error}`);
    }

    const finder = initResult.value;
    const scanPromise = finder.waitForScan(SCAN_TIMEOUT_MS).catch(() => undefined);
    scanPromise.then(() => safeLog(client, "info", "Initial fff scan complete"));

    instances.set(directory, { finder, scanPromise });
  }

  const { finder, scanPromise } = instances.get(directory);

  return {
    tool: {
      grep: tool({
        description: "Search file contents using fff (fast, typo-resistant, frecency-ranked).",
        args: {
          pattern: tool.schema.string().describe("Search pattern"),
          path: tool.schema.string().optional(),
          exclude: tool.schema.string().optional(),
          caseSensitive: tool.schema.boolean().optional(),
          context: tool.schema.number().optional(),
          limit: tool.schema.number().optional(),
        },
        async execute(args, context) {
          try {
            if (!args.pattern || typeof args.pattern !== "string" || args.pattern.trim() === "") {
              throw new Error("pattern must be a non-empty string");
            }
            if (args.limit != null && (typeof args.limit !== "number" || args.limit < 1 || args.limit > MAX_LIMIT)) {
              throw new Error(`limit must be a number between 1 and ${MAX_LIMIT}`);
            }
            if (args.context && (typeof args.context !== "number" || args.context < 0)) {
              throw new Error("context must be a non-negative number");
            }

            if (context.abort.aborted) throw new Error("Aborted");

            await waitForScan(scanPromise, TOOL_TIMEOUT_MS);
            if (context.abort.aborted) throw new Error("Aborted");

            const userLimit = args.limit || DEFAULT_GREP_LIMIT;
            const opts = {
              mode: "regex",
              smartCase: args.caseSensitive !== true,
              beforeContext: args.context ?? 0,
              afterContext: args.context ?? 0,
              maxMatchesPerFile: Math.min(userLimit, DEFAULT_MAX_MATCHES_PER_FILE),
            };

            const result = finder.grep(args.pattern, opts);
            if (!result.ok) {
              await safeLog(client, "error", `fff grep error: ${result.error}`);
              throw new Error(`fff grep error: ${result.error}`);
            }

            let matches = result.value?.items;

            if (!Array.isArray(matches)) {
              await safeLog(client, "warn", `fff grep returned unexpected result structure`);
              return "";
            }

            if (args.path) {
              const target = normalizePath(args.path);
              matches = matches.filter((m) => m.relativePath === target || m.relativePath.startsWith(target + "/"));
            }

            if (args.exclude) {
              const patterns = args.exclude.split(",").map((p) => p.trim()).filter(Boolean);
              const compiledPatterns = patterns.map((pat) => (path) => minimatch(path, pat, { dot: true }));
              matches = matches.filter((m) => !compiledPatterns.some((test) => test(m.relativePath)));
            }

            const limit = Math.max(1, userLimit);
            const returnedMatches = matches.length > limit ? matches.slice(0, limit) : matches;

            const lines = returnedMatches.map((m) => `${m.relativePath}:${m.lineNumber}:${m.lineContent}`);
            return lines.join("\n");
          } catch (err) {
            await safeLog(client, "error", `grep error: ${err.message}`);
            throw err;
          }
        },
      }),

      glob: tool({
        description: "Find files and directories using fff's fast fuzzy search.",
        args: {
          pattern: tool.schema.string(),
          path: tool.schema.string().optional(),
          type: tool.schema.enum(["file", "directory"]).optional(),
          limit: tool.schema.number().optional(),
        },
        async execute(args, context) {
          try {
            if (!args.pattern || typeof args.pattern !== "string" || args.pattern.trim() === "") {
              throw new Error("pattern must be a non-empty string");
            }
            if (args.limit != null && (typeof args.limit !== "number" || args.limit < 1 || args.limit > MAX_LIMIT)) {
              throw new Error(`limit must be a number between 1 and ${MAX_LIMIT}`);
            }

            if (context.abort.aborted) throw new Error("Aborted");

            await waitForScan(scanPromise, TOOL_TIMEOUT_MS);
            if (context.abort.aborted) throw new Error("Aborted");

            const pageSize = Math.max(1, args.limit || DEFAULT_GLOB_LIMIT);
            let items;

            if (args.type === "directory") {
              const dirResult = finder.directorySearch(args.pattern, { pageSize });
              if (!dirResult.ok) throw new Error(`fff dirSearch error: ${dirResult.error}`);
              items = dirResult.value?.items;
            } else {
              const fileResult = finder.fileSearch(args.pattern, { pageSize });
              if (!fileResult.ok) throw new Error(`fff fileSearch error: ${fileResult.error}`);
              items = fileResult.value?.items;
            }

            if (!Array.isArray(items)) {
              await safeLog(client, "warn", `fff glob returned unexpected result structure`);
              return "";
            }

            let result = items.map((item) => item.relativePath);

            if (args.path) {
              const target = normalizePath(args.path);
              result = result.filter((p) => p === target || p.startsWith(target + "/"));
            }

            return result.join("\n");
          } catch (err) {
            await safeLog(client, "error", `glob error: ${err.message}`);
            throw err;
          }
        },
      }),
    },
  };
};
