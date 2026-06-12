import { join } from "node:path";
import { promises as fsPromises } from "node:fs";
import { SKIP_DIRS } from "./constants.js";

const _gitignoreCache = new Map();

export async function loadGitignoreFilter(basePath) {
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
