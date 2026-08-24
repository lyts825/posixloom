/** Typed extension points that make up the PosixLoom command pipeline. */
import { createExtensionPoint } from "./kernel.js";
import type { InteractiveProcessController, ProcessOutputEvent, ProcessRunResult } from "../core/process.js";
import type { PolicyGate } from "../core/policy.js";
import type { NativeCommandAdapter, NativeRegistry } from "../core/registry.js";
import type { RuntimeManager } from "../core/runtime.js";
import type {
  ClassifiedCommand,
  ExecutionPlan,
  NativeCommandDescriptor,
  ResolutionTemplate,
  SessionState,
  StatePolicy,
  TerminalSize,
} from "../core/types.js";

export type RuntimeCommandInput =
  | { kind: "text"; raw: string }
  | { kind: "argv"; argv: readonly string[] };

export interface CommandClassifierContext {
  input: RuntimeCommandInput;
}

export interface CommandClassifier {
  id: string;
  classify(context: CommandClassifierContext): ClassifiedCommand | undefined | Promise<ClassifiedCommand | undefined>;
}

export interface CommandResolverContext {
  identity: string;
  classified: ClassifiedCommand;
  templateId: string;
  runtime: RuntimeManager;
  registry: NativeRegistry;
  policy: PolicyGate;
}

export interface CommandResolver {
  id: string;
  resolve(context: CommandResolverContext): ResolutionTemplate | undefined | Promise<ResolutionTemplate | undefined>;
}

export interface ExecutionPlanContext {
  commandId: string;
  commandBody: string;
  sessionId: string;
  envDelta?: Record<string, string | null>;
  terminal?: TerminalSize;
  state: SessionState;
  statePolicy: StatePolicy;
  template: ResolutionTemplate;
  virtualCwd: string;
  cwdHost: string;
  timeoutMs: number;
  runtime: RuntimeManager;
  policy: PolicyGate;
}

export interface ExecutionPlanner {
  id: string;
  build(context: ExecutionPlanContext): ExecutionPlan | undefined | Promise<ExecutionPlan | undefined>;
}

export interface ExecutionBackendContext {
  plan: ExecutionPlan;
  runtime: RuntimeManager;
  hostPath?: string;
  signal?: AbortSignal;
  interactive?: InteractiveProcessController;
  onOutput?: (event: ProcessOutputEvent) => void | Promise<void>;
}

export interface ExecutionBackend {
  id: string;
  mode: ExecutionPlan["mode"];
  execute(context: ExecutionBackendContext): Promise<ProcessRunResult>;
}

export interface ExecutionHookContext {
  runtime: RuntimeManager;
  input: RuntimeCommandInput;
  sessionId: string;
}

/** Optional observers cannot alter plans or suppress security checks. */
export interface ExecutionHook {
  id: string;
  beforePrepare?(context: ExecutionHookContext): void | Promise<void>;
  afterPrepare?(context: ExecutionHookContext & { plan: ExecutionPlan }): void | Promise<void>;
  afterExecute?(context: ExecutionHookContext & { plan: ExecutionPlan; result: ProcessRunResult }): void | Promise<void>;
  onError?(context: ExecutionHookContext & { error: unknown }): void | Promise<void>;
}

export const NATIVE_COMMANDS = createExtensionPoint<NativeCommandDescriptor>(
  "command.native-descriptor",
  "Native Fast Path command descriptors",
);

export const NATIVE_COMMAND_ADAPTERS = createExtensionPoint<NativeCommandAdapter>(
  "command.native-adapter",
  "Native argv and virtual-path adapters",
);

export const COMMAND_CLASSIFIERS = createExtensionPoint<CommandClassifier>(
  "command.classifier",
  "Command input classifiers",
);

export const COMMAND_RESOLVERS = createExtensionPoint<CommandResolver>(
  "command.resolver",
  "Ordered command backend resolvers",
);

export const EXECUTION_PLANNERS = createExtensionPoint<ExecutionPlanner>(
  "execution.planner",
  "Execution plan builders",
);

export const EXECUTION_BACKENDS = createExtensionPoint<ExecutionBackend>(
  "execution.backend",
  "Process execution backends",
);

export const EXECUTION_HOOKS = createExtensionPoint<ExecutionHook>(
  "execution.hook",
  "Read-only execution lifecycle observers",
);
