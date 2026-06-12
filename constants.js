export const TRAILING_SLASH_RE = /\/+$/;
export const ROOT_PATH_RE = /^(\.|\.\/|\/)$/;
export const GLOB_METACHAR_RE = /[*?\[]/;
export const REGEX_METACHAR_RE =
  /\\[sdwnbtDSWNBT]|\\|\||\[\^?\]|\[\^?[^\]]+\]|\\\+|\\\*|\\\?|[\^\$]/;

export const SCAN_TIMEOUT_MS = 15000;
export const TOOL_TIMEOUT_MS = 5000;
export const GREP_TIME_BUDGET_MS = 5000;
export const MAX_LIMIT = 5000;
export const DEFAULT_GREP_LIMIT = 100;
export const DEFAULT_GLOB_LIMIT = 100;

export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".hg",
  ".svn",
  "__pycache__",
  ".cache",
  "dist",
  ".next",
  "coverage",
  ".nyc_output",
  "build",
  "out",
  ".nuxt",
  ".output",
  ".vercel",
  ".terraform",
]);
