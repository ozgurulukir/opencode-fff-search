import { join, relative } from "node:path";
import { statSync, existsSync } from "node:fs";
import { promises as fsPromises } from "node:fs";
import { minimatch } from "minimatch";
import { GREP_TIME_BUDGET_MS } from "./constants.js";
import { resolvePath, getRelativePath, safeLog, debugLog } from "./helpers.js";
import {
  parsePatterns,
  shouldIncludeFile,
  applyMinimatchFilter,
  filterByPath,
} from "./filters.js";
import { loadGitignoreFilter } from "./gitignore.js";

export function detectGrepMode(pattern) {
  if (!pattern || typeof pattern !== "string") return "plain";
  const REGEX_METACHAR_RE =
    /\\[sdwnbtDSWNBT]|\\|\||\[\^?\]|\[\^?[^\]]+\]|\\\+|\\\*|\\\?|[\^\$]/;
  return REGEX_METACHAR_RE.test(pattern) ? "regex" : "plain";
}

export async function searchInFile(
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
  debugLog("fsGrep testing file:", rel, "lines:", lines.length);
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

export async function directFileGrep(filePath, basePath, pattern, ctxLines) {
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

export async function fsGrep(
  dir,
  basePath,
  pattern,
  ctxLines,
  pathFilter,
  include,
  exclude,
  limit,
) {
  debugLog("fsGrep called:", {
    dir: dir?.substring(0, 80),
    basePath: basePath?.substring(0, 80),
    pattern,
    hasPathFilter: !!pathFilter,
    include,
    exclude,
    limit,
  });
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
      debugLog("fsGrep readdirSync error:", current, e.message);
      continue;
    }
    debugLog("fsGrep dir:", current?.substring(0, 80), "entries:", entries.length);
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
      if (
        pathFilter &&
        !filterByPath([{ relativePath: rel }], "relativePath", pathFilter)
          .length
      )
        continue;
      if (!shouldIncludeFile(rel, entry.name, incPats, excPats)) continue;

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

export async function globWalk(dir, pattern, basePath, limit, type) {
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

export async function fetchGrepPages(
  finder,
  pattern,
  baseOpts,
  targetLimit,
  abortSignal,
  client,
) {
  debugLog("fetchGrepPages:", { pattern, targetLimit, mode: baseOpts.mode });
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
    debugLog(
      "finder.grep page",
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
    debugLog("pageResult:", JSON.stringify(pageResult).substring(0, 300));
    if (
      pageResult.totalFilesSearched === 0 &&
      items.length === 0 &&
      !abortSignal?.aborted &&
      emptyRetry < MAX_EMPTY_RETRIES
    ) {
      emptyRetry++;
      debugLog("empty (totalFilesSearched=0), retry", emptyRetry, "for:", pattern);
      await new Promise((resolve) => setTimeout(resolve, 100 * emptyRetry));
      continue;
    }
    if (emptyRetry > 0) {
      debugLog(
        "recovered after",
        emptyRetry,
        "retries, filesSearched:",
        pageResult.totalFilesSearched,
      );
    }
    if (pageResult.regexFallbackError && !regexFallbackError) {
      regexFallbackError = pageResult.regexFallbackError;
    }
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
  debugLog("fetchGrepPages total:", {
    pattern,
    totalItems: items.length,
    regexFallbackError,
  });
  return { items, regexFallbackError };
}

export async function performGrepRouting(
  directory,
  finder,
  client,
  args,
  ctxLines,
  limit,
  context,
  isPathInsideIndexFn,
) {
  let resolvedFilePath = null;
  let hasNonAscii = false;
  if (args.path) {
    const resolvedPath = resolvePath(directory, args.path);
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
    matches = await directFileGrep(
      resolvedFilePath,
      directory,
      args.pattern,
      ctxLines,
    );
  } else {
    hasNonAscii = [...args.pattern].some((c) => c.charCodeAt(0) > 127);
    if (hasNonAscii) {
      const searchDir = resolvePath(directory, args.path || "");
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
      if (finder && (!isPathInsideIndexFn || isPathInsideIndexFn(args.path, directory))) {
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
        if (args.path && matches.length > 0) {
          const relativeTarget = getRelativePath(directory, args.path);
          matches = filterByPath(matches, "relativePath", relativeTarget);
        }
        if (matches.length > 0) {
          matches = applyMinimatchFilter(matches, args.include, args.exclude);
        }
      }
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
