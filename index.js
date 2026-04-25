import { tool } from "@opencode-ai/plugin";
import { FileFinder } from "@ff-labs/fff-node";
import { minimatch } from "minimatch";

export const FffPlugin = async ({ directory, client }) => {
  await client.app.log({
    body: { service: "fff-plugin", level: "info", message: `Initializing in ${directory}` },
  });

  const initResult = FileFinder.create({ basePath: directory, aiMode: true });
  if (!initResult.ok) {
    await client.app.log({
      body: { service: "fff-plugin", level: "error", message: `fff init failed: ${initResult.error}` },
    });
    throw new Error(`fff initialization failed: ${initResult.error}`);
  }

  const finder = initResult.value;

  // Start scanning (non-blocking)
  const scanPromise = finder.waitForScan(15000).catch(() => undefined);
  scanPromise.then(() => {
    client.app.log({ body: { service: "fff-plugin", level: "info", message: "Initial fff scan complete" } });
  });

  return {
    tool: {
      grep: tool({
        description: "Search file contents using fff (fast, typo-resistant, frecency-ranked).",
        args: {
          pattern: tool.schema.string(),
          path: tool.schema.string().optional(),
          exclude: tool.schema.string().optional(),
          caseSensitive: tool.schema.boolean().optional(),
          context: tool.schema.number().optional(),
          limit: tool.schema.number().optional(),
        },
        async execute(args, context) {
          // Respect cancellation
          if (context.abort.aborted) throw new Error("Aborted");

          // Wait for scan with timeout so Esc works
          try {
            await Promise.race([
              scanPromise,
              new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);
          } catch {
            // ignore
          }
          if (context.abort.aborted) throw new Error("Aborted");

          const opts = {
            smartCase: args.caseSensitive !== true,
            beforeContext: args.context ?? 0,
            afterContext: args.context ?? 0,
            maxMatchesPerFile: args.limit ? Math.min(args.limit, 500) : 100,
          };

          const result = finder.grep(args.pattern, opts);
          if (!result.ok) throw new Error(`fff grep error: ${result.error}`);

          let matches = result.value.items;

          // Path filter
          if (args.path) {
            const target = args.path.replace(/\/+$/, "");
            matches = matches.filter((m) => m.relativePath === target || m.relativePath.startsWith(target + "/"));
          }

          // Exclude filter
          if (args.exclude) {
            const patterns = args.exclude.split(",").map((p) => p.trim()).filter(Boolean);
            matches = matches.filter((m) => !patterns.some((pat) => minimatch(m.relativePath, pat, { dot: true })));
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
            scanComplete: (await scanPromise.catch(() => undefined)) !== undefined,
          });

          // Return array of match objects (framework will serialize)
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
          if (context.abort.aborted) throw new Error("Aborted");

          try {
            await Promise.race([
              scanPromise,
              new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);
          } catch {
            // ignore timeout
          }
          if (context.abort.aborted) throw new Error("Aborted");

          const pageSize = Math.max(1, args.limit || 100);
          let result;

          if (args.type === "directory") {
            const dirResult = finder.dirSearch(args.pattern, { pageSize });
            if (!dirResult.ok) throw new Error(`fff dirSearch error: ${dirResult.error}`);
            result = dirResult.value.items.map((d) => d.relativePath);
          } else {
            const fileResult = finder.fileSearch(args.pattern, { pageSize });
            if (!fileResult.ok) throw new Error(`fff fileSearch error: ${fileResult.error}`);
            result = fileResult.value.items.map((f) => f.relativePath);
          }

          // Path filter
          if (args.path) {
            const target = args.path.replace(/\/+$/, "");
            result = result.filter((p) => p === target || p.startsWith(target + "/"));
          }

          return { output: result };
        },
      }),
    },
  };
};
