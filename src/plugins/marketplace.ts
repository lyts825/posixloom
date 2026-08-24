/**
 * Declarative plugin marketplace for PosixLoom.
 *
 * Plugins are intentionally data-only command packs. Installing a plugin writes a
 * validated manifest to DataRoot; it never evaluates JavaScript or runs a command.
 * A command is only executed after an explicit CLI/API/UI action and still travels
 * through PosixLoomService, so the normal mount, policy, timeout and trace checks apply.
 */
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PosixLoomError } from "../core/errors.js";

export type PluginCommandInput =
  | { kind: "text"; raw: string }
  | { kind: "argv"; argv: string[] };

export interface PluginCommand {
  id: string;
  title: string;
  description: string;
  input: PluginCommandInput;
  cwd?: string;
  timeoutMs?: number;
}

export interface PluginManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  tags: string[];
  homepage?: string;
  commands: PluginCommand[];
}

export interface InstalledPlugin {
  recordVersion: 1;
  installedAt: string;
  source: string;
  manifest: PluginManifest;
}

export interface PluginCatalogItem {
  manifest: PluginManifest;
  source: string;
  installedVersion?: string;
  updateAvailable: boolean;
}

export interface PluginMarketplaceOptions {
  marketplaceUrl?: string;
  requestTimeoutMs?: number;
  maxCatalogBytes?: number;
  fetch?: typeof globalThis.fetch;
}

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const COMMAND_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const VERSION = /^[0-9A-Za-z](?:[0-9A-Za-z.+-]{0,62}[0-9A-Za-z])?$/;

const BUILTIN_PLUGINS: PluginManifest[] = [
  {
    manifestVersion: 1,
    id: "workspace-inspector",
    name: "Workspace Inspector",
    version: "1.0.0",
    description: "Read-only recipes for understanding a workspace before making changes.",
    author: "PosixLoom",
    category: "Development",
    tags: ["workspace", "git", "search"],
    commands: [
      {
        id: "git-status",
        title: "Git status",
        description: "Show the current branch and concise working-tree state.",
        input: { kind: "argv", argv: ["git", "status", "--short", "--branch"] },
      },
      {
        id: "list-files",
        title: "List workspace files",
        description: "List files while respecting ignore rules.",
        input: { kind: "argv", argv: ["rg", "--files", "/workspace"] },
      },
      {
        id: "find-todos",
        title: "Find TODOs",
        description: "Search for TODO and FIXME markers with line numbers.",
        input: { kind: "argv", argv: ["rg", "-n", "TODO|FIXME", "/workspace"] },
      },
    ],
  },
  {
    manifestVersion: 1,
    id: "git-review",
    name: "Git Review Kit",
    version: "1.0.0",
    description: "Focused, non-mutating checks for reviewing a change set.",
    author: "PosixLoom",
    category: "Quality",
    tags: ["git", "review", "diff"],
    commands: [
      {
        id: "diff-stat",
        title: "Diff summary",
        description: "Summarize changed files and line counts.",
        input: { kind: "argv", argv: ["git", "diff", "--stat"] },
      },
      {
        id: "diff-check",
        title: "Whitespace check",
        description: "Detect whitespace errors in the current diff.",
        input: { kind: "argv", argv: ["git", "diff", "--check"] },
      },
      {
        id: "recent-commits",
        title: "Recent commits",
        description: "Show the latest ten commits in a compact graph.",
        input: { kind: "argv", argv: ["git", "log", "-10", "--oneline", "--decorate", "--graph"] },
      },
    ],
  },
  {
    manifestVersion: 1,
    id: "node-health",
    name: "Node Project Health",
    version: "1.0.0",
    description: "Quick recipes for checking a Node.js project and its toolchain.",
    author: "PosixLoom",
    category: "Development",
    tags: ["node", "npm", "health"],
    commands: [
      {
        id: "versions",
        title: "Tool versions",
        description: "Print the active Node.js and npm versions.",
        input: { kind: "text", raw: "node --version && npm --version" },
      },
      {
        id: "test",
        title: "Run tests",
        description: "Run the package test script in the current workspace.",
        input: { kind: "text", raw: "npm test" },
        timeoutMs: 300_000,
      },
      {
        id: "outdated",
        title: "Check outdated packages",
        description: "Ask npm for an outdated-dependency report without changing files.",
        input: { kind: "text", raw: "npm outdated" },
        timeoutMs: 120_000,
      },
    ],
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, name: string, maximum = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", `${name} must be a non-empty string of at most ${maximum} characters`, { name });
  }
  return value;
}

function optionalUrl(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const text = stringField(value, name, 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", `${name} must be an absolute HTTP(S) URL`, { name });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", `${name} must use HTTP or HTTPS`, { name });
  }
  return url.toString();
}

function cloneInput(input: PluginCommandInput): PluginCommandInput {
  return input.kind === "argv" ? { kind: "argv", argv: [...input.argv] } : { kind: "text", raw: input.raw };
}

function cloneManifest(manifest: PluginManifest): PluginManifest {
  return {
    ...manifest,
    tags: [...manifest.tags],
    commands: manifest.commands.map((command) => ({ ...command, input: cloneInput(command.input) })),
  };
}

/** Validate and normalize an untrusted marketplace or disk manifest. */
export function validatePluginManifest(value: unknown): PluginManifest {
  if (!isRecord(value) || value.manifestVersion !== 1) {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", "Plugin manifestVersion must be 1");
  }
  const id = stringField(value.id, "plugin.id", 64);
  const version = stringField(value.version, "plugin.version", 64);
  if (!PLUGIN_ID.test(id)) throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", "Plugin id contains unsupported characters", { id });
  if (!VERSION.test(version)) throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", "Plugin version contains unsupported characters", { id, version });
  if (!Array.isArray(value.tags) || value.tags.length > 16 || value.tags.some((tag) => typeof tag !== "string" || tag.length > 64)) {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", "Plugin tags must be an array of at most 16 short strings", { id });
  }
  if (!Array.isArray(value.commands) || value.commands.length === 0 || value.commands.length > 64) {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", "Plugin commands must contain between 1 and 64 entries", { id });
  }
  const commandIds = new Set<string>();
  const commands = value.commands.map((candidate, index): PluginCommand => {
    if (!isRecord(candidate)) throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", "Plugin command must be an object", { id, index });
    const commandId = stringField(candidate.id, `plugin.commands[${index}].id`, 64);
    if (!COMMAND_ID.test(commandId) || commandIds.has(commandId)) {
      throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", "Plugin command ids must be safe and unique", { id, commandId });
    }
    commandIds.add(commandId);
    if (!isRecord(candidate.input)) throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", "Plugin command input must be an object", { id, commandId });
    let input: PluginCommandInput;
    if (candidate.input.kind === "text") {
      if (typeof candidate.input.raw !== "string" || !candidate.input.raw.trim() || candidate.input.raw.length > 65_536) {
        throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", "Plugin text command must be non-empty and at most 64 KiB", { id, commandId });
      }
      input = { kind: "text", raw: candidate.input.raw };
    } else if (candidate.input.kind === "argv") {
      const argv = candidate.input.argv;
      if (!Array.isArray(argv) || argv.length === 0 || argv.length > 256 || argv.some((argument) => typeof argument !== "string" || argument.length > 32_768)) {
        throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", "Plugin argv command must contain 1 to 256 string arguments", { id, commandId });
      }
      input = { kind: "argv", argv: [...argv] };
    } else {
      throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", "Plugin command input kind must be text or argv", { id, commandId });
    }
    const timeoutMs = candidate.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0 || (timeoutMs as number) > 86_400_000)) {
      throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", "Plugin command timeoutMs must be a positive integer up to one day", { id, commandId });
    }
    const cwd = candidate.cwd === undefined ? undefined : stringField(candidate.cwd, `plugin.commands[${index}].cwd`, 4096);
    return {
      id: commandId,
      title: stringField(candidate.title, `plugin.commands[${index}].title`, 128),
      description: stringField(candidate.description, `plugin.commands[${index}].description`, 1024),
      input,
      cwd,
      timeoutMs: timeoutMs as number | undefined,
    };
  });
  return {
    manifestVersion: 1,
    id,
    name: stringField(value.name, "plugin.name", 128),
    version,
    description: stringField(value.description, "plugin.description", 2048),
    author: stringField(value.author, "plugin.author", 128),
    category: stringField(value.category, "plugin.category", 64),
    tags: [...value.tags] as string[],
    homepage: optionalUrl(value.homepage, "plugin.homepage"),
    commands,
  };
}

function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function validateMarketplaceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PosixLoomError("PLUGIN_MARKETPLACE_URL_INVALID", "Marketplace URL must be an absolute URL", { url: value });
  }
  const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1");
  if (url.protocol !== "https:" && !localHttp) {
    throw new PosixLoomError("PLUGIN_MARKETPLACE_URL_INVALID", "Remote marketplaces must use HTTPS (plain HTTP is only allowed on loopback)", { url: value });
  }
  return url;
}

/** Persistent plugin catalog and installation manager. */
export class PluginMarketplace {
  private readonly installedRoot: string;
  private readonly marketplaceUrl?: URL;
  private readonly requestTimeoutMs: number;
  private readonly maxCatalogBytes: number;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly dataRoot: string, options: PluginMarketplaceOptions = {}) {
    this.installedRoot = join(dataRoot, "plugins", "installed");
    this.marketplaceUrl = options.marketplaceUrl ? validateMarketplaceUrl(options.marketplaceUrl) : undefined;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.maxCatalogBytes = options.maxCatalogBytes ?? 2 * 1024 * 1024;
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) throw new PosixLoomError("PLUGIN_OPTIONS_INVALID", "requestTimeoutMs must be a positive integer");
    if (!Number.isSafeInteger(this.maxCatalogBytes) || this.maxCatalogBytes <= 0) throw new PosixLoomError("PLUGIN_OPTIONS_INVALID", "maxCatalogBytes must be a positive integer");
  }

  private async remoteCatalog(): Promise<Array<{ manifest: PluginManifest; source: string }>> {
    if (!this.marketplaceUrl) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetcher(this.marketplaceUrl, {
        headers: { accept: "application/json", "user-agent": "PosixLoom-Plugin-Marketplace/1" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new PosixLoomError("PLUGIN_MARKETPLACE_FAILED", `Marketplace returned HTTP ${response.status}`, { url: this.marketplaceUrl.toString(), status: response.status });
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > this.maxCatalogBytes) throw new PosixLoomError("PLUGIN_MARKETPLACE_TOO_LARGE", "Marketplace catalog exceeds the configured byte limit", { declaredLength, maximum: this.maxCatalogBytes });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > this.maxCatalogBytes) throw new PosixLoomError("PLUGIN_MARKETPLACE_TOO_LARGE", "Marketplace catalog exceeds the configured byte limit", { bytes: bytes.length, maximum: this.maxCatalogBytes });
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (error) {
        throw new PosixLoomError("PLUGIN_MARKETPLACE_INVALID", "Marketplace catalog is not valid UTF-8 JSON", { cause: String(error) });
      }
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.plugins) || parsed.plugins.length > 500) {
        throw new PosixLoomError("PLUGIN_MARKETPLACE_INVALID", "Marketplace catalog must use schemaVersion 1 and contain at most 500 plugins");
      }
      return parsed.plugins.map((plugin) => ({ manifest: validatePluginManifest(plugin), source: this.marketplaceUrl!.toString() }));
    } catch (error) {
      if (error instanceof PosixLoomError) throw error;
      if (controller.signal.aborted) throw new PosixLoomError("PLUGIN_MARKETPLACE_TIMEOUT", "Marketplace request timed out", { url: this.marketplaceUrl.toString(), timeoutMs: this.requestTimeoutMs });
      throw new PosixLoomError("PLUGIN_MARKETPLACE_FAILED", "Marketplace request failed", { url: this.marketplaceUrl.toString(), cause: String(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  private async records(): Promise<Map<string, InstalledPlugin>> {
    await mkdir(this.installedRoot, { recursive: true });
    const records = new Map<string, InstalledPlugin>();
    for (const entry of await readdir(this.installedRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(this.installedRoot, entry.name);
      let value: unknown;
      try {
        value = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        throw new PosixLoomError("PLUGIN_RECORD_INVALID", `Installed plugin record is unreadable: ${entry.name}`, { path, cause: String(error) });
      }
      if (!isRecord(value) || value.recordVersion !== 1 || typeof value.installedAt !== "string" || typeof value.source !== "string") {
        throw new PosixLoomError("PLUGIN_RECORD_INVALID", `Installed plugin record is invalid: ${entry.name}`, { path });
      }
      const manifest = validatePluginManifest(value.manifest);
      if (`${manifest.id}.json` !== entry.name) throw new PosixLoomError("PLUGIN_RECORD_INVALID", "Installed plugin filename does not match its id", { path, id: manifest.id });
      records.set(manifest.id, { recordVersion: 1, installedAt: value.installedAt, source: value.source, manifest });
    }
    return records;
  }

  /** Return built-in and configured remote catalog entries, annotated with install state. */
  async catalog(query = ""): Promise<PluginCatalogItem[]> {
    const candidates: Array<{ manifest: PluginManifest; source: string }> = [
      ...BUILTIN_PLUGINS.map((manifest) => ({ manifest: cloneManifest(manifest), source: "builtin" })),
      ...await this.remoteCatalog(),
    ];
    const merged = new Map<string, { manifest: PluginManifest; source: string }>();
    for (const candidate of candidates) {
      const current = merged.get(candidate.manifest.id);
      if (!current || compareVersions(candidate.manifest.version, current.manifest.version) > 0) merged.set(candidate.manifest.id, candidate);
    }
    const installed = await this.records();
    const needle = query.trim().toLocaleLowerCase();
    return [...merged.values()]
      .filter(({ manifest }) => !needle || [manifest.id, manifest.name, manifest.description, manifest.author, manifest.category, ...manifest.tags].join(" ").toLocaleLowerCase().includes(needle))
      .map(({ manifest, source }) => {
        const installedVersion = installed.get(manifest.id)?.manifest.version;
        return {
          manifest: cloneManifest(manifest),
          source,
          installedVersion,
          updateAvailable: installedVersion !== undefined && compareVersions(manifest.version, installedVersion) > 0,
        };
      })
      .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
  }

  /** Return validated installed records without sharing mutable manifest arrays. */
  async installed(): Promise<InstalledPlugin[]> {
    const records = await this.records();
    return [...records.values()]
      .map((record) => ({ ...record, manifest: cloneManifest(record.manifest) }))
      .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
  }

  /** Install or update a catalog plugin atomically. No plugin command is run. */
  async install(pluginId: string): Promise<InstalledPlugin> {
    if (!PLUGIN_ID.test(pluginId)) throw new PosixLoomError("PLUGIN_ID_INVALID", "Plugin id is invalid", { pluginId });
    const item = (await this.catalog()).find((candidate) => candidate.manifest.id === pluginId);
    if (!item) throw new PosixLoomError("PLUGIN_NOT_FOUND", `Plugin is not present in the configured marketplace: ${pluginId}`, { pluginId });
    await mkdir(this.installedRoot, { recursive: true });
    const record: InstalledPlugin = {
      recordVersion: 1,
      installedAt: new Date().toISOString(),
      source: item.source,
      manifest: cloneManifest(item.manifest),
    };
    const target = join(this.installedRoot, `${pluginId}.json`);
    const temporary = join(this.installedRoot, `.${pluginId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      try {
        await rename(temporary, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        await rm(target, { force: true });
        await rename(temporary, target);
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return { ...record, manifest: cloneManifest(record.manifest) };
  }

  /** Remove an installed plugin. Built-in catalog availability is unaffected. */
  async uninstall(pluginId: string): Promise<void> {
    if (!PLUGIN_ID.test(pluginId)) throw new PosixLoomError("PLUGIN_ID_INVALID", "Plugin id is invalid", { pluginId });
    const target = join(this.installedRoot, `${pluginId}.json`);
    try {
      await access(target);
    } catch {
      throw new PosixLoomError("PLUGIN_NOT_INSTALLED", `Plugin is not installed: ${pluginId}`, { pluginId });
    }
    await rm(target, { force: true });
  }

  /** Resolve an installed command for explicit execution through PosixLoomService. */
  async command(pluginId: string, commandId: string): Promise<PluginCommand> {
    const record = (await this.records()).get(pluginId);
    if (!record) throw new PosixLoomError("PLUGIN_NOT_INSTALLED", `Plugin is not installed: ${pluginId}`, { pluginId });
    const command = record.manifest.commands.find((candidate) => candidate.id === commandId);
    if (!command) throw new PosixLoomError("PLUGIN_COMMAND_NOT_FOUND", `Plugin command is not installed: ${pluginId}/${commandId}`, { pluginId, commandId });
    return { ...command, input: cloneInput(command.input) };
  }
}
