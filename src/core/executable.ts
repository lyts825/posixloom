import { execFileSync } from "node:child_process";

/**
 * Process-wide executable lookup cache. PATH/PATHEXT and cwd are part of the key,
 * so embedding applications can update their environment without receiving stale
 * results while repeated command planning avoids spawning where.exe/which.
 */
const lookupCache = new Map<string, readonly string[]>();
const MAX_LOOKUP_CACHE_ENTRIES = 256;

function cacheKey(command: string): string {
  return [process.platform, process.cwd(), process.env.PATH ?? "", process.env.PATHEXT ?? "", command].join("\0");
}

export function findAllOnPath(command: string): string[] {
  const key = cacheKey(command);
  const cached = lookupCache.get(key);
  if (cached) {
    lookupCache.delete(key);
    lookupCache.set(key, cached);
    return [...cached];
  }
  let matches: string[];
  try {
    const finder = process.platform === "win32" ? "where.exe" : "which";
    matches = execFileSync(finder, [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024,
    }).trim().split(/\r?\n/).filter(Boolean);
  } catch {
    matches = [];
  }
  if (lookupCache.size >= MAX_LOOKUP_CACHE_ENTRIES) {
    const oldest = lookupCache.keys().next().value;
    if (oldest !== undefined) lookupCache.delete(oldest);
  }
  lookupCache.set(key, Object.freeze([...matches]));
  return [...matches];
}

export function findOnPath(command: string): string | undefined {
  return findAllOnPath(command)[0];
}

/** Test/embedding hook for explicit environment refreshes. */
export function clearExecutableLookupCache(): void {
  lookupCache.clear();
}
