import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, resolve } from "node:path";

/** Discovery never launches where.exe/which. Release execution still uses pinned manifest paths. */
const cache = new Map<string, { paths: string[]; expires: number }>();
const MAX_ENTRIES = 256;
const TTL_MS = 2000;
export function discoverExecutables(command: string, pathValue = process.env.PATH ?? "", pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD", cwd = process.cwd()): string[] {
  if (!command || /[\0*?]/.test(command)) return [];
  const windows = process.platform === "win32";
  const extensions = windows && !extname(command)
    ? [...new Set(pathExt.split(";").filter((extension) => /^\.[A-Za-z0-9]+$/.test(extension)))]
    : [""];
  const explicit = isAbsolute(command) || /[\\\\/]/.test(command);
  const directories = explicit ? [""] : [...(windows ? [cwd] : []), ...pathValue.split(delimiter).map((entry) => entry.replace(/^"|"$/g, "")).filter(Boolean)];
  const results: string[] = [];
  const seen = new Set<string>();
  for (const directory of directories) for (const extension of extensions) {
    const path = explicit ? resolve(cwd, command + extension) : resolve(cwd, directory, command + extension);
    const key = windows ? path.toLowerCase() : path;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!statSync(path).isFile()) continue;
      if (!windows) accessSync(path, constants.X_OK);
      results.push(path);
    } catch { /* Missing, inaccessible or non-executable candidates are not matches. */ }
  }
  return results;
}

export function findAllOnPath(command: string): string[] {
  const key = [process.platform, process.cwd(), process.env.PATH ?? "", process.env.PATHEXT ?? "", command].join("\0");
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) { cache.delete(key); cache.set(key, existing); return [...existing.paths]; }
  const paths = discoverExecutables(command);
  cache.delete(key);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { paths, expires: Date.now() + (paths.length ? TTL_MS : 250) });
  return [...paths];
}
export function findOnPath(command: string): string | undefined { return findAllOnPath(command)[0]; }
export function clearExecutableLookupCache(): void { cache.clear(); }
