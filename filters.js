import { minimatch } from "minimatch";
import { ROOT_PATH_RE, TRAILING_SLASH_RE } from "./constants.js";

export function parsePatterns(str) {
  if (!str) return null;
  const arr = str
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return arr.length > 0 ? arr : null;
}

export function shouldIncludeFile(
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

export function applyMinimatchFilter(items, include, exclude) {
  const incPats = parsePatterns(include);
  const excPats = parsePatterns(exclude);
  if (!incPats && !excPats) return items;
  return items.filter((m) =>
    shouldIncludeFile(m.relativePath, m.fileName, incPats, excPats),
  );
}

export function filterByPath(items, pathKey, targetPath) {
  if (!targetPath) return items;
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
