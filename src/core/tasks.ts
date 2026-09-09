import { join, posix } from "node:path";
import { PosixLoomError } from "./errors.js";
import { isRecord, parseExecutionRequest } from "./execution-request.js";
import { normalizeEnv, validateStatePatch } from "./env.js";
import { normalizeVirtual } from "./path.js";
import { inFileLane, plainDirectory, readBoundedJson, writeAtomicJson } from "./state-files.js";
import type { JobStep } from "./jobs.js";
import type { PosixLoomService } from "./service.js";

export const TASK_LIMITS = Object.freeze({ maxTasks: 128, maxSteps: 64, maxParameters: 32, maxArtifacts: 64, maxFileBytes: 1024 * 1024, maxValueBytes: 32768 });
export interface TaskParameter { type: "string" | "enum"; default?: string; required?: boolean; values?: string[] }
export interface TaskDefinition { id: string; title?: string; parameters?: Record<string, TaskParameter>; steps: JobStep[]; artifacts?: string[] }
export interface TaskManifest { schemaVersion: 1; tasks: TaskDefinition[] }
export interface ResolvedProjectTask { label: string; steps: JobStep[]; artifacts: string[] }

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const parameterName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const placeholder = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
function invalid(message: string): never { throw new PosixLoomError("TASK_INVALID", message); }
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid("Task definition contains an unknown field");
}
function textValue(value: unknown, name: string, max: number = TASK_LIMITS.maxValueBytes): string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > max) return invalid(`${name} must be a bounded NUL-free string`);
  return value;
}
function checkTemplates(value: string, parameters: Record<string, TaskParameter>, wholeArgument = false): void {
  const matches = [...value.matchAll(placeholder)];
  if (matches.some((match) => !Object.hasOwn(parameters, match[1]))) invalid("Template references an undeclared parameter");
  if (wholeArgument && matches.length && (matches.length !== 1 || matches[0][0] !== value)) invalid("An argv parameter must occupy a complete argument");
}
function virtualPath(value: string): void {
  if (!value.startsWith("/") || value !== normalizeVirtual(value)) invalid("Task paths must be normalized absolute virtual paths");
}
function checkInterpreterArguments(argv: string[]): void {
  if ([...argv[0].matchAll(placeholder)].length) invalid("The executable name must be fixed in a task definition");
  const executable = posix.basename(argv[0].replaceAll("\\", "/")).toLowerCase().replace(/\.exe$/, "");
  const shell = ["sh", "bash", "dash", "zsh", "ksh", "fish"].includes(executable);
  const windowsShell = ["cmd", "powershell", "pwsh"].includes(executable);
  const interpreter = ["node", "python", "python3", "perl", "ruby"].includes(executable);
  if (!shell && !windowsShell && !interpreter) return;
  for (let index = 1; index < argv.length - 1; index += 1) {
    const flag = argv[index].toLowerCase();
    const codeFlag = shell ? /^-[a-z]*c[a-z]*$/.test(flag)
      : windowsShell ? ["/c", "/k", "-c", "-command", "-encodedcommand", "-enc"].includes(flag)
        : ["-e", "-p", "-c", "--eval", "--print"].includes(flag);
    if (codeFlag && [...argv[index + 1].matchAll(placeholder)].length) invalid("Task parameters cannot supply interpreter source code; use a fixed script and data arguments");
  }
}

export function parseTaskDefinition(value: unknown): TaskDefinition {
  if (!isRecord(value)) return invalid("Task must be an object");
  keys(value, ["id", "title", "parameters", "steps", "artifacts"]);
  if (typeof value.id !== "string" || !identifier.test(value.id)) return invalid("Task id must contain 1 to 64 safe identifier characters");
  const title = value.title === undefined ? undefined : textValue(value.title, "title", 256);
  const parameters: Record<string, TaskParameter> = Object.create(null);
  if (value.parameters !== undefined) {
    if (!isRecord(value.parameters) || Object.keys(value.parameters).length > TASK_LIMITS.maxParameters) return invalid("Task parameters must be an object with at most 32 entries");
    for (const [name, definition] of Object.entries(value.parameters)) {
      if (!parameterName.test(name) || !isRecord(definition)) return invalid("Invalid task parameter");
      keys(definition, ["type", "default", "required", "values"]);
      if (definition.type !== "string" && definition.type !== "enum") return invalid("Parameter type must be string or enum");
      if (definition.required !== undefined && typeof definition.required !== "boolean") return invalid("Parameter required must be a boolean");
      const defaultValue = definition.default === undefined ? undefined : textValue(definition.default, "parameter default");
      let values: string[] | undefined;
      if (definition.type === "enum") {
        if (!Array.isArray(definition.values) || !definition.values.length || definition.values.length > 128) return invalid("Enum parameter requires 1 to 128 values");
        values = definition.values.map((item) => textValue(item, "enum value"));
        if (new Set(values).size !== values.length || (defaultValue !== undefined && !values.includes(defaultValue))) return invalid("Enum values must be distinct and contain the default");
      } else if (definition.values !== undefined) return invalid("Only enum parameters may specify values");
      parameters[name] = { type: definition.type, ...(defaultValue === undefined ? {} : { default: defaultValue }), ...(definition.required === undefined ? {} : { required: definition.required }), ...(values ? { values } : {}) };
    }
  }
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > TASK_LIMITS.maxSteps) return invalid("A task requires 1 to 64 steps");
  const ids = new Set<string>();
  const steps = value.steps.map((entry): JobStep => {
    if (!isRecord(entry)) return invalid("Task step must be an object");
    keys(entry, ["id", "input", "cwd", "envDelta", "timeoutMs", "statePolicy"]);
    if (typeof entry.id !== "string" || !identifier.test(entry.id) || ids.has(entry.id)) return invalid("Step ids must be valid and unique");
    ids.add(entry.id);
    if (!isRecord(entry.input)) return invalid("Task step requires input");
    keys(entry.input, entry.input.kind === "argv" ? ["kind", "argv"] : ["kind", "raw"]);
    const parsed = parseExecutionRequest(entry, { code: "TASK_INVALID", allowTerminal: false });
    if (parsed.input.kind === "argv") {
      for (const argument of parsed.input.argv) checkTemplates(argument, parameters, true);
      checkInterpreterArguments(parsed.input.argv);
    } else if ([...parsed.input.raw.matchAll(placeholder)].some((match) => Object.hasOwn(parameters, match[1]))) {
      return invalid("Shell text is fixed and cannot interpolate task parameters; pass values through argv or envDelta");
    }
    if (parsed.cwd !== undefined) { checkTemplates(parsed.cwd, parameters); virtualPath(parsed.cwd); }
    if (parsed.envDelta) {
      // Check ownership now; validate PATH after substitution during resolution.
      const validationEnv: Record<string, string> = Object.create(null);
      normalizeEnv(Object.fromEntries(Object.keys(parsed.envDelta).map((key) => [key, ""])));
      for (const [key, item] of Object.entries(parsed.envDelta)) {
        if (item !== null) { checkTemplates(item, parameters); validationEnv[key] = key.toUpperCase() === "PATH" && [...item.matchAll(placeholder)].length ? "/posixloom/bin:/usr/bin" : item; }
      }
      normalizeEnv(validationEnv);
      validateStatePatch({ baseStateVersion: 0n, setEnv: validationEnv, removeEnv: Object.entries(parsed.envDelta).filter(([, item]) => item === null).map(([key]) => key) }, { version: 0n, cwd: "/workspace", exportedEnv: {} }, "cwd-env");
    }
    return { id: entry.id, input: parsed.input, ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }), ...(parsed.envDelta ? { envDelta: parsed.envDelta } : {}), ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }), ...(parsed.statePolicy ? { statePolicy: parsed.statePolicy } : {}) };
  });
  let artifacts: string[] | undefined;
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts) || value.artifacts.length > TASK_LIMITS.maxArtifacts) return invalid("Task artifacts require at most 64 paths");
    artifacts = value.artifacts.map((item) => { const path = textValue(item, "artifact"); checkTemplates(path, parameters); virtualPath(path); return path; });
  }
  return { id: value.id, ...(title === undefined ? {} : { title }), ...(value.parameters === undefined ? {} : { parameters }), steps, ...(artifacts === undefined ? {} : { artifacts }) };
}

export function parseTaskManifest(value: unknown): TaskManifest {
  if (!isRecord(value)) return invalid("Task manifest must be an object");
  keys(value, ["schemaVersion", "tasks"]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.tasks) || value.tasks.length > TASK_LIMITS.maxTasks) return invalid("Task manifest requires schemaVersion 1 and at most 128 tasks");
  const tasks = value.tasks.map(parseTaskDefinition);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) return invalid("Task ids must be unique");
  if (Buffer.byteLength(JSON.stringify({ schemaVersion: 1, tasks }, null, 2)) + 1 > TASK_LIMITS.maxFileBytes) return invalid("Task manifest exceeds 1 MiB");
  return { schemaVersion: 1, tasks };
}

/** Project files are declarations only; loading or saving never executes a task. */
export class ProjectTaskStore {
  readonly manifestPath: string;
  private readonly directory: string;
  constructor(service: PosixLoomService) {
    this.directory = join(service.runtime.config.runtime.runtime.workspace, ".posixloom");
    this.manifestPath = join(this.directory, "tasks.json");
  }
  async list(): Promise<TaskDefinition[]> {
    if (!await plainDirectory(this.directory)) return [];
    const value = await readBoundedJson(this.manifestPath, TASK_LIMITS.maxFileBytes);
    return value === undefined ? [] : parseTaskManifest(value).tasks;
  }
  async saveManifest(value: unknown): Promise<TaskManifest> {
    const manifest = parseTaskManifest(value);
    return inFileLane(this.manifestPath, async () => { await writeAtomicJson(this.manifestPath, manifest, TASK_LIMITS.maxFileBytes); return manifest; });
  }
  async save(value: unknown): Promise<TaskDefinition> {
    const definition = parseTaskDefinition(value);
    return inFileLane(this.manifestPath, async () => {
      const tasks = await this.list();
      const index = tasks.findIndex((task) => task.id === definition.id);
      if (index < 0) tasks.push(definition); else tasks[index] = definition;
      const manifest = parseTaskManifest({ schemaVersion: 1, tasks });
      await writeAtomicJson(this.manifestPath, manifest, TASK_LIMITS.maxFileBytes);
      return definition;
    });
  }
  async delete(taskId: string): Promise<void> {
    await inFileLane(this.manifestPath, async () => {
      const tasks = await this.list();
      if (!tasks.some((task) => task.id === taskId)) throw new PosixLoomError("TASK_NOT_FOUND", "Unknown project task");
      await writeAtomicJson(this.manifestPath, { schemaVersion: 1, tasks: tasks.filter((task) => task.id !== taskId) }, TASK_LIMITS.maxFileBytes);
    });
  }
  async resolve(taskId: string, supplied: unknown = {}): Promise<ResolvedProjectTask> {
    const definition = (await this.list()).find((task) => task.id === taskId);
    if (!definition) throw new PosixLoomError("TASK_NOT_FOUND", "Unknown project task");
    if (!isRecord(supplied)) return invalid("Task parameter values must be an object");
    const parameters = definition.parameters ?? {};
    if (Object.keys(supplied).some((key) => !Object.hasOwn(parameters, key))) return invalid("Unknown task parameter");
    const values: Record<string, string> = Object.create(null);
    for (const [name, parameter] of Object.entries(parameters)) {
      const value = Object.hasOwn(supplied, name) ? textValue(supplied[name], "parameter value") : parameter.default;
      if (value === undefined && parameter.required) return invalid(`Missing required parameter: ${name}`);
      if (value !== undefined && parameter.type === "enum" && !parameter.values!.includes(value)) return invalid(`Parameter is outside its allowed values: ${name}`);
      if (value !== undefined) values[name] = value;
    }
    const substitute = (input: string): string => input.replace(placeholder, (_match, name: string) => {
      if (!Object.hasOwn(values, name)) return invalid(`Missing parameter used by a task step: ${name}`);
      return values[name];
    });
    const steps = definition.steps.map((step): JobStep => {
      const input = step.input.kind === "argv" ? { kind: "argv" as const, argv: step.input.argv.map(substitute) } : step.input;
      const cwd = step.cwd === undefined ? undefined : substitute(step.cwd);
      if (cwd !== undefined) virtualPath(cwd);
      const envDelta = step.envDelta ? Object.fromEntries(Object.entries(step.envDelta).map(([key, value]) => [key, value === null ? null : substitute(value)])) : undefined;
      const resolved = { ...step, input, cwd, envDelta };
      parseExecutionRequest(resolved, { code: "TASK_INVALID", allowTerminal: false });
      if (envDelta) validateStatePatch({ baseStateVersion: 0n, setEnv: Object.fromEntries(Object.entries(envDelta).filter((entry): entry is [string, string] => entry[1] !== null)), removeEnv: Object.entries(envDelta).filter(([, value]) => value === null).map(([key]) => key) }, { version: 0n, cwd: cwd ?? "/workspace", exportedEnv: {} }, "cwd-env");
      return resolved;
    });
    const artifacts = (definition.artifacts ?? []).map((path) => { const resolved = substitute(path); textValue(resolved, "artifact"); virtualPath(resolved); return resolved; });
    return { label: definition.title || definition.id, steps, artifacts };
  }
}
