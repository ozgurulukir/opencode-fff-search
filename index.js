import { tool } from "@opencode-ai/plugin";
import { FileFinder } from "@ff-labs/fff-node";
import { minimatch } from "minimatch";

/**
 * FFF Plugin - Replaces OpenCode's default file search (grep, glob)
 * with fff.nvim's fast, typo-resistant, frecency-ranked search.
 */

export const FffPlugin = async ({ directory, client }) => {
  console.log("🔧 [FFF] Plugin initializing for directory:", directory);

  const initResult = FileFinder.create({
    basePath: directory,
    aiMode: true,
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
  console.log("🔧 [FFF] FileFinder created successfully");

  const scanPromise = finder.waitForScan(10000).catch((err) => {
    console.log("⚠️ [FFF] Scan timeout or error:", err.message);
    client.app.log({
      body: {
        service: "fff-plugin",
        level: "warn",
        message: `Initial fff scan incomplete: ${err}`,
      },
    });
  });

  scanPromise.then(() => {
    console.log("✅ [FFF] Initial scan complete");
  });

  return {
    tool: {
      grep: tool({
        description:
          "Search file contents using fff (fast, typo-resistant, frecency-ranked).",
        args: {
          pattern: tool.schema.string().describe("Search pattern"),
          path: tool.schema.string().optional(),
          exclude: tool.schema.string().optional(),
          caseSensitive: tool.schema.boolean().optional(),
          context: tool.schema.number().optional(),
          limit: tool.schema.number().optional(),
        },
        async execute(args, context) {
          console.log("🔍 [FFF] grep called with:", JSON.stringify(args));
          await scanPromise;

          const opts = {
            smartCase: args.caseSensitive !== true,
            beforeContext: args.context ?? 0,
            afterContext: args.context ?? 0,
            maxMatchesPerFile: args.limit ? Math.min(args.limit, 500) : 100,
          };

          const result = finder.grep(args.pattern, opts);
          if (!result.ok) {
            throw new Error(`fff grep error: ${result.error}`);
          }

          let matches = result.value.items;
          console.log(`🔍 [FFF] Found ${matches.length} matches before filtering`);

          // Path filter - handle both file and directory paths
          if (args.path) {
            const target = args.path.replace(/\/+$/, "");
            matches = matches.filter((m) => {
              const rel = m.relativePath;
              // Match exact file or any file under the directory
              return rel === target || rel.startsWith(target + "/");
            });
            console.log(`🔍 [FFF] After path filter '${args.path}': ${matches.length} matches`);
          }

          // Exclude filter
          if (args.exclude) {
            const patterns = args.exclude
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
            matches = matches.filter((m) => {
              const rel = m.relativePath;
              return !patterns.some((pat) => minimatch(rel, pat, { dot: true }));
            });
            console.log(`🔍 [FFF] After exclude filter: ${matches.length} matches`);
          }

          // Apply limit
          const totalMatches = matches.length;
          const limit = Math.max(1, args.limit || 1000);
          const truncated = totalMatches > limit;
          const returnedMatches = truncated ? matches.slice(0, limit) : matches;

          context.metadata({
            totalMatches,
            returnedMatches: returnedMatches.length,
            truncated,
            scanComplete: (await scanPromise) !== undefined,
          });

          console.log(`🔍 [FFF] Returning ${returnedMatches.length} matches (total: ${totalMatches}, truncated: ${truncated})`);

          return returnedMatches.map((m) => ({
            path: m.relativePath,
            line_number: m.lineNumber,
            line: m.lineContent,
            lines: [m.lineContent],
            submatches: [],
          }));
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
          console.log("📁 [FFF] glob called with:", JSON.stringify(args));
          await scanPromise;

          const pageSize = Math.max(1, args.limit || 100);
          let result;

          if (args.type === "directory") {
            const dirResult = finder.dirSearch(args.pattern, { pageSize });
            if (!dirResult.ok) {
              throw new Error(`fff dirSearch error: ${dirResult.error}`);
            }
            result = dirResult.value.items.map((d) => d.relativePath);
          } else {
            const fileResult = finder.fileSearch(args.pattern, { pageSize });
            if (!fileResult.ok) {
              throw new Error(`fff fileSearch error: ${fileResult.error}`);
            }
            result = fileResult.value.items.map((f) => f.relativePath);
          }

          console.log(`📁 [FFF] Found ${result.length} results`);

          // Path filter
          if (args.path) {
            const target = args.path.replace(/\/+$/, "");
            result = result.filter((p) => p === target || p.startsWith(target + "/"));
            console.log(`📁 [FFF] After path filter: ${result.length} results`);
          }

          return {
            output: result,
          };
        },
      }),
    },
  };
};
