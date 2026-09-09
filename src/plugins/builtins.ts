/** First-party capabilities implemented through the same contracts as custom plugins. */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../core/classifier.js";
import { buildNativeEnv, buildPosixEnv } from "../core/env.js";
import { PosixLoomError } from "../core/errors.js";
import { runProcess } from "../core/process.js";
import { DEFAULT_NATIVE_ADAPTERS, DEFAULT_REGISTRY } from "../core/registry.js";
import { buildShellScript, canonicalShellHostPath, toMixedPath } from "../core/shell.js";
import { shellNamespaceIdentity } from "../core/shell-namespace.js";
import type { ExecutionPlan, MountBootstrap, NativeExecutionPlan, ShellExecutionPlan } from "../core/types.js";
import {
  COMMAND_CLASSIFIERS,
  COMMAND_RESOLVERS,
  EXECUTION_BACKENDS,
  EXECUTION_PLANNERS,
  NATIVE_COMMAND_ADAPTERS,
  NATIVE_COMMANDS,
  type CommandClassifier,
  type CommandResolver,
  type ExecutionBackend,
  type ExecutionPlanner,
} from "./contracts.js";
import type { RuntimePlugin } from "./kernel.js";

const argvClassifier: CommandClassifier = {
  id: "core.argv",
  classify({ input }) {
    if (input.kind !== "argv") return undefined;
    return { kind: "simple", argv: [...input.argv], reason: "exact argv request" };
  },
};

const textClassifier: CommandClassifier = {
  id: "core.shell-syntax",
  classify({ input }) {
    return input.kind === "text" ? classify(input.raw) : undefined;
  },
};

const nativeResolver: CommandResolver = {
  id: "core.native-fast-path",
  resolve(context) {
    const { classified, registry, runtime, policy, templateId } = context;
    if (classified.kind !== "simple" || !classified.argv?.length) return undefined;
    const native = registry.resolve(classified.argv[0], classified.argv, runtime.snapshot, runtime.mountTable, policy);
    if (!native) return undefined;
    return {
      templateId,
      runtimeId: runtime.snapshot.runtimeId,
      registryHash: runtime.snapshot.registryHash,
      commandKind: classified.kind,
      backend: "native",
      adapterId: native.descriptor.adapterId,
      reason: `native registry hit: ${classified.argv[0]}`,
      argv: native.adapter.argv,
      executable: native.executable,
      shellEquivalent: native.descriptor.shellEquivalent,
      pathDecisions: native.adapter.decisions,
    };
  },
};

const shellResolver: CommandResolver = {
  id: "core.msys2-fallback",
  resolve({ classified, runtime, templateId }) {
    return {
      templateId,
      runtimeId: runtime.snapshot.runtimeId,
      registryHash: runtime.snapshot.registryHash,
      commandKind: classified.kind,
      backend: "msys2",
      adapterId: "msys2-bash-v1",
      reason: classified.kind === "simple" ? "native registry miss; use MSYS2" : classified.reason,
      argv: classified.argv,
      executable: null,
      shellEquivalent: false,
      pathDecisions: [],
    };
  },
};

const nativePlanner: ExecutionPlanner = {
  id: "core.native-plan",
  build(context) {
    const { template, runtime, state, envDelta, cwdHost, commandId, sessionId, timeoutMs, terminal, policy } = context;
    if (template.backend !== "native") return undefined;
    if (!template.executable || !template.argv) throw new PosixLoomError("PLAN_INVALID", "Native template is incomplete");
    policy.assertExecutable(template.executable);
    const plan: NativeExecutionPlan = {
      mode: "native",
      planId: createHash("sha256").update(`${commandId}:${template.templateId}:${cwdHost}`).digest("hex"),
      commandId,
      sessionId,
      snapshotId: runtime.snapshot.snapshotId,
      timeoutMs,
      detached: false,
      policyProfile: runtime.config.runtime.policy.defaultProfile,
      terminal: terminal ? { ...terminal } : undefined,
      executable: template.executable,
      argv: template.argv.slice(1),
      cwdHost,
      envHost: buildNativeEnv(state, envDelta, runtime.snapshot.runtimeRoot, runtime.config.dataRoot, cwdHost),
      pathDecisions: template.pathDecisions.map((decision) => ({ ...decision })),
    };
    return plan;
  },
};

const shellPlanner: ExecutionPlanner = {
  id: "core.msys2-plan",
  build(context) {
    const { template, runtime, state, envDelta, virtualCwd, commandBody, commandId, sessionId, timeoutMs, terminal, statePolicy, policy } = context;
    if (template.backend !== "msys2") return undefined;
    const bash = runtime.findBash();
    if (!bash) throw new PosixLoomError("BASH_NOT_FOUND", "MSYS2 Bash was not found; set POSIXLOOM_BASH or install a release Runtime");
    policy.assertExecutable(bash);
    const envPosix = buildPosixEnv(state, envDelta, runtime.snapshot.runtimeRoot, runtime.config.dataRoot, virtualCwd);
    const stateReportPath = join(runtime.config.dataRoot, "tmp", `posixloom-${commandId}.report`);
    envPosix.POSIXLOOM_STATE_REPORT_PATH = toMixedPath(stateReportPath);
    const mountBootstrap: MountBootstrap[] = runtime.mountTable.entries.map((entry) => ({
      virtualPath: entry.virtualPath,
      hostPath: entry.hostPath,
    }));
    const plan: ShellExecutionPlan = {
      mode: "shell",
      planId: createHash("sha256").update(`${commandId}:${template.templateId}:${virtualCwd}`).digest("hex"),
      commandId,
      sessionId,
      snapshotId: runtime.snapshot.snapshotId,
      timeoutMs,
      detached: false,
      policyProfile: runtime.config.runtime.policy.defaultProfile,
      terminal: terminal ? { ...terminal } : undefined,
      bashExecutable: bash,
      commandBody,
      cwdVirtual: virtualCwd,
      envPosix,
      baseStateVersion: state.version,
      statePolicy,
      mountBootstrap,
      stateReportPath,
    };
    return plan;
  },
};

const nativeBackend: ExecutionBackend = {
  id: "core.native-process",
  mode: "native",
  async execute({ plan, runtime, hostPath, signal, interactive, onOutput }) {
    if (plan.mode !== "native") throw new PosixLoomError("BACKEND_PLAN_MISMATCH", "Native backend received a non-native plan");
    return runProcess({
      program: plan.executable,
      args: plan.argv,
      cwd: plan.cwdHost,
      env: plan.envHost,
      timeoutMs: plan.timeoutMs,
      cancelGraceMs: runtime.config.runtime.process.cancelGraceMs,
      hostPath,
      signal,
      maxOutputBytes: runtime.config.runtime.process.maxOutputBytes,
      outputDrainTimeoutMs: runtime.config.runtime.process.outputDrainTimeoutMs,
      maxReportBytes: runtime.config.runtime.process.maxReportBytes,
      onOutput,
      terminal: plan.terminal,
      interactive,
    });
  },
};

const shellBackend: ExecutionBackend = {
  id: "core.msys2-process",
  mode: "shell",
  async execute({ plan, runtime, hostPath, signal, interactive, onOutput }) {
    if (plan.mode !== "shell") throw new PosixLoomError("BACKEND_PLAN_MISMATCH", "MSYS2 backend received a non-shell plan");
    if (process.platform === "win32" && !hostPath) throw new PosixLoomError("NATIVE_HOST_MISSING", "Windows Shell execution requires the Native Host for shared MSYS mounts and process-tree isolation; run npm run build:host or use a complete Runtime");
    const shellNamespace = process.platform === "win32" ? shellNamespaceIdentity(plan.bashExecutable) : undefined;
    try {
      const temporaryDirectory = canonicalShellHostPath(runtime.mountTable.toHost("/tmp"));
      return await runProcess({
        program: plan.bashExecutable,
        shellNamespace,
        args: plan.terminal ? ["--noprofile", "--norc", "-c", buildShellScript(plan)] : ["--noprofile", "--norc", "-s"],
        cwd: runtime.mountTable.toHost(plan.cwdVirtual),
        // MSYS initializes its fixed /tmp mount BEFORE the wrapper runs. A POSIX
        // '/tmp' here would resolve against the current drive (e.g. C:\\tmp).
        // Supply the real host directory for bootstrap; the wrapper then restores
        // the declared POSIX environment so user commands still see TMP=/tmp.
        env: { ...plan.envPosix, TMP: temporaryDirectory, TEMP: temporaryDirectory, TMPDIR: temporaryDirectory },
        timeoutMs: plan.timeoutMs,
        cancelGraceMs: runtime.config.runtime.process.cancelGraceMs,
        input: plan.terminal ? undefined : buildShellScript(plan),
        reportPath: plan.stateReportPath,
        hostPath,
        signal,
        maxOutputBytes: runtime.config.runtime.process.maxOutputBytes,
        outputDrainTimeoutMs: runtime.config.runtime.process.outputDrainTimeoutMs,
        maxReportBytes: runtime.config.runtime.process.maxReportBytes,
        onOutput,
        terminal: plan.terminal,
        interactive,
      });
    } finally {
      rmSync(plan.stateReportPath, { force: true });
    }
  },
};

function plugin(
  manifest: RuntimePlugin["manifest"],
  activate: RuntimePlugin["activate"],
): RuntimePlugin {
  return { manifest, activate };
}

/** Return fresh first-party definitions so each RuntimeManager owns an isolated kernel. */
export function createBuiltinRuntimePlugins(): RuntimePlugin[] {
  return [
    plugin({
      id: "core.native-toolchain",
      version: "1.0.0",
      description: "Native command descriptors and argv adapters",
      provides: [NATIVE_COMMANDS.id, NATIVE_COMMAND_ADAPTERS.id],
    }, (context) => {
      for (const descriptor of DEFAULT_REGISTRY) context.provide(NATIVE_COMMANDS, { ...descriptor }, { name: descriptor.name });
      for (const adapter of DEFAULT_NATIVE_ADAPTERS) context.provide(NATIVE_COMMAND_ADAPTERS, adapter, { name: adapter.id });
    }),
    plugin({
      id: "core.classifier.argv",
      version: "1.0.0",
      description: "Exact argv input classifier",
      provides: [COMMAND_CLASSIFIERS.id],
    }, (context) => context.provide(COMMAND_CLASSIFIERS, argvClassifier, { priority: 200, name: argvClassifier.id })),
    plugin({
      id: "core.classifier.shell",
      version: "1.0.0",
      description: "POSIX shell syntax classifier",
      provides: [COMMAND_CLASSIFIERS.id],
    }, (context) => context.provide(COMMAND_CLASSIFIERS, textClassifier, { priority: 100, name: textClassifier.id })),
    plugin({
      id: "core.resolver.native",
      version: "1.0.0",
      description: "Native Fast Path resolver",
      requires: ["core.native-toolchain", "core.classifier.argv", "core.classifier.shell"],
      provides: [COMMAND_RESOLVERS.id],
    }, (context) => context.provide(COMMAND_RESOLVERS, nativeResolver, { priority: 100, name: nativeResolver.id })),
    plugin({
      id: "core.resolver.msys2",
      version: "1.0.0",
      description: "MSYS2 fallback resolver",
      requires: ["core.classifier.argv", "core.classifier.shell"],
      provides: [COMMAND_RESOLVERS.id],
    }, (context) => context.provide(COMMAND_RESOLVERS, shellResolver, { priority: -1_000, name: shellResolver.id })),
    plugin({
      id: "core.planner.native",
      version: "1.0.0",
      description: "Native execution plan builder",
      requires: ["core.resolver.native"],
      provides: [EXECUTION_PLANNERS.id],
    }, (context) => context.provide(EXECUTION_PLANNERS, nativePlanner, { priority: 100, name: nativePlanner.id })),
    plugin({
      id: "core.planner.msys2",
      version: "1.0.0",
      description: "MSYS2 execution plan builder",
      requires: ["core.resolver.msys2"],
      provides: [EXECUTION_PLANNERS.id],
    }, (context) => context.provide(EXECUTION_PLANNERS, shellPlanner, { priority: -1_000, name: shellPlanner.id })),
    plugin({
      id: "core.backend.native",
      version: "1.0.0",
      description: "Native process execution backend",
      requires: ["core.planner.native"],
      provides: [EXECUTION_BACKENDS.id],
    }, (context) => context.provide(EXECUTION_BACKENDS, nativeBackend, { name: nativeBackend.id })),
    plugin({
      id: "core.backend.msys2",
      version: "1.0.0",
      description: "MSYS2 Bash execution backend",
      requires: ["core.planner.msys2"],
      provides: [EXECUTION_BACKENDS.id],
    }, (context) => context.provide(EXECUTION_BACKENDS, shellBackend, { name: shellBackend.id })),
  ];
}

/** Type guard shared by service routing and plugin tests. */
export function planMode(plan: ExecutionPlan): ExecutionPlan["mode"] {
  return plan.mode;
}
