import { tool } from "@opencode-ai/plugin";
import { minimatch } from "minimatch";

let FileFinder = null;
import { join, relative, isAbsolute, normalize } from "node:path";
import path from "node:path";
import { statSync, existsSync } from "node:fs";
import { promises as fsPromises } from "node:fs";

// Module-level constants
const TRAILING_SLASH_RE = /\/+$/;
const ROOT_PATH_RE = /^(\.|\.\/|\/)$/; // matches only ".", "./", or "/"
const SCAN_TIMEOUT_MS = 15000;
const TOOL_TIMEOUT_MS = 5000;
const GREP_TIME_BUDGET_MS = 5000; // Wall-clock cap per grep page (keeps abort responsive)
const MAX_LIMIT = 5000;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_GLOB_LIMIT = 100;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".hg",
  ".svn",
  "__pycache__",
  ".cache",
  "dist",
  ".next",
  "coverage",
  ".nyc_output",
  "build",
  "out",
  ".nuxt",
  ".output",
  ".vercel",
  ".terraform",
]);

const _gitignoreCache = new Map();

/**
 * Read .gitignore from basePath and return a set of directory names/patterns
 * to skip. Results are cached per basePath.
 * Returns a function (relPath, entryName, isDir) => boolean that returns true
 * if the path should be ignored.
 */
async function loadGitignoreFilter(basePath) {
  if (_gitignoreCache.has(basePath)) return _gitignoreCache.get(basePath);
  const dirNames = new Set(SKIP_DIRS);
  const giPath = join(basePath, ".gitignore");
  try {
    const content = await fsPromises.readFile(giPath, "utf8");
    for (let line of content.split("\n")) {
      line = line.trim();
      if (!line || line.startsWith("#") || line.startsWith("!")) continue;
      line = line.replace(/^\\#/, "#").replace(/^\\!/, "!").replace(/\/$/, "");
      const nameOnly = line.replace(/^(\*\*\/)?/, "").replace(/\/\*\*$/, "");
      if (
        !nameOnly.includes("/") &&
        !nameOnly.includes("*") &&
        !nameOnly.includes("?")
      ) {
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

/**
 * Regex: matches patterns that contain intentional regex syntax:
 * \s, \d, \w, \b, \n, \t (escaped character classes)
 * \\ (literal backslash in pattern → regex escape intent)
 * | (alternation: import|export)
 * [abc] (character classes)
 * \+ (quantifier: one or more)
 * \* (quantifier: zero or more)
 * \? (quantifier: optional)
 * ^ or $ (anchors)
 *
 * Parentheses (), dots ., commas , and other symbols that appear in normal
 * code are NOT treated as regex triggers — they are sent via plain mode.
 */
const REGEX_METACHAR_RE =
  /\\[sdwnbtDSWNBT]|\\|\||\[\^?\]|\[\^?[^\]]+\]|\\\+|\\\*|\\\?|[\^\$]/;

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
  if (!pattern || typeof pattern !== "string") return "plain";
  return REGEX_METACHAR_RE.test(pattern) ? "regex" : "plain";
}

/**
 * Shared helper to filter results by relative path.
 * Handles both exact matches and subdirectory matches.
 */
function filterByPath(items, pathKey, targetPath) {
  if (!targetPath) return items;
  // Root paths (".", "./", "/") mean "search everything" — don't filter
  if (
    ROOT_PATH_RE.test(targetPath) ||
    targetPath.startsWith("/") ||
    targetPath.startsWith("\\")
  )
    return items;
  const target = targetPath.replace(TRAILING_SLASH_RE, "").replace(/\\/g, "/");
  return items.filter((item) => {
    const pathVal = (item[pathKey] || "").replace(/\\/g, "/");
    return pathVal === target || pathVal.startsWith(target + "/");
  });
}

/** Resolve path: absolute → as-is, relative → join with workspace dir, falsy → workspace dir.
 *  Includes path traversal protection. */
function resolvePath(directory, p) {
  if (!p) return path.resolve(directory);
  const resolved = path.resolve(directory, p);
  const dirResolved = path.resolve(directory);
  // Ensure the trailing slash for accurate startsWith check if not exact match
  const prefix = dirResolved.endsWith(path.sep)
    ? dirResolved
    : dirResolved + path.sep;
  if (resolved !== dirResolved && !resolved.startsWith(prefix)) {
    throw new Error(
      `Path is outside the workspace directory: ${resolved} vs ${dirResolved}`,
    );
  }
  return resolved;
}

function getRelativePath(directory, argsPath) {
  if (!argsPath) return null;
  return isAbsolute(argsPath) ? relative(directory, argsPath) : argsPath;
}

function isPathInsideIndex(argsPath, directory) {
  if (!argsPath) return true;
  if (!isAbsolute(argsPath)) return true;
  return argsPath.startsWith(directory + "/") || argsPath === directory;
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
async function fetchGrepPages(
  finder,
  pattern,
  baseOpts,
  targetLimit,
  abortSignal,
  client,
) {
  if (process.env.DEBUG_GREP)
    console.error("[GREP-DEBUG] fetchGrepPages:", {
      pattern,
      targetLimit,
      mode: baseOpts.mode,
    });
  const items = [];
  let cursor = null;
  let regexFallbackError = null;
  let emptyRetry = 0;
  const MAX_EMPTY_RETRIES = 3;
  const maxPages = Math.ceil(targetLimit / 50) + 2;
  let page = 0;
  while (page < maxPages) {
    if (abortSignal?.aborted) break;
    const opts = { ...baseOpts, cursor, timeBudgetMs: GREP_TIME_BUDGET_MS };
    const result = finder.grep(pattern, opts);
    if (process.env.DEBUG_GREP)
      console.error(
        "[GREP-DEBUG] finder.grep page",
        page,
        "ok:",
        result.ok,
        "error:",
        result.error,
        "items:",
        result.value?.items?.length,
        "totalFilesSearched:",
        result.value?.totalFilesSearched,
      );
    if (!result.ok) break;
    const pageResult = result.value;
    if (process.env.DEBUG_GREP)
      console.error(
        "[GREP-DEBUG] pageResult:",
        JSON.stringify(pageResult).substring(0, 300),
      );
    // When totalFilesSearched is 0 but items are empty, the content/bigram index
    // may still be building (concurrent tests can start before it is fully ready).
    // Retry with a small back-off so the index catch-up completes before we give up.
    if (
      pageResult.totalFilesSearched === 0 &&
      items.length === 0 &&
      !abortSignal?.aborted &&
      emptyRetry < MAX_EMPTY_RETRIES
    ) {
      emptyRetry++;
      if (process.env.DEBUG_GREP)
        console.error(
          "[GREP-DEBUG] empty (totalFilesSearched=0), retry",
          emptyRetry,
          "for:",
          pattern,
        );
      await new Promise((resolve) => setTimeout(resolve, 100 * emptyRetry));
      continue; // same cursor, same page
    }
    if (emptyRetry > 0) {
      if (process.env.DEBUG_GREP)
        console.error(
          "[GREP-DEBUG] recovered after",
          emptyRetry,
          "retries, filesSearched:",
          pageResult.totalFilesSearched,
        );
    }
    if (pageResult.regexFallbackError && !regexFallbackError) {
      regexFallbackError = pageResult.regexFallbackError;
    }
    // If fff returned results in regex mode but had a fallback error, log it
    // so we know the "regex" → "literal" fallback happened.
    if (pageResult.regexFallbackError && client) {
      await safeLog(
        client,
        "warn",
        `fff regex fallback: ${pageResult.regexFallbackError}`,
      );
    }
    if (!Array.isArray(pageResult.items) || pageResult.items.length === 0)
      break;
    items.push(...pageResult.items);
    if (items.length >= targetLimit) break;
    if (!pageResult.nextCursor) break;
    cursor = pageResult.nextCursor;
    page++;
  }
  if (process.env.DEBUG_GREP)
    console.error("[GREP-DEBUG] fetchGrepPages total:", {
      pattern,
      totalItems: items.length,
      regexFallbackError,
    });
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
  } catch (e) {
    console.error(`[fff-plugin] log failed (${level}):`, message, e?.message);
  }
}

/**
 * Wait for the scan to complete or timeout.
 * @param {Promise} scanPromise - The scan promise to wait for
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<boolean>} - True if scan completed, false otherwise
 */
async function waitForScan(scanPromise, timeoutMs) {
  if (process.env.DEBUG_GREP)
    console.error(
      "[GREP-DEBUG] waitForScan START, scanPromise type:",
      typeof scanPromise,
      scanPromise === undefined
        ? "UNDEF"
        : scanPromise === null
          ? "NULL"
          : "obj",
    );
  try {
    const resolved = await Promise.race([
      scanPromise.then((v) => {
        if (process.env.DEBUG_GREP)
          console.error(
            "[GREP-DEBUG] scanPromise resolved to:",
            JSON.stringify(v),
          );
        return true;
      }),
      new Promise((resolve) =>
        setTimeout(() => {
          if (process.env.DEBUG_GREP)
            console.error("[GREP-DEBUG] waitForScan TIMEOUT");
          resolve(false);
        }, timeoutMs),
      ),
    ]);
    if (process.env.DEBUG_GREP)
      console.error("[GREP-DEBUG] waitForScan RESULT:", resolved);
    return resolved;
  } catch (e) {
    if (process.env.DEBUG_GREP)
      console.error("[GREP-DEBUG] waitForScan CATCH:", e.message);
    return false;
  }
}
/**
 * Grep a single file by reading it directly (100% recall, bypasses fff).
 * Handles Unicode patterns correctly (uses regex `u` flag).
 */
async function directFileGrep(filePath, basePath, pattern, ctxLines) {
  // Enforce path traversal protection before reading the file
  filePath = resolvePath(basePath, filePath);
  const rel = relative(basePath, filePath);
  const fileName = rel.split("/").pop();
  let content;
  try {
    content = await fsPromises.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n");
  const results = [];
  let re;
  try {
    // ReDoS mitigation: Cap pattern length before regex compilation
    if (pattern && pattern.length > 200) pattern = pattern.slice(0, 200);
    const hasUpper = /[A-Z]/.test(pattern);
    re = new RegExp(pattern, hasUpper ? "gu" : "giu");
  } catch {
    try {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    } catch {
      return [];
    }
  }
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) {
      results.push({
        relativePath: rel,
        fileName,
        lineNumber: i + 1,
        lineContent: lines[i],
        contextBefore:
          ctxLines > 0 ? lines.slice(Math.max(0, i - ctxLines), i) : undefined,
        contextAfter:
          ctxLines > 0 ? lines.slice(i + 1, i + 1 + ctxLines) : undefined,
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

function parsePatterns(str) {
  if (!str) return null;
  const arr = str
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return arr.length > 0 ? arr : null;
}

/**
 * Shared helper to determine if a file should be included based on include/exclude patterns.
 * Accepts pre-parsed pattern arrays (from parsePatterns) to avoid repeated splitting in loops.
 */
function shouldIncludeFile(
  relativePath,
  fileName,
  includePatterns,
  excludePatterns,
) {
  if (includePatterns) {
    const matches = includePatterns.some(
      (pat) =>
        minimatch(fileName, pat, { dot: true }) ||
        minimatch(relativePath, pat, { dot: true }),
    );
    if (!matches) return false;
  }
  if (excludePatterns) {
    const excluded = excludePatterns.some(
      (pat) =>
        minimatch(fileName, pat, { dot: true }) ||
        minimatch(relativePath, pat, { dot: true }) ||
        relativePath
          .split("/")
          .some((part) => minimatch(part, pat, { dot: true })),
    );
    if (excluded) return false;
  }
  return true;
}

/**
 * Shared helper to apply minimatch filtering to an array of items.
 */
function applyMinimatchFilter(items, include, exclude) {
  const incPats = parsePatterns(include);
  const excPats = parsePatterns(exclude);
  if (!incPats && !excPats) return items;
  return items.filter((m) =>
    shouldIncludeFile(m.relativePath, m.fileName, incPats, excPats),
  );
}

/**
 * Shared helper to read a file and grep its lines.
 */
async function searchInFile(
  fullPath,
  rel,
  entryName,
  re,
  ctxLines,
  limit,
  results,
  state,
) {
  let content;
  try {
    content = await fsPromises.readFile(fullPath, "utf8");
  } catch {
    return false;
  }
  state.filesRead++;
  const lines = content.split("\n");
  if (process.env.DEBUG_GREP)
    console.error(
      "[GREP-DEBUG] fsGrep testing file:",
      rel,
      "lines:",
      lines.length,
    );
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) {
      state.linesTested++;
      results.push({
        relativePath: rel,
        fileName: entryName,
        lineNumber: i + 1,
        lineContent: lines[i],
        contextBefore:
          ctxLines > 0 ? lines.slice(Math.max(0, i - ctxLines), i) : undefined,
        contextAfter:
          ctxLines > 0 ? lines.slice(i + 1, i + 1 + ctxLines) : undefined,
      });
      if (limit && results.length >= limit) {
        return true;
      }
    }
  }
  return false;
}

async function fsGrep(
  dir,
  basePath,
  pattern,
  ctxLines,
  pathFilter,
  include,
  exclude,
  limit,
) {
  if (process.env.DEBUG_GREP)
    console.error("[GREP-DEBUG] fsGrep called:", {
      dir: dir?.substring(0, 80),
      basePath: basePath?.substring(0, 80),
      pattern,
      hasPathFilter: !!pathFilter,
      include,
      exclude,
      limit,
    });
  // ReDoS mitigation: Cap pattern length before regex compilation
  if (pattern && pattern.length > 200) pattern = pattern.slice(0, 200);
  const hasUpper = /[A-Z]/.test(pattern);
  const shouldSkip = await loadGitignoreFilter(basePath);
  const incPats = parsePatterns(include);
  const excPats = parsePatterns(exclude);
  let re;
  try {
    re = new RegExp(pattern, hasUpper ? "gu" : "giu");
  } catch {
    try {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    } catch {
      return [];
    }
  }
  const results = [];
  const stack = [dir];
  const state = { filesRead: 0, linesTested: 0 };
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true });
    } catch (e) {
      if (process.env.DEBUG_GREP)
        console.error(
          "[GREP-DEBUG] fsGrep readdirSync error:",
          current,
          e.message,
        );
      continue;
    }
    if (process.env.DEBUG_GREP)
      console.error(
        "[GREP-DEBUG] fsGrep dir:",
        current?.substring(0, 80),
        "entries:",
        entries.length,
      );
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
      if (
        pathFilter &&
        !filterByPath([{ relativePath: rel }], "relativePath", pathFilter)
          .length
      )
        continue;
      // Apply include/exclude filters
      if (!shouldIncludeFile(rel, entry.name, incPats, excPats)) continue;

      // Read and grep
      const limitReached = await searchInFile(
        fullPath,
        rel,
        entry.name,
        re,
        ctxLines,
        limit,
        results,
        state,
      );
      if (limitReached) {
        return results;
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
async function globWalk(dir, pattern, basePath, limit, type) {
  const shouldSkip = await loadGitignoreFilter(basePath);
  const results = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      const rel = relative(basePath, fullPath);
      if (entry.isDirectory()) {
        const isSkipped = shouldSkip(entry.name, true);
        if (!isSkipped) {
          stack.push(fullPath);
        }
        if (type !== "file" && !isSkipped) {
          const dirMatch =
            minimatch(rel, pattern, { dot: true }) ||
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
async function performGrepRouting(
  directory,
  finder,
  client,
  args,
  ctxLines,
  limit,
  context,
) {
  let resolvedFilePath = null;
  let hasNonAscii = false;
  if (args.path) {
    const resolvedPath = isAbsolute(args.path)
      ? args.path
      : join(directory, args.path);
    try {
      if (existsSync(resolvedPath) && statSync(resolvedPath).isFile()) {
        resolvedFilePath = resolvedPath;
      }
    } catch {
      /* treat as directory */
    }
  }

  let matches = [];
  let regexFallbackError = null;

  if (resolvedFilePath) {
    // Single-file: direct Node.js read for 100% recall
    matches = await directFileGrep(
      resolvedFilePath,
      directory,
      args.pattern,
      ctxLines,
    );
  } else {
    // Directory search: check for non-ASCII (Unicode) patterns
    hasNonAscii = [...args.pattern].some((c) => c.charCodeAt(0) > 127);
    if (hasNonAscii) {
      // Unicode patterns: fs-based search (fff normalizes ş↔s causing overcount)
      const searchDir = isAbsolute(args.path || "")
        ? args.path
        : join(directory, args.path || "");
      const pathRel = getRelativePath(directory, args.path);
      matches = await fsGrep(
        searchDir,
        directory,
        args.pattern,
        ctxLines,
        pathRel,
        args.include,
        args.exclude,
        limit,
      );
    } else {
      // ASCII patterns: use fff indexed search if available
      if (finder) {
        const mode = detectGrepMode(args.pattern);
        const baseOpts = {
          mode,
          smartCase: args.caseSensitive !== true,
          beforeContext: ctxLines,
          afterContext: ctxLines,
          maxMatchesPerFile: limit,
        };
        const result = await fetchGrepPages(
          finder,
          args.pattern,
          baseOpts,
          limit,
          context.abort.signal,
          client,
        );
        matches = result.items;
        regexFallbackError = result.regexFallbackError;

        if (matches.length === 0 && mode === "plain") {
          const retryOpts = { ...baseOpts, mode: "regex" };
          const retry = await fetchGrepPages(
            finder,
            args.pattern,
            retryOpts,
            limit,
            context.abort.signal,
            client,
          );
          if (retry.items.length > 0) {
            matches = retry.items;
            regexFallbackError = retry.regexFallbackError;
          }
        }
        // Post-filter by path
        if (args.path && matches.length > 0) {
          const relativeTarget = getRelativePath(directory, args.path);
          matches = filterByPath(matches, "relativePath", relativeTarget);
        }
        // Post-filter by include/exclude
        if (matches.length > 0) {
          matches = applyMinimatchFilter(matches, args.include, args.exclude);
        }
      }
      // fsGrep fallback: when fff unavailable or returned nothing
      if (!matches || matches.length === 0) {
        const fallbackDir = resolvePath(directory, args.path);
        if (existsSync(fallbackDir)) {
          const pathRel = getRelativePath(directory, args.path);
          matches = await fsGrep(
            fallbackDir,
            directory,
            args.pattern,
            ctxLines,
            pathRel,
            args.include,
            args.exclude,
            limit,
          );
        }
      }
    }
  }
  return { matches, regexFallbackError };
}

const instances = new Map();

/**
 * Lazily import fff-native, avoiding Bun-on-Windows module-graph crash.
 * Safe to call multiple times (idempotent via FileFinder guard).
 */
async function lazyFff(client) {
  if (FileFinder) return;
  try {
    // Detecting Bun vs Node.js runtime
    if (typeof Bun !== "undefined") {
      const mod = await import("@ff-labs/fff-bun");
      FileFinder = mod.FileFinder;
    } else {
      const mod = await import("@ff-labs/fff-node");
      FileFinder = mod.FileFinder;
    }
  } catch (e) {
    await safeLog(client, "warn", `fff-native import failed: ${e.message}`);
  }
}

/**
 * Main plugin entry point - aligned with @opencode-ai/plugin SDK
 */
export default async (input) => {
  let { directory, client } = input;
  try {
    await lazyFff(client);
    if (typeof directory === "object" && directory !== null) {
      directory = directory.fsPath || directory.path || String(directory);
    }
    await safeLog(client, "info", `Initializing in ${directory}`);

    // fff-native not imported at module level to avoid Bun-on-Windows
    // createRequire crash during module graph construction.

    if (!instances.has(directory)) {
      let finder = null;
      let scanPromise = Promise.resolve(false);
      if (FileFinder) {
        let initResult;
        try {
          initResult = FileFinder.create({
            basePath: directory,
            aiMode: true,
            disableMmapCache: false,
            disableContentIndexing: false,
            disableWatch: false,
          });
        } catch (e) {
          await safeLog(
            client,
            "warn",
            `fff native unavailable: ${e.message} — fallback to fs-only mode`,
          );
        }
        if (initResult) {
          if (!initResult.ok) {
            await safeLog(
              client,
              "warn",
              `fff init failed: ${initResult.error} — fallback to fs-only mode`,
            );
          } else {
            finder = initResult.value;
            if (process.env.DEBUG_GREP)
              console.error("[GREP-DEBUG] Created finder for:", directory);
            const rawScan = finder.waitForScan(SCAN_TIMEOUT_MS);
            scanPromise = Promise.resolve(rawScan).catch(() => undefined);
            scanPromise.then(() =>
              safeLog(client, "info", "Initial fff scan complete"),
            );
            scanPromise.catch((e) => {
              if (process.env.DEBUG_GREP)
                console.error("[GREP-DEBUG] scanPromise ERROR:", e.message);
            });
          }
        }
      } else {
        await safeLog(
          client,
          "info",
          "fff-native not available — fallback to fs-only mode",
        );
      }
      instances.set(directory, { finder, scanPromise });
    }

    const { finder, scanPromise } = instances.get(directory);

    return {
      tool: {
        grep: tool({
          description:
            "Search file contents using fff (fast, typo-resistant, frecency-ranked).",
          args: {
            pattern: tool.schema
              .string()
              .describe("Search pattern (literal text or regex)"),
            path: tool.schema
              .string()
              .optional()
              .describe(
                "File or directory to search in (absolute or relative)",
              ),
            include: tool.schema
              .string()
              .optional()
              .describe('File pattern to include (e.g. "*.vue", "*.{ts,tsx}")'),
            exclude: tool.schema
              .string()
              .optional()
              .describe("Comma-separated glob patterns to exclude"),
            caseSensitive: tool.schema
              .boolean()
              .optional()
              .describe("Force case-sensitive search (default: smart case)"),
            context: tool.schema
              .number()
              .optional()
              .describe("Context lines before/after each match (default: 0)"),
            limit: tool.schema
              .number()
              .optional()
              .describe("Max matches to return (default: 100, max: 5000)"),
          },
          async execute(args, context) {
            try {
              if (
                !args.pattern ||
                typeof args.pattern !== "string" ||
                args.pattern.trim() === ""
              ) {
                throw new Error("pattern must be a non-empty string");
              }
              if (
                args.limit != null &&
                (typeof args.limit !== "number" ||
                  args.limit < 1 ||
                  args.limit > MAX_LIMIT)
              ) {
                throw new Error(
                  `limit must be a number between 1 and ${MAX_LIMIT}`,
                );
              }
              if (
                args.context &&
                (typeof args.context !== "number" || args.context < 0)
              ) {
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
                const resolvedPath = isAbsolute(args.path)
                  ? args.path
                  : join(directory, args.path);
                try {
                  if (
                    existsSync(resolvedPath) &&
                    statSync(resolvedPath).isFile()
                  ) {
                    resolvedFilePath = resolvedPath;
                  }
                } catch {
                  /* treat as directory */
                }
              }

              let matches;
              let regexFallbackError = null;
              const ctxLines = args.context ?? 0;

              if (resolvedFilePath) {
                // Single-file: direct Node.js read for 100% recall
                matches = await directFileGrep(
                  resolvedFilePath,
                  directory,
                  args.pattern,
                  ctxLines,
                );
              } else {
                // Directory search: check for non-ASCII (Unicode) patterns
                hasNonAscii = [...args.pattern].some(
                  (c) => c.charCodeAt(0) > 127,
                );
                if (hasNonAscii) {
                  // Unicode patterns: fs-based search (fff normalizes ş↔s causing overcount)
                  const searchDir = isAbsolute(args.path || "")
                    ? args.path
                    : join(directory, args.path || "");
                  const pathRel = getRelativePath(directory, args.path);
                  matches = await fsGrep(
                    searchDir,
                    directory,
                    args.pattern,
                    ctxLines,
                    pathRel,
                    args.include,
                    args.exclude,
                    limit,
                  );
                } else {
                  // ASCII patterns: use fff's indexed search
                  if (finder && isPathInsideIndex(args.path, directory)) {
                    if (process.env.DEBUG_GREP)
                      console.error(
                        "[GREP-DEBUG] fff routing, pattern:",
                        args.pattern,
                        "directory:",
                        directory.substring(0, 50),
                      );
                    const mode = detectGrepMode(args.pattern);
                    const baseOpts = {
                      mode,
                      smartCase: args.caseSensitive !== true,
                      beforeContext: ctxLines,
                      afterContext: ctxLines,
                      maxMatchesPerFile: limit,
                    };
                    const result = await fetchGrepPages(
                      finder,
                      args.pattern,
                      baseOpts,
                      limit,
                      context.abort.signal,
                      client,
                    );
                    matches = result.items;
                    regexFallbackError = result.regexFallbackError;

                    if (matches.length === 0 && mode === "plain") {
                      const retryOpts = { ...baseOpts, mode: "regex" };
                      const retry = await fetchGrepPages(
                        finder,
                        args.pattern,
                        retryOpts,
                        limit,
                        context.abort.signal,
                        client,
                      );
                      if (retry.items.length > 0) {
                        matches = retry.items;
                        regexFallbackError = retry.regexFallbackError;
                      }
                    }
                  }
                  // Post-filter fff results by path
                  if (args.path && matches?.length > 0) {
                    const relativeTarget = getRelativePath(
                      directory,
                      args.path,
                    );
                    matches = filterByPath(
                      matches,
                      "relativePath",
                      relativeTarget,
                    );
                  }
                  // Post-filter fff results by include/exclude
                  if (matches?.length > 0) {
                    matches = applyMinimatchFilter(
                      matches,
                      args.include,
                      args.exclude,
                    );
                  }
                  // Failsafe: use filesystem-level grep when fff unavailable or empty
                  if (!matches || matches.length === 0) {
                    const fallbackDir = resolvePath(directory, args.path);
                    if (process.env.DEBUG_GREP)
                      console.error(
                        "[GREP-DEBUG] fsGrep failsafe, pattern:",
                        args.pattern,
                        "fallbackDir:",
                        fallbackDir,
                      );
                    if (existsSync(fallbackDir)) {
                      const pathRel = getRelativePath(directory, args.path);
                      matches = await fsGrep(
                        fallbackDir,
                        directory,
                        args.pattern,
                        ctxLines,
                        pathRel,
                        args.include,
                        args.exclude,
                        limit,
                      );
                    }
                  }
                }
              }

              if (matches.length === 0) {
                if (process.env.DEBUG_GREP)
                  console.error(
                    "[GREP-DEBUG] matches.length === 0, returning empty for pattern:",
                    args.pattern,
                  );
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
                    output.push(
                      `${m.relativePath}:${m.lineNumber - m.contextBefore.length + i}:${m.contextBefore[i]}`,
                    );
                  }
                }
                output.push(
                  `${m.relativePath}:${m.lineNumber}:${m.lineContent}`,
                );
                if (m.contextAfter?.length) {
                  for (let i = 0; i < m.contextAfter.length; i++) {
                    output.push(
                      `${m.relativePath}:${m.lineNumber + i + 1}:${m.contextAfter[i]}`,
                    );
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
          description:
            "Find files and directories using fff's fast fuzzy search.",
          args: {
            pattern: tool.schema
              .string()
              .describe("Glob pattern (e.g. '**/*.ts') or fuzzy query"),
            path: tool.schema
              .string()
              .optional()
              .describe("Directory to search in (absolute or relative)"),
            type: tool.schema
              .enum(["file", "directory"])
              .optional()
              .describe("Filter by type (default: file)"),
            limit: tool.schema
              .number()
              .optional()
              .describe("Max results to return (default: 100, max: 5000)"),
          },
          async execute(args, context) {
            try {
              if (
                !args.pattern ||
                typeof args.pattern !== "string" ||
                args.pattern.trim() === ""
              ) {
                throw new Error("pattern must be a non-empty string");
              }
              if (
                args.limit != null &&
                (typeof args.limit !== "number" ||
                  args.limit < 1 ||
                  args.limit > MAX_LIMIT)
              ) {
                throw new Error(
                  `limit must be a number between 1 and ${MAX_LIMIT}`,
                );
              }

              if (context.abort.aborted) throw new Error("Aborted");

              await waitForScan(scanPromise, TOOL_TIMEOUT_MS);
              if (context.abort.aborted) throw new Error("Aborted");

              const userLimit = args.limit || DEFAULT_GLOB_LIMIT;
              const searchDir = resolvePath(directory, args.path);
              const isMetachar = GLOB_METACHAR_RE.test(args.pattern);
              // Increase internal page size when filtering by path or when the pattern
              // has glob metacharacters (the minimatch post-filter needs more candidates)
              const pageSize =
                args.path || isMetachar ? Math.max(userLimit, 1000) : userLimit;
              let items;
              const walkLimit = Math.max(userLimit, 100);
              // fff native unavailable — fall back to filesystem glob walking
              if (!finder) {
                items = await globWalk(
                  searchDir,
                  args.pattern,
                  directory,
                  walkLimit,
                  args.type,
                );
              } else if (args.type === "directory" && isMetachar) {
                items = await globWalk(
                  searchDir,
                  args.pattern,
                  directory,
                  walkLimit,
                  "directory",
                );
              } else if (args.type === "directory") {
                const dirResult = finder.directorySearch(args.pattern, {
                  pageSize,
                });
                if (!dirResult.ok)
                  throw new Error(`fff dirSearch error: ${dirResult.error}`);
                items = (dirResult.value?.items || []).map((item) => ({
                  relativePath: item.relativePath || item.path || "",
                  fileName:
                    item.fileName ||
                    (item.relativePath || item.path || "").split("/").pop() ||
                    "",
                }));
              } else {
                const fileResult = finder.fileSearch(args.pattern, {
                  pageSize,
                });
                if (!fileResult.ok)
                  throw new Error(`fff fileSearch error: ${fileResult.error}`);
                items = (fileResult.value?.items || []).map((item) => ({
                  relativePath: item.relativePath || item.path || "",
                  fileName:
                    item.fileName ||
                    (item.relativePath || item.path || "").split("/").pop() ||
                    "",
                }));
              }
              if (!Array.isArray(items) || items.length === 0) {
                return {
                  title: args.path
                    ? relative(directory, searchDir)
                    : args.pattern,
                  output: "No files found",
                  metadata: { count: 0, truncated: false },
                };
              }

              // Post-filter with minimatch for metacharacter patterns (exact glob matching
              // on top of fff's fuzzy results)
              if (isMetachar) {
                const globPatterns = args.pattern
                  .split(",")
                  .map((p) => p.trim())
                  .filter(Boolean);
                items = items.filter((item) =>
                  globPatterns.some(
                    (pat) =>
                      minimatch(item.relativePath, pat, { dot: true }) ||
                      minimatch(item.fileName, pat, { dot: true }),
                  ),
                );
              }

              // Filter by path (convert absolute to relative so filterByPath works correctly)
              if (args.path) {
                const relativeTarget = getRelativePath(directory, args.path);
                items = filterByPath(items, "relativePath", relativeTarget);
              }

              // Fallback: if fff returned nothing (or no exact basename match for
              // non-metachar patterns), try globWalk.
              // Non-metachar patterns use fff fuzzy search which may return many
              // inexact matches (e.g., "temp.ts" matches all .ts files). If none
              // of those results is an exact basename match, globWalk finds the
              // real file. Also handles Turkish/Unicode filenames, type=directory.
              if (items.length === 0) {
                const targetType = args.type || "file";
                items = await globWalk(
                  searchDir,
                  args.pattern,
                  directory,
                  walkLimit,
                  targetType,
                );
              } else if (
                !isMetachar &&
                !items.some((item) => item.fileName === args.pattern)
              ) {
                // Fuzzy results don't include the exact file — augment with globWalk
                const targetType = args.type || "file";
                const walkResults = await globWalk(
                  searchDir,
                  args.pattern,
                  directory,
                  walkLimit,
                  targetType,
                );
                const existing = new Set(
                  items.map((item) => item.relativePath),
                );
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
              const absPaths = displayed.map((item) =>
                join(directory, item.relativePath),
              );
              const output = [];
              if (displayed.length === 0) output.push("No files found");
              if (displayed.length > 0) {
                output.push(...absPaths);
                if (truncated) {
                  output.push("");
                  output.push(
                    `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
                  );
                }
              }
              return {
                title: args.path
                  ? relative(directory, searchDir)
                  : args.pattern,
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
  } catch (err) {
    await safeLog(client, "error", `Plugin error: ${err.message}`);
    return { tool: {} };
  }
};

// Single export for testing — prevents getLegacyPlugins() from calling
// each internal function as a separate plugin server() (Bun-on-Windows bug).
export async function __test() {
  return {
    loadGitignoreFilter,
    detectGrepMode,
    filterByPath,
    resolvePath,
    getRelativePath,
    isPathInsideIndex,
    directFileGrep,
    fsGrep,
    globWalk,
    safeLog,
    waitForScan,
    parsePatterns,
    shouldIncludeFile,
    applyMinimatchFilter,
    searchInFile,
    fetchGrepPages,
    lazyFff,
    performGrepRouting,
  };
}
