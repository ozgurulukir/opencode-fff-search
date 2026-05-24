import { tool } from "@opencode-ai/plugin";
import { FileFinder } from "@ff-labs/fff-node";
import { minimatch } from "minimatch";
import { join, relative, isAbsolute } from "node:path";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";

// Module-level constants
const TRAILING_SLASH_RE = /\/+$/;
const ROOT_PATH_RE = /^(\.|\.\/|\/)$/;  // matches only ".", "./", or "/"
const SCAN_TIMEOUT_MS = 15000;
const TOOL_TIMEOUT_MS = 5000;
const GREP_TIME_BUDGET_MS = 5000;  // Wall-clock cap per grep page (keeps abort responsive)
const MAX_LIMIT = 5000;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_GLOB_LIMIT = 100;


const SKIP_DIRS = new Set([
  ".git", "node_modules", ".hg", ".svn",
  "__pycache__", ".cache", "dist", ".next",
  "coverage", ".nyc_output", "build", "out",
  ".nuxt", ".output", ".vercel", ".terraform",
]);

const _gitignoreCache = new Map();

/**
 * Read .gitignore from basePath and return a set of directory names/patterns
 * to skip. Results are cached per basePath.
 * Returns a function (relPath, entryName, isDir) => boolean that returns true
 * if the path should be ignored.
 */
function loadGitignoreFilter(basePath) {
  if (_gitignoreCache.has(basePath)) return _gitignoreCache.get(basePath);
  const dirNames = new Set(SKIP_DIRS);
  const giPath = join(basePath, ".gitignore");
  try {
    const content = readFileSync(giPath, "utf8");
    for (let line of content.split("\n")) {
      line = line.trim();
      if (!line || line.startsWith("#") || line.startsWith("!")) continue;
      line = line.replace(/^\\#/, "#").replace(/^\\!/, "!").replace(/\/$/, "");
      const nameOnly = line.replace(/^(\*\*\/)?/, "").replace(/\/\*\*$/, "");
      if (!nameOnly.includes("/") && !nameOnly.includes("*") && !nameOnly.includes("?")) {
        dirNames.add(nameOnly);
      }
    }
  } catch {}
  const filter = (entryName, isDir) => {
    if (dirNames.has(entryName)) return true;
    if (entryName.startsWith(".")) return isDir;
    return false;
  };
  _gitignoreCache.set(basePath, filter);
  return filter;
}
const GLOB_METACHAR_RE = /[*?\[]/;

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
  // Root paths (".", "./", "/") mean "search everything" — don't filter
  if (ROOT_PATH_RE.test(targetPath) || targetPath.startsWith("/")) return items;
  const target = targetPath.replace(TRAILING_SLASH_RE, "");
  return items.filter((item) => {
    const path = item[pathKey];
    return path === target || path.startsWith(target + "/");
  });
}

/** Resolve path: absolute → as-is, relative → join with workspace dir, falsy → workspace dir. */
function resolvePath(directory, p) {
  if (!p) return directory;
  if (isAbsolute(p)) return p;
  return join(directory, p);
}

/**
 * Fetch grep results across multiple pages via cursor-based pagination.
 * fff-node grep() returns results one "page" of files at a time (frecency-ordered).
 * This helper accumulates items across pages until the target limit is met,
 * no more results exist, or the request is aborted. Page ceiling is computed
 * from targetLimit to prevent runaway searches.
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
 * @returns {{ items: Array, regexFallbackError: string|null }} Accumulated items and any regex warning
 */
async function fetchGrepPages(finder, pattern, baseOpts, targetLimit, abortSignal, client) {
  const items = [];
  let cursor = null;
  let regexFallbackError = null;
  const maxPages = Math.ceil(targetLimit / 50) + 2;
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
/**
 * Grep a single file by reading it directly (100% recall, bypasses fff).
 * Handles Unicode patterns correctly (uses regex `u` flag).
 */
function directFileGrep(filePath, basePath, pattern, ctxLines) {
  const rel = relative(basePath, filePath);
  const fileName = rel.split("/").pop();
  let content;
  try { content = readFileSync(filePath, "utf8"); } catch { return []; }
  const lines = content.split("\n");
  const results = [];
  let re;
  try {
    const hasUpper = /[A-Z]/.test(pattern);
    re = new RegExp(pattern, hasUpper ? "gu" : "giu");
  } catch {
    try { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"); } catch { return []; }
  }
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) {
      results.push({
        relativePath: rel,
        fileName,
        lineNumber: i + 1,
        lineContent: lines[i],
        contextBefore: ctxLines > 0 ? lines.slice(Math.max(0, i - ctxLines), i) : undefined,
        contextAfter: ctxLines > 0 ? lines.slice(i + 1, i + 1 + ctxLines) : undefined,
      });
    }
  }
  return results;
}

/**
 * Grep matching files by reading them with Node.js fs directly.
 * Used for Unicode/non-ASCII patterns (fff's tokenized index can't handle
 * them correctly due to Unicode normalization causing overcounting).
 * Walks the directory tree respecting SKIP_DIRS, applies path/include/exclude.
 */
function fsGrep(dir, basePath, pattern, ctxLines, pathFilter, include, exclude, limit) {
  const hasUpper = /[A-Z]/.test(pattern);
  const shouldSkip = loadGitignoreFilter(basePath);
  let re;
  try {
    re = new RegExp(pattern, hasUpper ? "gu" : "giu");
  } catch {
    try { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"); } catch { return []; }
  }
  const results = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!shouldSkip(entry.name, true)) {
          stack.push(join(current, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const fullPath = join(current, entry.name);
      const rel = relative(basePath, fullPath);
      // Apply path filter
      if (pathFilter && !filterByPath([{ relativePath: rel }], "relativePath", pathFilter).length) continue;
      // Apply include filter (match basename + full path)
      if (include) {
        const patterns = include.split(",").map((p) => p.trim()).filter(Boolean);
        const matches = patterns.some((pat) =>
          minimatch(entry.name, pat, { dot: true }) ||
          minimatch(rel, pat, { dot: true })
        );
        if (!matches) continue;
      }
      // Apply exclude filter
      if (exclude) {
        const patterns = exclude.split(",").map((p) => p.trim()).filter(Boolean);
        const excluded = patterns.some((pat) =>
          minimatch(entry.name, pat, { dot: true }) ||
          minimatch(rel, pat, { dot: true }) ||
          rel.split("/").some((part) => minimatch(part, pat, { dot: true }))
        );
        if (excluded) continue;
      }
      // Read and grep
      let content;
      try { content = readFileSync(fullPath, "utf8"); } catch { continue; }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          results.push({
            relativePath: rel,
            fileName: entry.name,
            lineNumber: i + 1,
            lineContent: lines[i],
            contextBefore: ctxLines > 0 ? lines.slice(Math.max(0, i - ctxLines), i) : undefined,
            contextAfter: ctxLines > 0 ? lines.slice(i + 1, i + 1 + ctxLines) : undefined,
          });
          if (limit && results.length >= limit) {
            return results;
          }
        }
      }
    }
  }
  return results;
}

/**
 * Walk a directory tree using readdirSync, matching entries against a glob pattern
 * via minimatch. Supports `type="file"` (default) or `type="directory"`.
 * Returns items with `relativePath` and `fileName` fields (same shape as fff).
 * Handles Turkish/Unicode filenames correctly (operates at filesystem level).
 */
function globWalk(dir, pattern, basePath, limit, type) {
  const shouldSkip = loadGitignoreFilter(basePath);
  const results = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      const rel = relative(basePath, fullPath);
      if (entry.isDirectory()) {
        const isSkipped = shouldSkip(entry.name, true);
        if (!isSkipped) {
          stack.push(fullPath);
        }
        if (type !== "file" && !isSkipped) {
          const dirMatch = minimatch(rel, pattern, { dot: true }) ||
            minimatch(entry.name, pattern, { dot: true });
          if (dirMatch) {
            results.push({ relativePath: rel, fileName: entry.name });
            if (results.length >= limit) return results;
          }
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (type === "directory") continue;
      if (minimatch(rel, pattern, { dot: true })) {
        results.push({ relativePath: rel, fileName: entry.name });
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
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
      aiMode: true,              // Enable frecency DB for better search ranking
      disableMmapCache: false,   // Enable mmap cache for faster searches
      disableContentIndexing: false,  // Enable bigram inverted index for faster grep (5-20x speedup)
      disableWatch: false,       // Enable file watcher to detect new/deleted files mid-session
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
          pattern: tool.schema.string().describe("Search pattern (literal text or regex)"),
          path: tool.schema.string().optional().describe("File or directory to search in (absolute or relative)"),
          include: tool.schema.string().optional().describe('File pattern to include (e.g. "*.vue", "*.{ts,tsx}")'),
          exclude: tool.schema.string().optional().describe("Comma-separated glob patterns to exclude"),
          caseSensitive: tool.schema.boolean().optional().describe("Force case-sensitive search (default: smart case)"),
          context: tool.schema.number().optional().describe("Context lines before/after each match (default: 0)"),
          limit: tool.schema.number().optional().describe("Max matches to return (default: 100, max: 5000)"),
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

            // Detect single-file vs directory search
            let resolvedFilePath = null;
            let hasNonAscii = false;
            if (args.path) {
              const resolvedPath = isAbsolute(args.path) ? args.path : join(directory, args.path);
              try {
                if (existsSync(resolvedPath) && statSync(resolvedPath).isFile()) {
                  resolvedFilePath = resolvedPath;
                }
              } catch { /* treat as directory */ }
            }

            let matches;
            let regexFallbackError = null;
            const ctxLines = args.context ?? 0;

            if (resolvedFilePath) {
              // Single-file: direct Node.js read for 100% recall
              matches = directFileGrep(resolvedFilePath, directory, args.pattern, ctxLines);
            } else {
              // Directory search: check for non-ASCII (Unicode) patterns
              hasNonAscii = /[^\x00-\x7F]/.test(args.pattern);
              if (hasNonAscii) {
                // Unicode patterns: fs-based search (fff normalizes ş↔s causing overcount)
                const searchDir = isAbsolute(args.path || "")
                  ? args.path
                  : join(directory, args.path || "");
                const pathRel = args.path
                  ? (isAbsolute(args.path) ? relative(directory, args.path) : args.path)
                  : null;
                matches = fsGrep(searchDir, directory, args.pattern, ctxLines, pathRel, args.include, args.exclude, limit);
              } else {
                // ASCII patterns: use fff's indexed search
                // If path is outside the indexed directory, fall back to fsGrep
                const resolvedSearch = isAbsolute(args.path || "")
                  ? args.path
                  : join(directory, args.path || "");
                const isOutsideIndex = args.path && !resolvedSearch.startsWith(directory + "/") && resolvedSearch !== directory;
                if (isOutsideIndex) {
                  const pathRel = isAbsolute(args.path) ? relative(directory, args.path) : args.path;
                  matches = fsGrep(resolvedSearch, directory, args.pattern, ctxLines, pathRel, args.include, args.exclude, limit);
                } else {
                  const mode = detectGrepMode(args.pattern);
                  const baseOpts = {
                    mode,
                    smartCase: args.caseSensitive !== true,
                    beforeContext: ctxLines,
                    afterContext: ctxLines,
                    maxMatchesPerFile: limit,
                  };
                  const result = await fetchGrepPages(
                    finder, args.pattern, baseOpts, limit, context.abort.signal, client
                  );
                  matches = result.items;
                  regexFallbackError = result.regexFallbackError;

                  // Failsafe: if plain mode returned nothing but the pattern had
                  // metacharacters that plain can't handle, retry with regex.
                  if (matches.length === 0 && mode === "plain") {
                    const retryOpts = { ...baseOpts, mode: "regex" };
                    const retry = await fetchGrepPages(
                      finder, args.pattern, retryOpts, limit, context.abort.signal, client
                    );
                    if (retry.items.length > 0) {
                      matches = retry.items;
                      regexFallbackError = retry.regexFallbackError;
                    }
                  }
                }
                // Post-filter by path (only for fff results — fsGrep pre-filters)
                if (args.path) {
                  const relativeTarget = isAbsolute(args.path)
                    ? relative(directory, args.path)
                    : args.path;
                  matches = filterByPath(matches, "relativePath", relativeTarget);
                }
                // Post-filter by include (only for fff results — fsGrep pre-filters)
                // Check both relativePath AND fileName because minimatch("dir/file.vue", "*.vue") is false
                if (args.include) {
                  const patterns = args.include.split(",").map((p) => p.trim()).filter(Boolean);
                  matches = matches.filter((m) =>
                    patterns.some((pat) =>
                      minimatch(m.relativePath, pat, { dot: true }) ||
                      minimatch(m.fileName, pat, { dot: true })
                    )
                  );
                }
                // Post-filter by exclude (only for fff results — fsGrep pre-filters)
                // Check both relativePath AND fileName because minimatch("dir/file.vue", "*.vue") is false
                if (args.exclude) {
                  const patterns = args.exclude.split(",").map((p) => p.trim()).filter(Boolean);
                  matches = matches.filter((m) =>
                    !patterns.some((pat) =>
                      minimatch(m.relativePath, pat, { dot: true }) ||
                      minimatch(m.fileName, pat, { dot: true })
                    )
                  );
                }
                // Failsafe: if fff returned nothing (or results were all filtered out),
                // try filesystem-level grep as a fallback (handles fff tokenization gaps)
                if (matches.length === 0) {
                  const fallbackDir = resolvePath(directory, args.path);
                  matches = fsGrep(fallbackDir, directory, args.pattern, ctxLines, null, args.include, args.exclude, limit);
                }
              }
            }

        if (matches.length === 0) {
              return {
                title: args.pattern,
                metadata: { matches: 0, truncated: false },
                output: "",
              };
            }
            // Filters are applied inside fsGrep (for Unicode) and the
            // fff routing block above. No additional filtering needed here.
            const total = matches.length;
            const truncated = total > limit;
            const displayed = truncated ? matches.slice(0, limit) : matches;
            const output = [];
            for (const m of displayed) {
              if (m.contextBefore?.length) {
                for (let i = 0; i < m.contextBefore.length; i++) {
                  output.push(`${m.relativePath}:${m.lineNumber - m.contextBefore.length + i}:${m.contextBefore[i]}`);
                }
              }
              output.push(`${m.relativePath}:${m.lineNumber}:${m.lineContent}`);
              if (m.contextAfter?.length) {
                for (let i = 0; i < m.contextAfter.length; i++) {
                  output.push(`${m.relativePath}:${m.lineNumber + i + 1}:${m.contextAfter[i]}`);
                }
              }
            }
            return {
              title: args.pattern,
              metadata: { matches: total, truncated },
              output: output.join("\n"),
            };
          } catch (err) {
            await safeLog(client, "error", `grep error: ${err.message}`);
            throw err;
          }
        },
      }),

      glob: tool({
        description: "Find files and directories using fff's fast fuzzy search.",
        args: {
          pattern: tool.schema.string().describe("Glob pattern (e.g. '**/*.ts') or fuzzy query"),
          path: tool.schema.string().optional().describe("Directory to search in (absolute or relative)"),
          type: tool.schema.enum(["file", "directory"]).optional().describe("Filter by type (default: file)"),
          limit: tool.schema.number().optional().describe("Max results to return (default: 100, max: 5000)"),
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
            const searchDir = resolvePath(directory, args.path);
            const isMetachar = GLOB_METACHAR_RE.test(args.pattern);
            // Increase internal page size when filtering by path or when the pattern
            // has glob metacharacters (the minimatch post-filter needs more candidates)
            const pageSize = (args.path || isMetachar) ? Math.max(userLimit, 1000) : userLimit;
            let items;
            // Glob patterns with metacharacters + type=directory: skip fff (its
            // directorySearch is fuzzy, not glob-aware) and use globWalk directly.
            if (args.type === "directory" && isMetachar) {
              const walkLimit = Math.max(userLimit, 100);
              items = globWalk(searchDir, args.pattern, directory, walkLimit, "directory");
            } else if (args.type === "directory") {
              const dirResult = finder.directorySearch(args.pattern, { pageSize });
              if (!dirResult.ok) throw new Error(`fff dirSearch error: ${dirResult.error}`);
              items = (dirResult.value?.items || []).map((item) => ({
                relativePath: item.relativePath || item.path || "",
                fileName: item.fileName || (item.relativePath || item.path || "").split("/").pop() || "",
              }));
            } else {
              const fileResult = finder.fileSearch(args.pattern, { pageSize });
              if (!fileResult.ok) throw new Error(`fff fileSearch error: ${fileResult.error}`);
              items = (fileResult.value?.items || []).map((item) => ({
                relativePath: item.relativePath || item.path || "",
                fileName: item.fileName || (item.relativePath || item.path || "").split("/").pop() || "",
              }));
            }
            if (!Array.isArray(items) || items.length === 0) {
              return {
                title: args.path ? relative(directory, searchDir) : args.pattern,
                output: "No files found",
                metadata: { count: 0, truncated: false },
              };
            }

            // Post-filter with minimatch for metacharacter patterns (exact glob matching
            // on top of fff's fuzzy results)
            if (isMetachar) {
              const globPatterns = args.pattern.split(",").map((p) => p.trim()).filter(Boolean);
              items = items.filter((item) =>
                globPatterns.some((pat) =>
                  minimatch(item.relativePath, pat, { dot: true }) ||
                  minimatch(item.fileName, pat, { dot: true })
                )
              );
            }

            // Filter by path (convert absolute to relative so filterByPath works correctly)
            if (args.path) {
              const relativeTarget = isAbsolute(args.path)
                ? relative(directory, args.path)
                : args.path;
              items = filterByPath(items, "relativePath", relativeTarget);
            }

            // Fallback: if fff returned nothing (or no exact basename match for
            // non-metachar patterns), try globWalk.
            // Non-metachar patterns use fff fuzzy search which may return many
            // inexact matches (e.g., "temp.ts" matches all .ts files). If none
            // of those results is an exact basename match, globWalk finds the
            // real file. Also handles Turkish/Unicode filenames, type=directory.
            if (items.length === 0) {
              const walkLimit = Math.max(userLimit, 100);
              const targetType = args.type || "file";
              items = globWalk(searchDir, args.pattern, directory, walkLimit, targetType);
            } else if (!isMetachar && !items.some((item) => item.fileName === args.pattern)) {
              // Fuzzy results don't include the exact file — augment with globWalk
              const walkLimit = Math.max(userLimit, 100);
              const targetType = args.type || "file";
              const walkResults = globWalk(searchDir, args.pattern, directory, walkLimit, targetType);
              const existing = new Set(items.map((item) => item.relativePath));
              for (const wr of walkResults) {
                if (!existing.has(wr.relativePath)) {
                  items.push(wr);
                  existing.add(wr.relativePath);
                }
              }
            }

            const limit = Math.max(1, userLimit);
            const total = items.length;
            const truncated = total > limit;
            const displayed = truncated ? items.slice(0, limit) : items;
            const absPaths = displayed.map((item) => join(directory, item.relativePath));
            const output = []
            if (displayed.length === 0) output.push("No files found")
            if (displayed.length > 0) {
              output.push(...absPaths)
              if (truncated) {
                output.push("")
                output.push(
                  `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`
                )
              }
            }
            return {
              title: args.path ? relative(directory, searchDir) : args.pattern,
              output: output.join("\n"),
              metadata: { count: displayed.length, truncated },
            };
          } catch (err) {
            await safeLog(client, "error", `glob error: ${err.message}`);
            throw err;
          }
        },
      }),
    },
  };
};
