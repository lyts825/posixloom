/**
 * PosixLoom's small in-process plugin kernel.
 *
 * The kernel deliberately knows nothing about commands, transports, or runtimes. It
 * only owns plugin identity, dependency ordering, typed extension points, lifecycle,
 * rollback, and inspection. Product capabilities live in plugins built on top of it.
 */
import { PosixLoomError, asPosixLoomError } from "../core/errors.js";

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const PLUGIN_VERSION = /^[0-9A-Za-z](?:[0-9A-Za-z.+-]{0,126}[0-9A-Za-z])?$/;
const EXTENSION_ID = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/;

/** A typed key for one family of plugin contributions. */
export interface ExtensionPoint<T> {
  readonly id: string;
  readonly description: string;
  /** Compile-time-only invariant marker. */
  readonly __type?: (value: T) => T;
}

/** Create a stable, serializable extension-point identity. */
export function createExtensionPoint<T>(id: string, description: string): ExtensionPoint<T> {
  if (typeof id !== "string" || !EXTENSION_ID.test(id)) {
    throw new PosixLoomError("PLUGIN_EXTENSION_INVALID", `Invalid extension point id: ${id}`, { id });
  }
  if (typeof description !== "string" || !description.trim()) {
    throw new PosixLoomError("PLUGIN_EXTENSION_INVALID", `Extension point ${id} requires a description`, { id });
  }
  return Object.freeze({ id, description });
}

/** Declarative metadata used before any plugin code is activated. */
export interface RuntimePluginManifest {
  id: string;
  version: string;
  description: string;
  /** Plugin ids that must activate first. */
  requires?: readonly string[];
  /** Extension-point ids this plugin is allowed to contribute to. */
  provides: readonly string[];
}

export interface ExtensionContributionOptions {
  /** Higher priority contributions are consulted first. Defaults to zero. */
  priority?: number;
  /** Stable label within the owning plugin, used by diagnostics. */
  name?: string;
}

export type PluginCleanup = () => void | Promise<void>;

/** The capability surface visible while a plugin is activating. */
export interface RuntimePluginContext {
  readonly manifest: Readonly<RuntimePluginManifest>;
  provide<T>(point: ExtensionPoint<T>, value: T, options?: ExtensionContributionOptions): void;
  extensions<T>(point: ExtensionPoint<T>): readonly T[];
  extension<T>(point: ExtensionPoint<T>): T;
  defer(cleanup: PluginCleanup): void;
}

/** Trusted in-process plugin definition. Marketplace command packs use data-only manifests instead. */
export interface RuntimePlugin {
  readonly manifest: RuntimePluginManifest;
  activate(context: RuntimePluginContext): void | Promise<void>;
  deactivate?(context: RuntimePluginContext): void | Promise<void>;
}

export type PluginKernelState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";
export type RuntimePluginState = "registered" | "active" | "stopped" | "failed";

export interface RuntimePluginInfo {
  id: string;
  version: string;
  description: string;
  requires: string[];
  provides: string[];
  state: RuntimePluginState;
}

interface RegisteredPlugin {
  plugin: RuntimePlugin;
  manifest: Readonly<RuntimePluginManifest>;
  registrationOrder: number;
  state: RuntimePluginState;
  cleanups: PluginCleanup[];
  contextOpen: boolean;
}

interface Contribution<T = unknown> {
  pointId: string;
  pluginId: string;
  name: string;
  priority: number;
  registrationOrder: number;
  contributionOrder: number;
  value: T;
}

function normalizedManifest(manifest: RuntimePluginManifest): Readonly<RuntimePluginManifest> {
  if (!manifest || typeof manifest !== "object") {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", "Runtime plugin manifest must be an object");
  }
  if (typeof manifest.id !== "string" || !PLUGIN_ID.test(manifest.id)) {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", `Invalid runtime plugin id: ${manifest.id}`, { id: manifest.id });
  }
  if (typeof manifest.version !== "string" || !PLUGIN_VERSION.test(manifest.version)) {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", `Invalid runtime plugin version: ${manifest.version}`, { id: manifest.id, version: manifest.version });
  }
  if (typeof manifest.description !== "string" || !manifest.description.trim()) {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", `Runtime plugin ${manifest.id} requires a description`, { id: manifest.id });
  }
  if (manifest.requires !== undefined && !Array.isArray(manifest.requires)) {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", `Runtime plugin ${manifest.id} dependencies must be an array`, { id: manifest.id });
  }
  if (!Array.isArray(manifest.provides)) {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", `Runtime plugin ${manifest.id} provided capabilities must be an array`, { id: manifest.id });
  }
  const requires = [...(manifest.requires ?? [])];
  const provides = [...manifest.provides];
  if (new Set(requires).size !== requires.length || requires.includes(manifest.id) || requires.some((id) => typeof id !== "string" || !PLUGIN_ID.test(id))) {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", `Runtime plugin ${manifest.id} has invalid dependencies`, { id: manifest.id, requires });
  }
  if (new Set(provides).size !== provides.length || provides.some((id) => typeof id !== "string" || !EXTENSION_ID.test(id))) {
    throw new PosixLoomError("PLUGIN_MANIFEST_INVALID", `Runtime plugin ${manifest.id} has invalid provided capabilities`, { id: manifest.id, provides });
  }
  return Object.freeze({
    id: manifest.id,
    version: manifest.version,
    description: manifest.description,
    requires: Object.freeze(requires),
    provides: Object.freeze(provides),
  });
}

/**
 * Dependency-aware plugin container with transactional activation.
 *
 * Registration is closed once activation starts. If any plugin fails, already-active
 * plugins are deactivated in reverse order and every contribution is removed.
 */
export class PluginKernel {
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly contributions = new Map<string, Contribution[]>();
  private activeOrder: RegisteredPlugin[] = [];
  private contributionSequence = 0;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private currentState: PluginKernelState = "idle";

  constructor(plugins: readonly RuntimePlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  get state(): PluginKernelState {
    return this.currentState;
  }

  /** Register a definition before activation. Duplicate ids fail closed. */
  register(plugin: RuntimePlugin): this {
    if (this.currentState !== "idle") {
      throw new PosixLoomError("PLUGIN_KERNEL_LOCKED", "Plugins can only be registered before the kernel starts", { state: this.currentState, pluginId: plugin?.manifest?.id });
    }
    if (!plugin || typeof plugin !== "object" || typeof plugin.activate !== "function") {
      throw new PosixLoomError("PLUGIN_DEFINITION_INVALID", "Runtime plugin must provide a manifest and activate function");
    }
    const manifest = normalizedManifest(plugin.manifest);
    if (this.plugins.has(manifest.id)) {
      throw new PosixLoomError("PLUGIN_DUPLICATE", `Runtime plugin is already registered: ${manifest.id}`, { pluginId: manifest.id });
    }
    this.plugins.set(manifest.id, {
      plugin,
      manifest,
      registrationOrder: this.plugins.size,
      state: "registered",
      cleanups: [],
      contextOpen: false,
    });
    return this;
  }

  /** Activate every plugin exactly once; concurrent callers share the same operation. */
  start(): Promise<void> {
    if (this.currentState === "running") return Promise.resolve();
    if (this.currentState === "starting" && this.startPromise) return this.startPromise;
    if (this.currentState !== "idle") {
      return Promise.reject(new PosixLoomError("PLUGIN_KERNEL_STATE", `Plugin kernel cannot start from ${this.currentState}`, { state: this.currentState }));
    }
    this.currentState = "starting";
    this.startPromise = this.activateAll();
    return this.startPromise;
  }

  private dependencyOrder(): RegisteredPlugin[] {
    const ordered: RegisteredPlugin[] = [];
    const permanent = new Set<string>();
    const visiting: string[] = [];

    const visit = (entry: RegisteredPlugin): void => {
      if (permanent.has(entry.manifest.id)) return;
      const cycleAt = visiting.indexOf(entry.manifest.id);
      if (cycleAt >= 0) {
        const cycle = [...visiting.slice(cycleAt), entry.manifest.id];
        throw new PosixLoomError("PLUGIN_DEPENDENCY_CYCLE", `Runtime plugin dependency cycle: ${cycle.join(" -> ")}`, { cycle });
      }
      visiting.push(entry.manifest.id);
      for (const dependencyId of entry.manifest.requires ?? []) {
        const dependency = this.plugins.get(dependencyId);
        if (!dependency) {
          throw new PosixLoomError("PLUGIN_DEPENDENCY_MISSING", `Runtime plugin ${entry.manifest.id} requires ${dependencyId}`, { pluginId: entry.manifest.id, dependencyId });
        }
        visit(dependency);
      }
      visiting.pop();
      permanent.add(entry.manifest.id);
      ordered.push(entry);
    };

    for (const entry of [...this.plugins.values()].sort((left, right) => left.registrationOrder - right.registrationOrder)) visit(entry);
    return ordered;
  }

  private async activateAll(): Promise<void> {
    let current: RegisteredPlugin | undefined;
    try {
      for (const entry of this.dependencyOrder()) {
        current = entry;
        entry.contextOpen = true;
        try {
          await entry.plugin.activate(this.contextFor(entry, true));
        } finally {
          entry.contextOpen = false;
        }
        entry.state = "active";
        this.activeOrder.push(entry);
      }
      this.currentState = "running";
    } catch (error) {
      if (current) {
        current.state = "failed";
        // Activation may have already registered contributions or cleanup callbacks.
        // Include the partially activated plugin in rollback even though it never
        // reached the normal active-order append below.
        if (!this.activeOrder.includes(current)) this.activeOrder.push(current);
      }
      await this.rollback();
      this.currentState = "failed";
      const failure = asPosixLoomError(error, "PLUGIN_ACTIVATION_FAILED");
      throw new PosixLoomError(failure.code, failure.message, {
        ...failure.details,
        pluginId: current?.manifest.id,
      });
    }
  }

  private contextFor(entry: RegisteredPlugin, allowContributions: boolean): RuntimePluginContext {
    return Object.freeze({
      manifest: entry.manifest,
      provide: <T>(point: ExtensionPoint<T>, value: T, options: ExtensionContributionOptions = {}): void => {
        if (!allowContributions || !entry.contextOpen) {
          throw new PosixLoomError("PLUGIN_CONTEXT_CLOSED", `Runtime plugin ${entry.manifest.id} can no longer contribute extensions`, { pluginId: entry.manifest.id });
        }
        if (!entry.manifest.provides.includes(point.id)) {
          throw new PosixLoomError("PLUGIN_CAPABILITY_UNDECLARED", `Runtime plugin ${entry.manifest.id} did not declare ${point.id}`, { pluginId: entry.manifest.id, extensionPoint: point.id });
        }
        const priority = options.priority ?? 0;
        if (!Number.isSafeInteger(priority)) {
          throw new PosixLoomError("PLUGIN_PRIORITY_INVALID", "Plugin contribution priority must be a safe integer", { pluginId: entry.manifest.id, extensionPoint: point.id, priority });
        }
        const name = options.name ?? `${entry.manifest.id}:${point.id}`;
        if (!name.trim() || name.length > 256) {
          throw new PosixLoomError("PLUGIN_CONTRIBUTION_INVALID", "Plugin contribution name must be a non-empty string of at most 256 characters", { pluginId: entry.manifest.id, extensionPoint: point.id });
        }
        const contribution: Contribution<T> = {
          pointId: point.id,
          pluginId: entry.manifest.id,
          name,
          priority,
          registrationOrder: entry.registrationOrder,
          contributionOrder: this.contributionSequence++,
          value,
        };
        const current = this.contributions.get(point.id) ?? [];
        current.push(contribution);
        this.contributions.set(point.id, current);
      },
      extensions: <T>(point: ExtensionPoint<T>): readonly T[] => this.values(point),
      extension: <T>(point: ExtensionPoint<T>): T => this.value(point),
      defer: (cleanup: PluginCleanup): void => {
        if (!entry.contextOpen) throw new PosixLoomError("PLUGIN_CONTEXT_CLOSED", `Runtime plugin ${entry.manifest.id} can no longer register cleanup callbacks`, { pluginId: entry.manifest.id });
        if (typeof cleanup !== "function") throw new PosixLoomError("PLUGIN_CLEANUP_INVALID", "Plugin cleanup must be a function", { pluginId: entry.manifest.id });
        entry.cleanups.push(cleanup);
      },
    });
  }

  private orderedContributions<T>(point: ExtensionPoint<T>): Contribution<T>[] {
    return [...(this.contributions.get(point.id) ?? [])]
      .map((contribution) => contribution as Contribution<T>)
      .sort((left, right) => right.priority - left.priority
        || left.registrationOrder - right.registrationOrder
        || left.contributionOrder - right.contributionOrder);
  }

  /** Resolve every contribution in deterministic priority order. */
  extensions<T>(point: ExtensionPoint<T>): readonly T[] {
    if (this.currentState !== "running") {
      throw new PosixLoomError("PLUGIN_KERNEL_NOT_READY", `Plugin kernel is ${this.currentState}`, { state: this.currentState, extensionPoint: point.id });
    }
    return this.values(point);
  }

  private values<T>(point: ExtensionPoint<T>): readonly T[] {
    return Object.freeze(this.orderedContributions(point).map((entry) => entry.value));
  }

  /** Resolve the highest-priority contribution, failing when the capability is absent. */
  extension<T>(point: ExtensionPoint<T>): T {
    if (this.currentState !== "running") {
      throw new PosixLoomError("PLUGIN_KERNEL_NOT_READY", `Plugin kernel is ${this.currentState}`, { state: this.currentState, extensionPoint: point.id });
    }
    return this.value(point);
  }

  private value<T>(point: ExtensionPoint<T>): T {
    const contribution = this.orderedContributions(point)[0];
    if (!contribution) {
      throw new PosixLoomError("PLUGIN_CAPABILITY_MISSING", `No plugin provides ${point.id}`, { extensionPoint: point.id });
    }
    return contribution.value;
  }

  /** Return a data-only inventory suitable for diagnostics and JSON APIs. */
  inspect(): RuntimePluginInfo[] {
    return [...this.plugins.values()]
      .sort((left, right) => left.registrationOrder - right.registrationOrder)
      .map((entry) => ({
        id: entry.manifest.id,
        version: entry.manifest.version,
        description: entry.manifest.description,
        requires: [...(entry.manifest.requires ?? [])],
        provides: [...entry.manifest.provides],
        state: entry.state,
      }));
  }

  /** Deactivate active plugins and cleanup their contributions in reverse order. */
  stop(): Promise<void> {
    if (this.currentState === "stopped") return Promise.resolve();
    if (this.currentState === "stopping" && this.stopPromise) return this.stopPromise;
    if (this.currentState === "starting" && this.startPromise) {
      return this.startPromise.then(() => this.stop(), () => Promise.resolve());
    }
    if (this.currentState !== "running" && this.currentState !== "failed") {
      return Promise.reject(new PosixLoomError("PLUGIN_KERNEL_STATE", `Plugin kernel cannot stop from ${this.currentState}`, { state: this.currentState }));
    }
    this.currentState = "stopping";
    this.stopPromise = this.stopAll();
    return this.stopPromise;
  }

  private async stopAll(): Promise<void> {
    const errors = await this.deactivate(this.activeOrder);
    this.activeOrder = [];
    this.contributions.clear();
    this.currentState = "stopped";
    if (errors.length) {
      throw new PosixLoomError("PLUGIN_DEACTIVATION_FAILED", `${errors.length} runtime plugin cleanup operation(s) failed`, { errors });
    }
  }

  private async rollback(): Promise<void> {
    await this.deactivate(this.activeOrder);
    this.activeOrder = [];
    this.contributions.clear();
  }

  private async deactivate(entries: readonly RegisteredPlugin[]): Promise<Array<{ pluginId: string; error: string }>> {
    const errors: Array<{ pluginId: string; error: string }> = [];
    for (const entry of [...entries].reverse()) {
      entry.contextOpen = true;
      try {
        await entry.plugin.deactivate?.(this.contextFor(entry, false));
      } catch (error) {
        errors.push({ pluginId: entry.manifest.id, error: String(error) });
      } finally {
        entry.contextOpen = false;
      }
      for (const cleanup of [...entry.cleanups].reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push({ pluginId: entry.manifest.id, error: String(error) });
        }
      }
      entry.cleanups = [];
      if (entry.state !== "failed") entry.state = "stopped";
      for (const [pointId, contributions] of this.contributions) {
        const retained = contributions.filter((contribution) => contribution.pluginId !== entry.manifest.id);
        if (retained.length) this.contributions.set(pointId, retained);
        else this.contributions.delete(pointId);
      }
    }
    return errors;
  }
}
