let tool;
try {
  ({ tool } = await import("@mimo-ai/plugin"));
} catch {
  ({ tool } = await import("@opencode-ai/plugin"));
}
import { relative, join } from "node:path";
import {
  SCAN_TIMEOUT_MS,
  TOOL_TIMEOUT_MS,
  MAX_LIMIT,
  DEFAULT_GREP_LIMIT,
  DEFAULT_GLOB_LIMIT,
  GLOB_METACHAR_RE,
} from "./constants.js";
import {
  resolvePath,
  getRelativePath,
  isPathInsideIndex,
  safeLog,
  waitForScan,
  debugLog,
} from "./helpers.js";
import {
  filterByPath,
  parsePatterns,
  compilePatterns,
  shouldIncludeFile,
  shouldIncludeCompiled,
  applyMinimatchFilter,
} from "./filters.js";
import {
  detectGrepMode,
  directFileGrep,
  fsGrep,
  globWalk,
  fetchGrepPages,
  performGrepRouting,
  searchInFile,
} from "./search.js";
import { loadGitignoreFilter } from "./gitignore.js";

let FileFinder = null;
const instances = new Map();

async function lazyFff(client) {
  if (FileFinder) return;
  try {
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

const plugin = async (input) => {
  let { directory, client } = input;
  try {
    await lazyFff(client);
    if (typeof directory === "object" && directory !== null) {
      directory = directory.fsPath || directory.path || String(directory);
    }
    await safeLog(client, "info", `Initializing in ${directory}`);

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
            debugLog("Created finder for:", directory);
            const rawScan = finder.waitForScan(SCAN_TIMEOUT_MS);
            scanPromise = Promise.resolve(rawScan).catch(() => undefined);
            scanPromise.then(() =>
              safeLog(client, "info", "Initial fff scan complete"),
            );
            scanPromise.catch((e) => {
              debugLog("scanPromise ERROR:", e.message);
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
              const ctxLines = args.context ?? 0;

              const { matches, regexFallbackError } = await performGrepRouting(
                directory,
                finder,
                client,
                args,
                ctxLines,
                limit,
                context,
                isPathInsideIndex,
              );

              if (matches.length === 0) {
                debugLog(
                  "matches.length === 0, returning empty for pattern:",
                  args.pattern,
                );
                return {
                  title: args.pattern,
                  metadata: { matches: 0, truncated: false },
                  output: "",
                };
              }
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
              const pageSize =
                args.path || isMetachar ? Math.max(userLimit, 1000) : userLimit;
              let items;
              const walkLimit = Math.max(userLimit, 100);
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

              if (isMetachar) {
                items = applyMinimatchFilter(items, args.pattern, null);
              }

              if (args.path) {
                const relativeTarget = getRelativePath(directory, args.path);
                items = filterByPath(items, "relativePath", relativeTarget);
              }

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

export default plugin;
export { plugin as server };

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
    debugLog,
    parsePatterns,
    compilePatterns,
    shouldIncludeFile,
    shouldIncludeCompiled,
    applyMinimatchFilter,
    searchInFile,
    fetchGrepPages,
    lazyFff,
    performGrepRouting,
  };
}
