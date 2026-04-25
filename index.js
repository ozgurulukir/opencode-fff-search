import { tool } from "@opencode-ai/plugin";
import { FileFinder } from "@ff-labs/fff-node";

/**
 * FFF Plugin for OpenCode
 * Replaces default grep/glob with fff.nvim's fast search
 */

export const FffPlugin = async ({ directory, client }) => {
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
      grep: tool({
        description: "Search file contents using fff (fast, typo-resistant, frecency-ranked).",
        args: {
          pattern: tool.schema.string().describe("Search pattern"),
          path: tool.schema.string().optional(),
          exclude: tool.schema.string().optional(),
          caseSensitive: tool.schema.boolean().optional(),
          context: tool.schema.number().optional(),
        },
        async execute(args) {
          await scanPromise;
          const result = finder.grep(args.pattern, {
            smartCase: !args.caseSensitive,
            beforeContext: args.context ?? 0,
            afterContext: args.context ?? 0,
            maxMatchesPerFile: 100,
          });
          if (!result.ok) throw new Error(`fff grep error: ${result.error}`);
          return result.value.items.map((m) => ({
            path: m.relativePath,
            line_number: m.lineNumber,
            line: m.lineContent,
            lines: [m.lineContent],
            submatches: [],
          }));
        },
      }),
      glob: tool({
        description: "Find files/directories using fff's fast fuzzy search.",
        args: {
          pattern: tool.schema.string(),
          type: tool.schema.enum(["file", "directory"]).optional(),
          limit: tool.schema.number().optional(),
        },
        async execute(args) {
          await scanPromise;
          const opts = { pageSize: args.limit || 100 };
          if (args.type === "directory") {
            const res = finder.dirSearch(args.pattern, opts);
            if (!res.ok) throw new Error(`fff dirSearch error: ${res.error}`);
            return res.value.items.map((d) => d.relativePath);
          }
          const res = finder.fileSearch(args.pattern, opts);
          if (!res.ok) throw new Error(`fff fileSearch error: ${res.error}`);
          return res.value.items.map((f) => f.relativePath);
        },
      }),
    },
  };
};
