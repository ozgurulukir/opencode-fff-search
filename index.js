import { tool } from "@opencode-ai/plugin";
import { FileFinder } from "@ff-labs/fff-node";
import { minimatch } from "minimatch";

// Module-level constants
const TRAILING_SLASH_RE = /\/+$/;
const SCAN_TIMEOUT_MS = 15000;
const TOOL_TIMEOUT_MS = 5000;
const GREP_TIME_BUDGET_MS = 5000;  // Wall-clock cap per grep page (keeps abort responsive)
const MAX_LIMIT = 5000;
const DEFAULT_GREP_LIMIT = 1000;
const DEFAULT_GLOB_LIMIT = 100;
const MAX_GREP_PAGES = 5; // Max pagination rounds to prevent runaway searches

// Regex: characters that need escaping to be treated as literals if the user
// likely intended a literal search. Escaped versions (\\(, \\[, etc.) don't
// Regex: matches patterns that contain intentional regex syntax:
// \s, \d, \w, \b, \n, \t (escaped character classes)
// \\ (literal backslash in pattern → regex escape intent)
// | (alternation: import|export)
// [abc] (character classes)
// \+ (quantifier: one or more)
// \* (quantifier: zero or more)
// \? (quantifier: optional)
// ^ or $ (anchors)
//
// Parentheses (), dots ., commas , and other symbols that appear in normal
// code are NOT treated as regex triggers — they are sent via plain mode.
const REGEX_METACHAR_RE = /\\[sdwnbtDSWNBT]|\\|\||\[\^?\]|\[\^?[^\]]+\]|\\\+|\\\*|\\\?|[\^\$]/;

/**
 * Return "regex" if the pattern looks like an intentional regex, otherwise "plain".
 * "plain" uses SIMD-accelerated literal matching, which is faster and correctly
 * matches text with parentheses, dots, etc. that regex mode silently drops.
 *
 * A pattern is treated as regex ONLY when it contains unescaped metacharacters
 * that go beyond simple literal text (e.g., "\s+", "import|export", "foo[0-9]").
 * Literal patterns like "(idempotent, schema from migrations)" or "example.com"
 * are sent as plain so they match the actual file contents.
 */
function detectGrepMode(pattern) {
  return REGEX_METACHAR_RE.test(pattern) ? "regex" : "plain";
}

/**
 * Shared helper to filter results by relative path.
 * Handles both exact matches and subdirectory matches.
 */
function filterByPath(items, pathKey, targetPath) {
  if (!targetPath) return items;
  const target = targetPath.replace(TRAILING_SLASH_RE, "");
  return items.filter((item) => {
    const path = item[pathKey];
    return path === target || path.startsWith(target + "/");
  });
}

/**
 * Fetch grep results across multiple pages via cursor-based pagination.
 * fff-node grep() returns results one "page" of files at a time (frecency-ordered).
 * This helper accumulates items across pages until the target limit is met,
 * no more results exist, the page ceiling is reached, or the request is aborted.
 *
 * If a regex fallback error is detected (fff fell back to literal matching
 * because the regex was invalid), a warning is logged via the provided
 * client reference.
 *
 * @param {object} finder - FileFinder instance
 * @param {string} pattern - Grep pattern
 * @param {object} baseOpts - GrepOptions (mode, smartCase, beforeContext, afterContext)
 * @param {number} targetLimit - Desired match count
 * @param {AbortSignal} abortSignal - AbortController signal
 * @param {object} [client] - OpenCode client for logging regex fallback warnings
 * @param {number} maxPages - Page ceiling (default: MAX_GREP_PAGES)
 * @returns {{ items: Array, regexFallbackError: string|null }} Accumulated items and any regex warning
 */
async function fetchGrepPages(finder, pattern, baseOpts, targetLimit, abortSignal, client, maxPages = MAX_GREP_PAGES) {
  const items = [];
  let cursor = null;
  let regexFallbackError = null;
  for (let page = 0; page < maxPages; page++) {
    if (abortSignal?.aborted) break;
    const opts = { ...baseOpts, cursor, timeBudgetMs: GREP_TIME_BUDGET_MS };
    const result = finder.grep(pattern, opts);
    if (!result.ok) break;
    const pageResult = result.value;
    // Capture regex fallback error from the first page that reports one
    if (pageResult.regexFallbackError && !regexFallbackError) {
      regexFallbackError = pageResult.regexFallbackError;
    }
    // If fff returned results in regex mode but had a fallback error, log it
    // so we know the "regex" → "literal" fallback happened.
    if (pageResult.regexFallbackError && client) {
      await safeLog(client, "warn", `fff regex fallback: ${pageResult.regexFallbackError}`);
    }
    if (!Array.isArray(pageResult.items) || pageResult.items.length === 0) break;
    items.push(...pageResult.items);
    if (items.length >= targetLimit) break;
    if (!pageResult.nextCursor) break;
    cursor = pageResult.nextCursor;
  }
  return { items, regexFallbackError };
}


/**
 * FFF Plugin - Replaces OpenCode's default file search (grep, glob)
 * with fff.nvim's fast, typo-resistant search.
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

// Module-level instance cache to prevent leaking native resources (watcher threads,
// mmap handles). Only one FileFinder per directory is allowed.
const instances = new Map();

/**
 * Main plugin entry point - aligned with @opencode-ai/plugin SDK
 */
export default async (input) => {
  const { directory, client } = input;
  await safeLog(client, "info", `Initializing in ${directory}`);

  if (!instances.has(directory)) {
    const initResult = FileFinder.create({
      basePath: directory,
      aiMode: false,           // Disable frecency DB (mmap source)
      disableMmapCache: true,  // Disable file cache (mmap source)
      disableContentIndexing: true, // Explicitly disable content index (mmap source)
      disableWatch: true,      // Disabled due to upstream stack overflow bug (fff.nvim#422)
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
            const limit = Math.max(1, userLimit);

            const mode = detectGrepMode(args.pattern);
            const baseOpts = {
              mode,
              smartCase: args.caseSensitive !== true,
              beforeContext: args.context ?? 0,
              afterContext: args.context ?? 0,
              maxMatchesPerFile: limit, // Follow user's limit so per-file caps never pre-empt
            };

            let { items: matches, regexFallbackError } = await fetchGrepPages(
              finder, args.pattern, baseOpts, limit, context.abort.signal, client
            );

            // Failsafe: if plain mode returned nothing but the pattern had
            // metacharacters that plain can't handle AND regex mode wasn't
            // tried (because it looked like plain), retry with regex.
            if (matches.length === 0 && mode === "plain") {
              const retryOpts = { ...baseOpts, mode: "regex" };
              const retry = await fetchGrepPages(
                finder, args.pattern, retryOpts, limit, context.abort.signal, client
              );
              if (retry.items.length > 0) {
                await safeLog(client, "warn",
                  `fff plain mode returned 0, retried with regex and got ${retry.items.length} matches`
                );
                matches = retry.items;
                regexFallbackError = retry.regexFallbackError;
              }
            }

            if (matches.length === 0) {
              await safeLog(client, "warn",
                `fff grep returned 0 matches for pattern "${args.pattern.substring(0, 80)}"` +
                (regexFallbackError ? ` (regex fallback: ${regexFallbackError})` : "")
              );
              return "";
            }

            // Filter by path using shared helper
            if (args.path) {
              matches = filterByPath(matches, "relativePath", args.path);
            }

            if (args.exclude) {
              const patterns = args.exclude.split(",").map((p) => p.trim()).filter(Boolean);
              const compiledPatterns = patterns.map((pat) => (path) => minimatch(path, pat, { dot: true }));
              matches = matches.filter((m) => !compiledPatterns.some((test) => test(m.relativePath)));
            }

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

            const userLimit = args.limit || DEFAULT_GLOB_LIMIT;
            // Increase internal page size when filtering by path
            const pageSize = args.path ? Math.max(userLimit, 1000) : userLimit;
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

            // Filter by path
            if (args.path) {
              items = filterByPath(items, "relativePath", args.path);
            }

            const limit = Math.max(1, userLimit);
            const returnedItems = items.length > limit ? items.slice(0, limit) : items;
            const result = returnedItems.map((item) => item.relativePath);

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
