import { Minimatch } from "minimatch";
import { ROOT_PATH_RE, TRAILING_SLASH_RE } from "./constants.js";

export function compilePatterns(patterns) {
  if (!patterns) return null;
  return patterns.map((p) => new Minimatch(p, { dot: true }));
}

export function parsePatterns(str) {
  if (!str) return null;
  const arr = str
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return arr.length > 0 ? arr : null;
}

export function shouldIncludeCompiled(relativePath, fileName, incMm, excMm) {
  const parts = relativePath.split("/");
  if (incMm) {
    const matches = incMm.some(
      (mm) => mm.match(fileName) || mm.match(relativePath),
    );
    if (!matches) return false;
  }
  if (excMm) {
    const excluded = excMm.some(
      (mm) =>
        mm.match(fileName) ||
        mm.match(relativePath) ||
        parts.some((part) => mm.match(part)),
    );
    if (excluded) return false;
  }
  return true;
}

export function shouldIncludeFile(
  relativePath,
  fileName,
  includePatterns,
  excludePatterns,
) {
  return shouldIncludeCompiled(
    relativePath,
    fileName,
    compilePatterns(includePatterns),
    compilePatterns(excludePatterns),
  );
}

export function applyMinimatchFilter(items, include, exclude) {
  const incMm = compilePatterns(parsePatterns(include));
  const excMm = compilePatterns(parsePatterns(exclude));
  if (!incMm && !excMm) return items;
  return items.filter((m) =>
    shouldIncludeCompiled(m.relativePath, m.fileName, incMm, excMm),
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
