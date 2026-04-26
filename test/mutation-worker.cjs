// mutation-worker.cjs — Worker thread entry point for filesystem mutation stress tests.
// Runs as a separate thread to maximize I/O pressure while the main thread
// waits for the opencode child process.

const { workerData, parentPort } = require("node:worker_threads");
const {
  openSync,
  closeSync,
  ftruncateSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  appendFileSync,
} = require("node:fs");
const { join } = require("node:path");

const { simDir, mutationCount } = workerData;
let completed = 0;

for (let i = 0; i < mutationCount; i++) {
  const filePath = join(simDir, "src", `module-${i % 200}.js`);
  switch (i % 6) {
    case 0:
      try { appendFileSync(filePath, `// w${i}\n`); } catch { /* ok */ }
      break;
    case 1: {
      try {
        const fd = openSync(filePath, "w");
        ftruncateSync(fd, 0);
        closeSync(fd);
        writeFileSync(filePath, `// rw${i}\n`);
      } catch { /* ok */ }
      break;
    }
    case 2:
      try { unlinkSync(filePath); writeFileSync(filePath, `// rc${i}\n`); } catch { /* ok */ }
      break;
    case 3:
      try { renameSync(filePath, join(simDir, "src", `mv-${i}.js`)); } catch { /* ok */ }
      break;
    case 4:
      writeFileSync(join(simDir, "src", `gen-${i}.js`), `// ${i}\n`);
      break;
    case 5:
      try { unlinkSync(join(simDir, "src", `gen-${Math.max(0, i - 5)}.js`)); } catch { /* ok */ }
      break;
  }
  // Session DB churn every 10
  if (i % 10 === 0) {
    const db = join(simDir, ".opencode", "session.db");
    try {
      const fd = openSync(db, "w");
      ftruncateSync(fd, 0);
      closeSync(fd);
      writeFileSync(db, "\x00".repeat(1024 + i * 50));
    } catch { /* ok */ }
  }
  // Git index churn every 15
  if (i % 15 === 0) {
    const idx = join(simDir, ".git", "index");
    try {
      const fd = openSync(idx, "w");
      ftruncateSync(fd, 0);
      closeSync(fd);
      writeFileSync(idx, `v${i}\n` + "0".repeat(2048));
    } catch { /* ok */ }
  }
  completed++;
  if (i % 50 === 0) {
    parentPort?.postMessage({ type: "progress", completed, total: mutationCount });
  }
}
parentPort?.postMessage({ type: "done", completed });
