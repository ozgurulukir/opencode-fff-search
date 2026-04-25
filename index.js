import { tool } from "@opencode-ai/plugin";
import { FileFinder } from "@ff-labs/fff-node";
import { minimatch } from "minimatch";

/**
 * FFF Plugin - Replaces OpenCode's default file search (grep, glob)
 * with fff.nvim's fast, typo-resistant, frecency-ranked search.
 *
 * This plugin overrides the built-in `grep` and `glob` tools with
 * implementations powered by fff.nvim's Rust core via the Node SDK.
 *
 * Prerequisites:
 * - fff.nvim binary will be downloaded automatically on first use.
 * - Neovim is NOT required; this uses the Node.js SDK.
 */

export const FffPlugin = async ({ directory, client }) => {
  // Initialize FileFinder for the project directory
  const initResult = FileFinder.create({
    basePath: directory,
    aiMode: true,
    // You can customize options here (e.g., disableWatch, logFilePath)
  });

  if (!initResult.ok) {
    await client.app.log({
      body: {
        service: "fff-plugin",
        level: "error",
        message: `Failed to initialize fff: ${initResult.error}`,
      },
    });
    throw new Error(`fff initialization failed: ${initResult.error}`);
  }

  const finder = initResult.value;

  // Create a promise that resolves when the initial scan completes.
  // This avoids waiting on every tool call - we await the same promise.
  const scanPromise = finder.waitForScan(10000).catch((err) => {
    client.app.log({
      body: {
        service: "fff-plugin",
        level: "warn",
        message: `Initial fff scan incomplete: ${err}`,
      },
    });
  });

  return {
    tool: {
      /**
       * Override built-in grep with fff's fast content search.
       * Supports plain, regex, and fuzzy modes with smart-case.
       */
      grep: tool({
        description:
          "Search file contents using fff (fast, typo-resistant, frecency-ranked).",
        args: {
          pattern: tool.schema.string().describe("Search pattern (plain text, regex, or fuzzy)"),
          path: tool.schema.string().optional().describe("Subdirectory or file to search within"),
          exclude: tool.schema.string().optional().describe("Glob patterns to exclude (comma-separated)"),
          caseSensitive: tool.schema.boolean().optional().describe("Case-sensitive matching (default: smart-case)"),
          context: tool.schema.number().optional().describe("Number of context lines before/after match"),
          limit: tool.schema.number().optional().describe("Maximum total matches to return (default: 1000)"),
        },
        async execute(args, context) {
          // Wait for initial scan if still running
          await scanPromise;

          const opts = {
            smartCase: args.caseSensitive !== true, // default: true (smart-case)
            beforeContext: args.context ?? 0,
            afterContext: args.context ?? 0,
            maxMatchesPerFile: args.limit ? Math.min(args.limit, 500) : 100, // respect limit but cap per-file
          };

          const result = finder.grep(args.pattern, opts);
          if (!result.ok) {
            throw new Error(`fff grep error: ${result.error}`);
          }

          let matches = result.value.items;

          // Filter by path if provided
          if (args.path) {
            const target = args.path.replace(/\/+$/, ""); // remove trailing slash
            matches = matches.filter((m) => {
              const rel = m.relativePath;
              return rel === target || rel.startsWith(target + "/");
            });
          }

          // Exclude filtering using minimatch for full glob support
          if (args.exclude) {
            const patterns = args.exclude
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
            matches = matches.filter((m) => {
              const rel = m.relativePath;
              return !patterns.some((pat) => minimatch(rel, pat, { dot: true }));
            });
          }

          // Apply overall limit
          const totalMatches = matches.length;
          const limit = Math.max(1, args.limit || 1000);
          const truncated = totalMatches > limit;
          const returnedMatches = truncated ? matches.slice(0, limit) : matches;

          // Set metadata for debugging/UI
          context.metadata({
            totalMatches,
            returnedMatches: returnedMatches.length,
            truncated,
            scanComplete: (await scanPromise) !== undefined,
          });

          // Transform to OpenCode's expected grep output format
          return returnedMatches.map((m) => ({
            path: m.relativePath,
            line_number: m.lineNumber,
            line: m.lineContent,
            lines: [m.lineContent],
            submatches: [], // fff provides matchRanges for highlighting but not submatches
          }));
        },
      }),

      /**
       * Override built-in glob with fff's fast fuzzy file search.
       * Supports fuzzy matching, frecency ranking, and git status awareness.
       */
      glob: tool({
        description: "Find files and directories by pattern using fff's fast fuzzy search.",
        args: {
          pattern: tool.schema.string().describe("Search pattern (fuzzy, glob, or plain)"),
          path: tool.schema.string().optional().describe("Subdirectory to search within"),
          type: tool.schema.enum(["file", "directory"]).optional().describe("Filter by type"),
          limit: tool.schema.number().optional().describe("Maximum number of results (default: 100)"),
        },
        async execute(args, context) {
          await scanPromise;

          // Validate and normalize limit
          const pageSize = Math.max(1, args.limit || 100);

          let result;
          let totalCount;

          if (args.type === "directory") {
            const dirResult = finder.dirSearch(args.pattern, { pageSize });
            if (!dirResult.ok) {
              throw new Error(`fff dirSearch error: ${dirResult.error}`);
            }
            result = dirResult.value.items.map((d) => d.relativePath);
            totalCount = dirResult.value.totalCount;
          } else {
            const fileResult = finder.fileSearch(args.pattern, { pageSize });
            if (!fileResult.ok) {
              throw new Error(`fff fileSearch error: ${fileResult.error}`);
            }
            result = fileResult.value.items.map((f) => f.relativePath);
            totalCount = fileResult.value.totalCount;
          }

          // Filter by path if provided
          if (args.path) {
            const target = args.path.replace(/\/+$/, "");
            result = result.filter((p) => p === target || p.startsWith(target + "/"));
          }

          // Return as object with both results and metadata
          return {
            output: result,
            metadata: {
              totalResults: totalCount,
              returnedResults: result.length,
              truncated: result.length < totalCount,
            },
          };
        },
      }),
    },
  };
};
