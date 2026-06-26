import { relative, isAbsolute } from "node:path";
import path from "node:path";

export function resolvePathUnchecked(directory, p) {
  if (!p) return path.resolve(directory);
  return path.resolve(directory, p);
}

export function isPathOutside(directory, resolvedPath) {
  const dirResolved = path.resolve(directory);
  const prefix = dirResolved.endsWith(path.sep)
    ? dirResolved
    : dirResolved + path.sep;
  return resolvedPath !== dirResolved && !resolvedPath.startsWith(prefix);
}

export function resolvePath(directory, p) {
  const resolved = resolvePathUnchecked(directory, p);
  if (isPathOutside(directory, resolved)) {
    throw new Error(
      `Path is outside the workspace directory: ${resolved} vs ${path.resolve(directory)}`,
    );
  }
  return resolved;
}

export function getRelativePath(directory, argsPath) {
  if (!argsPath) return null;
  return isAbsolute(argsPath) ? relative(directory, argsPath) : argsPath;
}

export function isPathInsideIndex(argsPath, directory) {
  if (!argsPath) return true;
  if (!isAbsolute(argsPath)) return true;
  return argsPath.startsWith(directory + "/") || argsPath === directory;
}

export function debugLog(message, ...args) {
  if (process.env.DEBUG_GREP) console.error("[GREP-DEBUG]", message, ...args);
}

export async function safeLog(client, level, message) {
  try {
    await client.app.log({ body: { service: "fff-plugin", level, message } });
  } catch (e) {
    console.error(`[fff-plugin] log failed (${level}):`, message, e?.message);
  }
}

export async function waitForScan(scanPromise, timeoutMs) {
  debugLog(
    "waitForScan START, scanPromise type:",
    typeof scanPromise,
    scanPromise === undefined ? "UNDEF" : scanPromise === null ? "NULL" : "obj",
  );
  try {
    const resolved = await Promise.race([
      scanPromise.then((v) => {
        debugLog("scanPromise resolved to:", JSON.stringify(v));
        return true;
      }),
      new Promise((resolve) =>
        setTimeout(() => {
          debugLog("waitForScan TIMEOUT");
          resolve(false);
        }, timeoutMs),
      ),
    ]);
    debugLog("waitForScan RESULT:", resolved);
    return resolved;
  } catch (e) {
    debugLog("waitForScan CATCH:", e.message);
    return false;
  }
}
