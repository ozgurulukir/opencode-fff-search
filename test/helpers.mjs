import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createTempProject(prefix = ".tmp-test-" + process.pid) {
  const tmpDir = join(__dirname, prefix);
  cleanupTempProject(tmpDir);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(tmpDir, "src"), { recursive: true });
  mkdirSync(join(tmpDir, "src/components"), { recursive: true });
  mkdirSync(join(tmpDir, "docs"), { recursive: true });

  writeFileSync(
    join(tmpDir, "index.js"),
    `import { foo } from "./src/foo.js";\nconsole.log(foo);\n`,
  );
  writeFileSync(
    join(tmpDir, "README.md"),
    `# Test Project\n\nThis is a test.\n`,
  );
  writeFileSync(
    join(tmpDir, "src", "foo.js"),
    `export const foo = "bar";\nexport const FOO = "UPPER";\n`,
  );
  writeFileSync(join(tmpDir, "src", "bar.js"), `// empty file\n`);
  writeFileSync(
    join(tmpDir, "src", "components", "App.jsx"),
    `function App() { return <div>Hello</div>; }\nexport default App;\n`,
  );
  writeFileSync(join(tmpDir, "docs", "notes.txt"), `hello world\n`);
  writeFileSync(join(tmpDir, ".gitignore"), `node_modules/\n.tmp*\n`);
  writeFileSync(
    join(tmpDir, "src", "case.js"),
    `const lower = "abc";\nconst UPPER = "ABC";\nconst Mixed = "AbC";\n`,
  );
  writeFileSync(
    join(tmpDir, "src", "metachars.js"),
    `// contains literal regex metacharacters
const parens = "foo(bar)";
const bracket = "file[1].txt";
const plus = "page+1";
const dot = "example.com";
`,
  );

  return tmpDir;
}

export function cleanupTempProject(tmpDir) {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort
  }
}

export function createMockClient() {
  const logs = [];
  return {
    logs,
    client: {
      app: {
        log: async ({ body }) => logs.push(body),
      },
    },
  };
}

export function createContext(directory) {
  const ac = new AbortController();
  return {
    sessionID: "test-session",
    messageID: "test-msg",
    agent: "test-agent",
    directory,
    worktree: directory,
    abort: ac.signal,
    metadata: () => {},
    ask: () => {},
    _abortController: ac,
  };
}

export function out(result) {
  return typeof result === "object" && result !== null && result.output != null
    ? result.output
    : result;
}
