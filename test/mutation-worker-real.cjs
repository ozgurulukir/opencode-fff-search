// mutation-worker-real.cjs — Worker thread for max-speed mutations on a real repo.
// Receives { files, repoDir, mutationCount } via workerData.

const { workerData, parentPort } = require("node:worker_threads");
const {
  openSync,
  closeSync,
  ftruncateSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  appendFileSync,
  rmSync,
} = require("node:fs");
const { join } = require("node:path");

const { files, repoDir, mutationCount } = workerData;
let completed = 0;
let errors = 0;

for (let i = 0; i < mutationCount; i++) {
  const filePath = files[i % files.length];

  try {
    switch (i % 8) {
      case 0:
        appendFileSync(filePath, `// w${i}\n`);
        break;
      case 1: {
        const fd = openSync(filePath, "w");
        ftruncateSync(fd, 0);
        closeSync(fd);
        writeFileSync(filePath, `// rw${i}\n`);
        break;
      }
      case 2:
        unlinkSync(filePath);
        writeFileSync(filePath, `// rc${i}\n`);
        break;
      case 3:
        renameSync(filePath, filePath + `.mv-${i}`);
        break;
      case 4: {
        const fd = openSync(filePath, "w");
        ftruncateSync(fd, 0);
        closeSync(fd);
        break;
      }
      case 5: {
        // Partial overwrite
        const fd = openSync(filePath, "r+");
        const buf = Buffer.alloc(100, 0x00);
        buf.write(`// p${i}\n`);
        try { writeFileSync(fd, buf); } catch { /* r+ on some files fails */ }
        closeSync(fd);
        break;
      }
      case 6: {
        // Create new file in same directory
        const dir = filePath.substring(0, filePath.lastIndexOf("/"));
        writeFileSync(join(dir, `.stress-w-${i}.js`), `// ${i}\n`);
        break;
      }
      case 7:
        rmSync(join(filePath.substring(0, filePath.lastIndexOf("/")), `.stress-w-${Math.max(0, i - 7)}.js`), { force: true });
        break;
    }
  } catch { errors++; }

  // .git/index churn every 50
  if (i % 50 === 0) {
    const idx = join(repoDir, ".git", "index");
    try {
      const fd = openSync(idx, "w");
      ftruncateSync(fd, 0);
      closeSync(fd);
      writeFileSync(idx, `v${i}\n` + "0".repeat(4096));
    } catch { /* ok */ }
  }

  // 1MB large file churn every 100
  if (i % 100 === 0) {
    writeFileSync(join(repoDir, `.stress-lg-${i}.bin`), Buffer.alloc(1024 * 1024, 0x41 + (i % 26)));
  }

  completed++;
  if (i % 100 === 0) {
    parentPort?.postMessage({ type: "progress", completed, errors, total: mutationCount });
  }
}
parentPort?.postMessage({ type: "done", completed, errors });
