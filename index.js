import { tool } from "@opencode-ai/plugin";
import { FileFinder } from "@ff-labs/fff-node";
import { minimatch } from "minimatch";

/**
 * FFF Plugin - Replaces OpenCode's default file search (grep, glob)
 * with fff.nvim's fast, typo-resistant, frecency-ranked search.
 */

export const FffPlugin = async ({ directory, client }) => {
  // Immediate log to verify plugin is executing
  await client.app.log({
    body: { service: "fff-plugin", level: "info", message: `PLUGIN STARTUP in ${directory}` },
  });

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
  const scanPromise = finder.waitForScan(15000).catch(() => undefined);
  scanPromise.then(() => {
    client.app.log({ body: { service: "fff-plugin", level: "info", message: "Initial fff scan complete" } });
  });

  return {
    tool: {
      grep: tool({
        description: "Search file contents using fff (fast, typo-resistant, frecency-ranked).",
        args: {
          pattern: tool.schema.string().describe("Search pattern"),
          path: tool.schema.string().optional(),
          exclude: tool.schema.string().optional(),
          caseSensitive: tool.schema.boolean().optional(),
          context: tool.schema.number().optional(),
          limit: tool.schema.number().optional(),
        },
         async execute(args, context) {
          try {
            await client.app.log({
              body: { service: "fff-plugin", level: "debug", message: `grep execute START: pattern=${args.pattern}` },
            });
            if (context.abort.aborted) throw new Error("Aborted");

            let scanCompleted = false;
            try {
              await Promise.race([
                scanPromise.then(() => { scanCompleted = true; }),
                new Promise((resolve) => setTimeout(resolve, 5000)),
              ]);
            } catch (err) {
              await client.app.log({ body: { service: "fff-plugin", level: "warn", message: `scan wait error: ${err}` } });
            }
            if (context.abort.aborted) throw new Error("Aborted");

            const opts = {
              smartCase: args.caseSensitive !== true,
              beforeContext: args.context ?? 0,
              afterContext: args.context ?? 0,
              maxMatchesPerFile: args.limit ? Math.min(args.limit, 500) : 100,
            };

            const result = finder.grep(args.pattern, opts);
            if (!result.ok) {
              await client.app.log({ body: { service: "fff-plugin", level: "error", message: `fff grep error: ${result.error}` } });
              throw new Error(`fff grep error: ${result.error}`);
            }

            let matches = result.value.items;

            if (args.path) {
              const target = args.path.replace(/\/+$/, "");
              matches = matches.filter((m) => m.relativePath === target || m.relativePath.startsWith(target + "/"));
            }

            if (args.exclude) {
              const patterns = args.exclude.split(",").map((p) => p.trim()).filter(Boolean);
              matches = matches.filter((m) => !patterns.some((pat) => minimatch(m.relativePath, pat, { dot: true })));
            }

            const totalMatches = matches.length;
            const limit = Math.max(1, args.limit || 1000);
            const truncated = totalMatches > limit;
            const returnedMatches = truncated ? matches.slice(0, limit) : matches;

            // Format as traditional grep output: file:line_number:line_content
            const lines = returnedMatches.map(m => `${m.relativePath}:${m.lineNumber}:${m.lineContent}`);
            return lines.join('\n');
          } catch (err) {
            await client.app.log({ body: { service: "fff-plugin", level: "error", message: `grep EXECUTE EXCEPTION: ${err.message}\n${err.stack}` } });
            throw err;
          }
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

          let scanCompleted = false;
          try {
            await Promise.race([
              scanPromise.then(() => { scanCompleted = true; }),
              new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);
          } catch {
            // ignore
          }
          if (context.abort.aborted) throw new Error("Aborted");

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

          if (args.path) {
            const target = args.path.replace(/\/+$/, "");
            result = result.filter((p) => p === target || p.startsWith(target + "/"));
          }

          return result.join("\n");
        },
      }),
    },
  };
};
