import { join, normalize, isAbsolute } from "path";

function resolvePath(directory, p) {
  if (!p) return directory;
  const resolved = isAbsolute(p) ? p : join(directory, p);
  const normalized = normalize(resolved);
  const dirNormalized = normalize(directory);
  // Ensure the trailing slash for accurate startsWith check if not exact match
  const prefix = dirNormalized.endsWith('/') ? dirNormalized : dirNormalized + '/';
  if (normalized !== dirNormalized && !normalized.startsWith(prefix)) {
    throw new Error(`Path is outside the workspace directory: ${normalized} vs ${dirNormalized}`);
  }
  return normalized;
}

console.log(resolvePath("/work", "foo"));
console.log(resolvePath("/work", "/work/foo"));
try { console.log(resolvePath("/work", "../foo")); } catch (e) { console.log(e.message); }
try { console.log(resolvePath("/work", "/etc/passwd")); } catch (e) { console.log(e.message); }
