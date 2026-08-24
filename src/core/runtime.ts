/**
 * runtime.ts -- PosixLoom 运行时（Runtime）加载、验证与自检模块。
 *
 * 职责：
 * 1. 依据 runRoot 加载配置并解析 runtime/current 指针，定位当前 Runtime 目录；
 * 2. 读取 manifest.json 并交给 validateRuntimeManifest 做深度校验；
 * 3. 把校验结果与运行时各路内容哈希合成为不可变快照（RuntimeSnapshot/snapshotId）；
 * 4. 提供关键二进制定位（findBash / findNativeHost）与整体自检报告（doctor）；
 * 5. release 模式下在每条命令边界复验运行时完整性（assertRuntimeIntegrity），
 *    防止运行时目录在命令执行期间被篡改。
 *
 * 设计意图：
 * - 为什么 release 模式强制组件布局与哈希校验：便携包内的 node/git/rg/bash 是
 *   宿主机上一切命令执行的信任根基，一旦被替换即可绕过 PosixLoom 的全部策略执行任意
 *   代码。因此 release manifest 必须声明规范布局（RELEASE_COMPONENT_LAYOUTS）、
 *   entrypoint SHA-256 与整树哈希（每文件 SHA-256 按路径排序串联后再哈希），
 *   任何偏差都按 FAIL 处理。
 * - 为什么快照不可变：snapshotId 由 runtimeId、manifest 哈希、注册表哈希、
 *   挂载表哈希、策略哈希五路输入共同合成。会话、状态上报与更新器据此判断
 *   "当前环境是否仍是启动时的那个环境"，避免环境漂移导致行为不可复现或越权。
 * - 为什么命令边界复验完整性：bash 命令本身有能力改写运行时目录，而 fs.watch
 *   的事件既不保证送达也不保证及时，因此监听器只承担"未变"的快路径；脏标记
 *   置位或监听不可用时，命令前后都会重跑完整 manifest 验证，失败抛
 *   RUNTIME_INTEGRITY_CHANGED，阻止受损运行时继续执行后续命令。
 * - 恢复模式的意义：正常路径下坏指针/坏 manifest 直接抛错拒绝启动；但 posixloom doctor
 *   等诊断工具需要"带病运行"来输出问题。allowInvalidRuntime 允许构造 fallback
 *   manifest 进入 recoveryRequired 状态，把失败收集为 DoctorCheck 而非异常，
 *   同时不启用运行时完整性监听（恢复态下的运行时本就不可信）。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isSafeRuntimeId, loadConfig, type LoadedConfig } from "./config.js";
import { PosixLoomError } from "./errors.js";
import { MountTable } from "./path.js";
import { DEFAULT_REGISTRY, NativeRegistry } from "./registry.js";
import type { HostPath, RuntimeComponentManifest, RuntimeManifest, RuntimeSnapshot } from "./types.js";

/** release Runtime 必须全部声明并标记为 required 的基础环境组件清单。 */
export const REQUIRED_RUNTIME_COMPONENTS = ["node", "msys2", "mingit", "ripgrep", "posixloom", "shims"] as const;

/**
 * release 模式下各组件的规范（canonical）布局：root 为组件目录，entrypoint 为
 * 入口可执行文件。强制与规范布局逐字匹配，可防止 manifest 把 entrypoint 指向
 * 规范位置之外（例如另一个组件目录内或 RuntimeRoot 外）的可执行文件，
 * 从而绕过布局与哈希约束。
 */
const RELEASE_COMPONENT_LAYOUTS: Record<string, { root: string; entrypoint: string }> = {
  node: { root: "node", entrypoint: "node/node.exe" },
  msys2: { root: "msys", entrypoint: "msys/usr/bin/bash.exe" },
  mingit: { root: "native/mingit", entrypoint: "native/mingit/cmd/git.exe" },
  ripgrep: { root: "native/rg", entrypoint: "native/rg/rg.exe" },
  posixloom: { root: "native/posixloom-host", entrypoint: "native/posixloom-host/posixloom.exe" },
  shims: { root: "shims", entrypoint: "shims/node" },
};

/** 对文本取 SHA-256 十六进制摘要，用于合成各路内容哈希与 snapshotId。 */
function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 在 PATH 上查找命令的第一个命中路径；找不到或查找器执行失败时返回 undefined。 */
function findOnPath(command: string): string | undefined {
  try {
    const finder = process.platform === "win32" ? "where.exe" : "which";
    return execFileSync(finder, [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/)[0] || undefined;
  } catch {
    return undefined;
  }
}

/** 返回命令在 PATH 上的全部命中路径（按 PATH 顺序）；找不到时返回空数组。 */
function findAllOnPath(command: string): string[] {
  try {
    const finder = process.platform === "win32" ? "where.exe" : "which";
    return execFileSync(finder, [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 从一组 git 可执行文件路径推导其所属 Git for Windows 安装内的 bash 候选路径。
 *
 * 背景与规则：git.exe 通常位于 <git根>\cmd\ 或 <git根>\bin\ 下，与之配套的
 * bash 分别在 <git根>\usr\bin\bash.exe（完整安装）与 <git根>\bin\bash.exe
 * （精简安装）。仅当 git 路径的末段目录名是 bin/cmd 时才认定其为标准
 * Git for Windows 布局，否则跳过。候选按出现顺序去重（Windows 下路径大小写
 * 归一），保证 PATH 中更靠前的 Git 优先被选用。
 *
 * dev 模式的 findBash 候选链依赖本函数实现"未打包 MSYS2 但装有 Git"的
 * 开发机兜底。
 *
 * @param gitPaths where.exe/which 找到的 git 可执行文件路径列表
 * @returns 去重后的 bash 候选路径（按推导顺序排列；是否真实存在由调用方探测）
 */
export function deriveGitBashCandidates(gitPaths: string[]): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const gitPath of gitPaths) {
    const gitDirectory = dirname(resolve(gitPath));
    if (!/^(?:bin|cmd)$/i.test(basename(gitDirectory))) continue;
    const gitRoot = dirname(gitDirectory);
    for (const candidate of [join(gitRoot, "usr", "bin", "bash.exe"), join(gitRoot, "bin", "bash.exe")]) {
      const identity = process.platform === "win32" ? candidate.toLowerCase() : candidate;
      if (!seen.has(identity)) {
        seen.add(identity);
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

/** 单项自检结果：id 用于归类与去重，level 为 PASS/WARN/FAIL，message 面向用户，details 供诊断展开。 */
export interface DoctorCheck {
  id: string;
  level: "PASS" | "WARN" | "FAIL";
  message: string;
  details?: Record<string, unknown>;
}

/** doctor 整体报告：ok 为 true 当且仅当不存在任何 FAIL 级别的检查项。 */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/** 判断 candidate 是否位于 root 目录内（含等于 root 本身）；Windows 上路径按大小写不敏感比较。 */
function pathIsInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (process.platform === "win32") {
    const rootLower = normalizedRoot.toLowerCase();
    const candidateLower = normalizedCandidate.toLowerCase();
    return candidateLower === rootLower || candidateLower.startsWith(`${rootLower}${sep}`);
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

/**
 * 校验 manifest 中声明的路径是否为安全的相对路径（类型守卫）：
 * 非空、不含 NUL 与冒号（拒绝 "d:\x"、UNC 形态）、不以 / 或 \ 开头（拒绝绝对路径），
 * 且按 / 与 \ 切分后的每一段都非空且不为 "."、".."（拒绝目录穿越逃逸 RuntimeRoot）。
 */
function safeManifestPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && !value.includes(":")
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && value.split(/[\\/]/).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** 读取整个文件内容并计算 SHA-256 十六进制摘要。 */
function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 递归收集目录下所有普通文件的绝对路径。
 * 遇到符号链接/reparse point 立即抛 RUNTIME_LINK_FORBIDDEN：链接可让"已校验
 * 哈希的干净路径"在磁盘层面指向任意其他内容，是哈希校验的天敌，必须一票否决。
 */
function listFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else if (entry.isSymbolicLink()) throw new PosixLoomError("RUNTIME_LINK_FORBIDDEN", "Runtime components cannot contain symbolic links or reparse points", { path });
    }
  };
  visit(root);
  return files;
}

/**
 * 计算组件目录的整树哈希：先按相对路径对全部文件排序（保证结论与枚举顺序无关），
 * 再把每行 "相对路径\0文件SHA-256\n" 依次喂入同一个 SHA-256 摘要器后一次性输出。
 * 把路径混入摘要可防止"只换文件名、内容不变"的替换绕过检测；返回文件数供与
 * manifest 声明的 fileCount 交叉比对，防止在树中静默增删文件。
 */
function hashTree(root: string): { hash: string; fileCount: number } {
  const files = listFiles(root).sort((left, right) => {
    const leftRelative = relativePath(root, left);
    const rightRelative = relativePath(root, right);
    return leftRelative < rightRelative ? -1 : leftRelative > rightRelative ? 1 : 0;
  });
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(`${relativePath(root, file)}\0${hashFile(file)}\n`, "utf8");
  }
  return { hash: digest.digest("hex"), fileCount: files.length };
}

/** 计算 file 相对 root 的 POSIX 风格路径（统一 / 分隔）；file 不在 root 下时返回其绝对路径。 */
function relativePath(root: string, file: string): string {
  const rootPrefix = `${resolve(root)}${sep}`;
  return resolve(file).startsWith(rootPrefix)
    ? resolve(file).slice(rootPrefix.length).replaceAll("\\", "/")
    : resolve(file).replaceAll("\\", "/");
}

/** 判断值是否为非数组的普通对象（即 JSON 对象）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 深度校验 Runtime manifest（development 与 release 两种模式）。
 *
 * 纯本地校验：只依赖传入的 manifest 值与 runtimeRoot 目录本身，不查询 PATH、
 * 不读取任何外部状态，因此可以在启动、doctor 与每条命令边界反复执行且结论一致。
 * 校验结果不抛异常而是返回 DoctorCheck 列表，由调用方决定升级为
 * RUNTIME_VALIDATION_FAILED / RUNTIME_INTEGRITY_CHANGED 或仅作诊断输出。
 *
 * 各校验段落及防御目标：
 * 1. 结构与身份：manifest 必须是 JSON 对象，manifestVersion=1、mode 合法、
 *    runtimeId/runtimeSemver 符合格式、updateSequence 为非负安全整数
 *    （单调性供更新器防旧 manifest 回滚重放）。
 * 2. 组件路径：root/entrypoint/license/SBOM/sourceLock 均须通过 safeManifestPath
 *    且解析后不逃逸 runtimeRoot 与组件自身 root，防 ../、盘符、UNC 等路径逃逸。
 * 3. 符号链接：所有被校验的路径都必须是真实文件/目录，防链接"偷梁换柱"。
 * 4. release 规范布局：组件 root/entrypoint 必须与 RELEASE_COMPONENT_LAYOUTS
 *    逐字一致，防止 entrypoint 指向规范布局之外的任意可执行文件。
 * 5. 哈希：entrypoint SHA-256、整树 treeSha256、fileCount 三重比对，防内容被
 *    替换、被增删文件或哈希本身被伪造。
 * 6. release 供应链元数据：全部基础组件声明且 required、生成 shim 齐全、
 *    license 列表、SPDX-2.3 SBOM、sourceLock 哈希俱全，保证便携包可审计、可复现。
 *
 * development 模式下文件缺失记 WARN（missingLevel），release 模式一律 FAIL。
 *
 * @param value 从 manifest.json 读出的任意 JSON 值
 * @param runtimeRoot 当前 Runtime 根目录，manifest 内所有相对路径以此为基准解析
 * @returns DoctorCheck 列表；空数组表示完全通过
 */
export function validateRuntimeManifest(value: unknown, runtimeRoot: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const add = (id: string, level: DoctorCheck["level"], message: string, details?: Record<string, unknown>) => checks.push({ id, level, message, details });
  // 段落 1a：顶层必须是 JSON 对象，否则后续字段无从校验，直接短路返回。
  if (!isRecord(value)) {
    add("manifest.schema", "FAIL", "Runtime manifest must be a JSON object");
    return checks;
  }
  const manifest = value as unknown as RuntimeManifest;
  const release = manifest.mode === "release";
  // 缺失项的级别：release 一律 FAIL（便携包必须自洽），development 降级为 WARN。
  const missingLevel: DoctorCheck["level"] = release ? "FAIL" : "WARN";

  // 段落 1b：版本与身份。manifestVersion/mode/runtimeId/Semver 必须合法，防止
  // 伪造或版本不兼容的 manifest；updateSequence 要求非负安全整数，供更新器做
  // 单调性检查，阻止旧 manifest（回滚攻击）被重放为"更新"。
  if (manifest.manifestVersion !== 1) add("manifest.schema", "FAIL", "Unsupported runtime manifest version", { actual: manifest.manifestVersion, expected: 1 });
  if (manifest.mode !== "development" && manifest.mode !== "release") add("manifest.mode", "FAIL", "Runtime manifest must declare development or release mode", { actual: manifest.mode });
  if (typeof manifest.runtimeId !== "string" || !isSafeRuntimeId(manifest.runtimeId) || typeof manifest.runtimeSemver !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.runtimeSemver)) {
    add("manifest.identity", "FAIL", "Runtime manifest has an invalid runtimeId or runtimeSemver");
  }
  if (manifest.updateSequence !== undefined && (!Number.isSafeInteger(manifest.updateSequence) || manifest.updateSequence < 0)) {
    add("manifest.update-sequence", "FAIL", "Runtime manifest updateSequence must be a non-negative safe integer");
  }
  if (release && (!Array.isArray(manifest.components) || manifest.components.length === 0)) {
    add("manifest.components", "FAIL", "Release manifest has no component records");
  } else if (manifest.components !== undefined && !Array.isArray(manifest.components)) {
    add("manifest.components", "FAIL", "Runtime manifest components must be an array");
  }

  // 段落 2：逐条校验组件记录：id/version 格式 -> 路径安全（safeManifestPath）->
  // id 去重 -> release 规范布局 -> 目录/entrypoint 真实存在且非链接 ->
  // entrypoint 哈希 -> 整树哈希与文件数。
  const components: unknown[] = Array.isArray(manifest.components) ? manifest.components : [];
  const byId = new Map<string, RuntimeComponentManifest>();
  for (const rawComponent of components) {
    if (!isRecord(rawComponent)) {
      add("manifest.component.invalid", "FAIL", "Component record must be a JSON object");
      continue;
    }
    const component = rawComponent as unknown as RuntimeComponentManifest;
    if (typeof component.id !== "string" || !isSafeRuntimeId(component.id) || typeof component.version !== "string" || !component.version) {
      add("manifest.component.invalid", "FAIL", "Component record has an invalid id or version");
      continue;
    }
    if (!safeManifestPath(component.root) || !safeManifestPath(component.entrypoint)) {
      add(`manifest.component.${component.id}`, "FAIL", "Component path must be relative and cannot escape RuntimeRoot", { root: component.root, entrypoint: component.entrypoint });
      continue;
    }
    if (byId.has(component.id)) {
      add(`manifest.component.${component.id}`, "FAIL", "Component id is duplicated", { id: component.id });
      continue;
    }
    // 段落 4：release 模式强制规范布局（统一分隔符后逐字比较 root 与 entrypoint），
    // 防止 entrypoint 指向规范位置之外的可执行文件。
    const releaseLayout = release ? RELEASE_COMPONENT_LAYOUTS[component.id] : undefined;
    if (releaseLayout && (component.root.replaceAll("\\", "/") !== releaseLayout.root || component.entrypoint.replaceAll("\\", "/") !== releaseLayout.entrypoint)) {
      add(`manifest.component.${component.id}.layout`, "FAIL", "Release component does not use its canonical Runtime layout", {
        expected: releaseLayout,
        actual: { root: component.root, entrypoint: component.entrypoint },
      });
      continue;
    }
    byId.set(component.id, component);
    const componentRoot = resolve(runtimeRoot, component.root);
    const entrypoint = resolve(runtimeRoot, component.entrypoint);
    if (!pathIsInside(runtimeRoot, componentRoot) || !pathIsInside(runtimeRoot, entrypoint) || !pathIsInside(componentRoot, entrypoint)) {
      add(`manifest.component.${component.id}`, "FAIL", "Component path escapes its declared RuntimeRoot", { root: component.root, entrypoint: component.entrypoint });
      continue;
    }
    // 段落 3：目录与 entrypoint 必须真实存在且不是符号链接（lstat 不跟随链接，
    // 能识别出链接本体，防止"已哈希的干净路径"被链接指向别处）。
    let componentRootExists = false;
    try {
      if (existsSync(componentRoot)) {
        const details = lstatSync(componentRoot);
        componentRootExists = details.isDirectory() && !details.isSymbolicLink();
        if (!componentRootExists) add(`manifest.component.${component.id}.root`, "FAIL", "Component root must be a real directory, not a link", { path: componentRoot });
      } else add(`manifest.component.${component.id}.root`, missingLevel, "Component root is missing", { path: componentRoot });
    } catch (error) {
      add(`manifest.component.${component.id}.root`, "FAIL", "Unable to inspect component root", { path: componentRoot, cause: String(error) });
    }
    let entrypointExists = false;
    try {
      if (existsSync(entrypoint)) {
        const details = lstatSync(entrypoint);
        entrypointExists = details.isFile() && !details.isSymbolicLink();
        if (!entrypointExists) add(`manifest.component.${component.id}.entrypoint`, "FAIL", "Component entrypoint must be a real file, not a link", { path: entrypoint });
      }
    } catch (error) {
      add(`manifest.component.${component.id}.entrypoint`, "FAIL", "Unable to inspect component entrypoint", { path: entrypoint, cause: String(error) });
    }
    if (!entrypointExists) {
      add(`manifest.component.${component.id}.entrypoint`, missingLevel, "Component entrypoint is missing", { path: entrypoint });
      continue;
    }
    // 段落 5a：entrypoint SHA-256。release 必须声明合法哈希；声明了哈希就必须与
    // 磁盘实际内容一致——这是防"可执行文件被替换"的核心比对。
    const entryHash = typeof component.sha256 === "string" && /^[a-f0-9]{64}$/i.test(component.sha256) ? component.sha256 : undefined;
    const entryHashValid = entryHash !== undefined;
    if (release && !entryHashValid) add(`manifest.component.${component.id}.hash`, "FAIL", "Release component must declare a valid entrypoint SHA-256");
    else if (component.sha256 !== undefined && !entryHashValid) add(`manifest.component.${component.id}.hash`, "FAIL", "Component entrypoint SHA-256 is invalid");
    if (entryHashValid) {
      try {
        const actual = hashFile(entrypoint);
        if (actual.toLowerCase() !== entryHash.toLowerCase()) add(`manifest.component.${component.id}.hash`, "FAIL", "Component entrypoint hash mismatch", { path: entrypoint, expected: entryHash, actual });
      } catch (error) {
        add(`manifest.component.${component.id}.hash`, "FAIL", "Unable to hash component entrypoint", { path: entrypoint, cause: String(error) });
      }
    }
    // 段落 5b：整树哈希与文件数。treeSha256 覆盖组件目录内全部文件（见 hashTree），
    // fileCount 交叉验证，防止在树中增删文件而不被发现。
    const treeHashValid = typeof component.treeSha256 === "string" && /^[a-f0-9]{64}$/i.test(component.treeSha256);
    const fileCountValid = Number.isSafeInteger(component.fileCount) && (component.fileCount ?? -1) >= 1;
    if (release && (!treeHashValid || !fileCountValid)) add(`manifest.component.${component.id}.tree-metadata`, "FAIL", "Release component must declare a valid tree SHA-256 and file count");
    else {
      if (component.treeSha256 !== undefined && !treeHashValid) add(`manifest.component.${component.id}.tree-hash`, "FAIL", "Component tree SHA-256 is invalid");
      if (component.fileCount !== undefined && !fileCountValid) add(`manifest.component.${component.id}.file-count`, "FAIL", "Component file count is invalid");
    }
    if (componentRootExists && (treeHashValid || fileCountValid)) {
      try {
        const tree = hashTree(componentRoot);
        if (treeHashValid && tree.hash.toLowerCase() !== component.treeSha256!.toLowerCase()) add(`manifest.component.${component.id}.tree-hash`, "FAIL", "Component tree hash mismatch", { expected: component.treeSha256, actual: tree.hash });
        if (fileCountValid && tree.fileCount !== component.fileCount) add(`manifest.component.${component.id}.file-count`, "FAIL", "Component file count mismatch", { expected: component.fileCount, actual: tree.fileCount });
      } catch (error) {
        add(`manifest.component.${component.id}.tree-hash`, "FAIL", "Unable to hash component tree", { path: componentRoot, cause: String(error) });
      }
    }
  }

  // 段落 2b：required 依赖列表。声明的依赖必须合法、不重复且确实有对应组件。
  if (!Array.isArray(manifest.required)) add("manifest.required", "FAIL", "Runtime manifest required must be an array");
  const requiredEntries: unknown[] = Array.isArray(manifest.required) ? manifest.required : [];
  const requiredIds = new Set<string>();
  for (const required of requiredEntries) {
    const id = typeof required === "string" ? required : isRecord(required) && typeof required.id === "string" ? required.id : undefined;
    if (!id || !isSafeRuntimeId(id)) {
      add("manifest.required.invalid", "FAIL", "Required component entry is invalid");
      continue;
    }
    if (requiredIds.has(id)) add(`manifest.required.${id}`, "FAIL", "Required component id is duplicated", { id });
    requiredIds.add(id);
    if (!byId.has(id)) add(`manifest.required.${id}`, missingLevel, "Required component is not declared", { id });
  }
  // 段落 6a：release Runtime 必须包含全部基础组件且逐个标记 required——
  // 便携包不允许依赖宿主机环境兜底。
  if (release) {
    for (const required of REQUIRED_RUNTIME_COMPONENTS) {
      if (!byId.has(required)) add(`manifest.required.${required}`, "FAIL", "Release Runtime is missing a basic environment component", { id: required });
      if (!requiredIds.has(required)) add(`manifest.required.${required}`, "FAIL", "Release Runtime does not mark a basic environment component as required", { id: required });
    }
    // 段落 6b：生成的 shim 必须存在且为真实文件（非链接），用于把 PATH 上的
    // node/git/rg 转发到 Runtime 内的打包组件。
    for (const shim of ["shims/node", "shims/git", "shims/rg"]) {
      const shimPath = resolve(runtimeRoot, shim);
      try {
        const details = lstatSync(shimPath);
        if (!details.isFile() || details.isSymbolicLink()) throw new Error("shim must be a real file, not a link");
      } catch (error) {
        add(`manifest.shim.${shim.slice("shims/".length)}`, "FAIL", "Release Runtime is missing a required generated shim", { path: shimPath, cause: String(error) });
      }
    }
  }
  // 段落 6c：license 合规清单。release 必须声明且每个文件真实存在、非链接，
  // 路径同样不得逃逸包体。
  if (release && (!Array.isArray(manifest.licenses) || manifest.licenses.length === 0)) add("manifest.licenses", "FAIL", "Release manifest does not declare license files");
  else if (manifest.licenses !== undefined && !Array.isArray(manifest.licenses)) add("manifest.licenses", "FAIL", "Runtime manifest licenses must be an array");
  const licenses: unknown[] = Array.isArray(manifest.licenses) ? manifest.licenses : [];
  for (const license of licenses) {
    if (!safeManifestPath(license)) {
      add("manifest.licenses", "FAIL", "License path must be relative and cannot escape the package", { license });
      continue;
    }
    const licensePath = resolve(runtimeRoot, license);
    try {
      if (!existsSync(licensePath)) add("manifest.license.missing", missingLevel, "Declared license file is missing", { license });
      else {
        const details = lstatSync(licensePath);
        if (!details.isFile() || details.isSymbolicLink()) add("manifest.license.invalid", "FAIL", "Declared license must be a real file, not a link", { license });
      }
    } catch (error) {
      add("manifest.license.invalid", "FAIL", "Unable to inspect declared license file", { license, cause: String(error) });
    }
  }
  // 段落 6d：SBOM 必须是 SPDX-2.3 JSON 且真实存在、非链接，保证便携包的
  // 供应链构成可审计。
  if (release && !safeManifestPath(manifest.sbom)) add("manifest.sbom", "FAIL", "Release manifest does not declare a safe SPDX SBOM path");
  else if (manifest.sbom !== undefined && !safeManifestPath(manifest.sbom)) add("manifest.sbom", "FAIL", "SBOM path must be relative and cannot escape the package", { sbom: manifest.sbom });
  else if (safeManifestPath(manifest.sbom)) {
    const sbomPath = resolve(runtimeRoot, manifest.sbom);
    if (!existsSync(sbomPath)) add("manifest.sbom.missing", missingLevel, "Declared SBOM file is missing", { sbom: manifest.sbom });
    else {
      try {
        const details = lstatSync(sbomPath);
        if (!details.isFile() || details.isSymbolicLink()) throw new Error("SBOM must be a real file, not a link");
        const sbom = JSON.parse(readFileSync(sbomPath, "utf8")) as { spdxVersion?: unknown };
        if (sbom?.spdxVersion !== "SPDX-2.3") add("manifest.sbom.schema", "FAIL", "Declared SBOM is not SPDX 2.3", { sbom: manifest.sbom });
      } catch (error) {
        add("manifest.sbom.schema", "FAIL", "Declared SBOM is invalid or unreadable", { sbom: manifest.sbom, cause: String(error) });
      }
    }
  }
  // 段落 6e：sourceLock（组件来源锁定清单）必须声明 SHA-256；声明了路径时，
  // 文件须真实存在、非链接且内容哈希与声明一致，防止组件来源被悄悄替换。
  if (release && (typeof manifest.sourceLockSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(manifest.sourceLockSha256))) add("manifest.source-lock", "FAIL", "Release manifest must declare the component source lock SHA-256");
  if (manifest.sourceLock !== undefined) {
    if (!safeManifestPath(manifest.sourceLock)) add("manifest.source-lock-path", "FAIL", "Component source lock path must be relative and cannot escape RuntimeRoot");
    else {
      const sourceLockPath = resolve(runtimeRoot, manifest.sourceLock);
      try {
        const details = lstatSync(sourceLockPath);
        if (!details.isFile() || details.isSymbolicLink()) throw new Error("source lock must be a real file, not a link");
        if (typeof manifest.sourceLockSha256 === "string" && /^[a-f0-9]{64}$/i.test(manifest.sourceLockSha256)) {
          const actual = hashFile(sourceLockPath);
          if (actual.toLowerCase() !== manifest.sourceLockSha256.toLowerCase()) add("manifest.source-lock-hash", "FAIL", "Component source lock hash mismatch", { expected: manifest.sourceLockSha256, actual });
        }
      } catch (error) {
        add("manifest.source-lock-path", missingLevel, "Declared component source lock is missing or invalid", { sourceLock: manifest.sourceLock, cause: String(error) });
      }
    }
  }
  return checks;
}

/**
 * RuntimeManager -- 加载并持有当前 Runtime 的不可变快照，并提供运行期所需的
 * 二进制定位、完整性复验与自检能力。
 *
 * 实例只能通过 RuntimeManager.create 构造（构造函数私有），保证任何存活实例
 * 都已通过启动校验，或显式进入恢复模式。
 */
export class RuntimeManager {
  /** 已加载的 PosixLoom 配置（含策略、挂载表与更新设置）。 */
  readonly config: LoadedConfig;
  /** 内置命令注册表（DEFAULT_REGISTRY），创建时已通过 validate() 校验。 */
  readonly registry: NativeRegistry;
  /** 运行时路径挂载表（工作区路径 <-> Runtime 路径）。 */
  readonly mountTable: MountTable;
  /** 启动时合成的不可变运行时快照（含 snapshotId 与 manifest）。 */
  readonly snapshot: RuntimeSnapshot;
  /** 是否处于恢复模式（指针/manifest/深度校验任一异常时为 true）。 */
  readonly recoveryRequired: boolean;
  /** 恢复模式下收集的启动诊断项，doctor() 会原样透出。 */
  private readonly recoveryChecks: DoctorCheck[];
  /** 完整性脏标记：fs.watch 捕获到任何变化即置位，强制下次复验走全量验证。 */
  private integrityDirty = false;
  /** 目录监听器是否健康；为 false 时同样强制全量复验。 */
  private integrityMonitorAvailable = false;
  /** runtimeRoot 的递归目录监听器（仅 release 且非恢复模式创建）。 */
  private integrityWatcher?: FSWatcher;

  /** 私有构造：仅在 create() 完成加载与校验后调用。 */
  private constructor(config: LoadedConfig, registry: NativeRegistry, snapshot: RuntimeSnapshot, recoveryChecks: DoctorCheck[], recoveryRequired: boolean) {
    this.config = config;
    this.registry = registry;
    this.mountTable = new MountTable(config.runtime.mounts);
    this.snapshot = snapshot;
    this.recoveryChecks = recoveryChecks;
    this.recoveryRequired = recoveryRequired;
    // fs.watch 完整性监听：release 且未损坏时对 runtimeRoot 做递归目录监听，
    // 任何变化置脏标记；监听出错则视为不可用并置脏（退化为每次全量复验）；
    // watcher unref 保证不阻止进程退出。恢复模式下不启用--运行时本就不可信。
    if (snapshot.manifest.mode === "release" && !recoveryRequired) {
      try {
        this.integrityWatcher = watch(snapshot.runtimeRoot, { recursive: process.platform === "win32" }, () => { this.integrityDirty = true; });
        this.integrityWatcher.on("error", () => { this.integrityMonitorAvailable = false; this.integrityDirty = true; });
        this.integrityWatcher.unref();
        this.integrityMonitorAvailable = true;
      } catch {
        this.integrityDirty = true;
      }
    }
  }

  /**
   * 加载并校验当前 Runtime，构造 RuntimeManager 实例。
   *
   * 流程：loadConfig -> 校验内置注册表 -> 读取 manifest.json -> 校验 manifest
   * 与指针身份一致 -> validateRuntimeManifest 深度校验 -> 合成 snapshotId ->
   * 构造实例（release 且未损坏时附加目录监听）。
   *
   * 错误码（严格模式下直接抛出；options.allowInvalidRuntime 为 true 时改为
   * 收集到 recoveryChecks 并进入恢复模式，供 posixloom doctor 等诊断场景）：
   * - REGISTRY_INVALID：内置注册表条目非法（来自 registry.validate()）；
   * - RUNTIME_ID_INVALID：指针指向的 runtimeId 不合法；
   * - MANIFEST_INVALID：manifest 无法解析或不是 JSON 对象；
   * - RUNTIME_MANIFEST_MISSING：非开发源却找不到 manifest；
   * - RUNTIME_MODE_MISMATCH：manifest 模式与来源（development/release）不符；
   * - RUNTIME_ID_MISMATCH：runtime/current 指针与 manifest.runtimeId 不一致；
   * - RUNTIME_VALIDATION_FAILED：深度校验存在 FAIL 项。
   *
   * @param runRoot PosixLoom 根目录（配置与 runtime/current 指针所在处）
   * @param options.allowInvalidRuntime 允许坏 manifest/坏指针启动（诊断与恢复用）
   * @returns 校验通过的 RuntimeManager 实例（或恢复模式实例）
   */
  static async create(runRoot: string, options: { allowInvalidRuntime?: boolean } = {}): Promise<RuntimeManager> {
    const config = await loadConfig(runRoot, { allowInvalidRuntimePointer: options.allowInvalidRuntime });
    const registry = new NativeRegistry(DEFAULT_REGISTRY);
    registry.validate();
    const runtimeId = config.runtimeId;
    const runtimeRoot = config.runtimeRoot;
    if (!isSafeRuntimeId(runtimeId)) throw new PosixLoomError("RUNTIME_ID_INVALID", `Invalid runtime id: ${runtimeId}`, { runtimeId });
    // 读取 manifest.json：解析失败在严格模式下直接抛出；恢复模式记录诊断并继续。
    const manifestPath = join(runtimeRoot, "manifest.json");
    const recoveryChecks: DoctorCheck[] = [];
    let parsedManifest: RuntimeManifest | undefined;
    let manifestReadIssue = false;
    try {
      const parsed = readJsonSafe<unknown>(manifestPath);
      if (parsed !== undefined) {
        if (!isRecord(parsed)) throw new PosixLoomError("MANIFEST_INVALID", `Runtime manifest must be a JSON object: ${manifestPath}`, { manifestPath });
        parsedManifest = parsed as unknown as RuntimeManifest;
      }
    } catch (error) {
      if (!options.allowInvalidRuntime) throw error;
      manifestReadIssue = true;
      recoveryChecks.push({ id: "runtime.manifest-read", level: "FAIL", message: "Runtime manifest could not be read; recovery fallback is active", details: { manifestPath, cause: String(error) } });
    }
    // 开发源允许没有 manifest；其他来源缺 manifest 属致命错误（或恢复诊断项）。
    if (!parsedManifest && config.runtimeSource !== "development") {
      if (!options.allowInvalidRuntime) throw new PosixLoomError("RUNTIME_MANIFEST_MISSING", `Selected Runtime has no manifest: ${manifestPath}`, { runtimeId, manifestPath, source: config.runtimeSource });
      if (!manifestReadIssue) recoveryChecks.push({ id: "runtime.manifest-read", level: "FAIL", message: "Selected Runtime has no manifest; recovery fallback is active", details: { runtimeId, manifestPath, source: config.runtimeSource } });
    }
    // fallback manifest：仅恢复模式或开发源缺 manifest 时使用，让诊断流程能
    // 继续跑完；release 源会因后续深度校验失败被标记为 recoveryRequired。
    const manifest: RuntimeManifest = parsedManifest ?? {
      manifestVersion: 1,
      runtimeId,
      runtimeSemver: config.runtimeSource === "development" ? "0.1.0-dev" : "0.0.0-invalid",
      mode: config.runtimeSource === "development" ? "development" : "release",
      required: [],
      notes: "Fallback manifest used for runtime recovery diagnostics",
    };
    // manifest 模式必须与来源一致：开发源必须 development，打包源必须 release，
    // 防止用宽松的 development manifest 冒充经过哈希审计的 release 运行时。
    const expectedMode = config.runtimeSource === "development" ? "development" : "release";
    if (manifest.mode !== expectedMode && !options.allowInvalidRuntime) {
      throw new PosixLoomError("RUNTIME_MODE_MISMATCH", "Selected Runtime manifest mode does not match its source", {
        runtimeId,
        source: config.runtimeSource,
        expected: expectedMode,
        actual: manifest.mode,
      });
    }
    // 指针身份一致性：runtime/current 指向的 runtimeId 必须与 manifest 内声明的
    // 一致，防止目录内容被整体替换为另一个 Runtime 而不被察觉。
    if (manifest.runtimeId !== runtimeId && !options.allowInvalidRuntime) {
      throw new PosixLoomError("RUNTIME_ID_MISMATCH", "runtime/current does not match manifest runtimeId", { pointer: runtimeId, manifest: manifest.runtimeId });
    }
    if (manifest.runtimeId !== runtimeId && options.allowInvalidRuntime) {
      recoveryChecks.push({ id: "runtime.identity", level: "FAIL", message: "Runtime pointer does not match manifest runtimeId", details: { pointer: runtimeId, manifest: manifest.runtimeId } });
    }
    const startupChecks = validateRuntimeManifest(manifest, runtimeRoot);
    const failures = startupChecks.filter((check) => check.level === "FAIL");
    if (failures.length && !options.allowInvalidRuntime) {
      throw new PosixLoomError("RUNTIME_VALIDATION_FAILED", "Selected Runtime failed startup validation", { runtimeId, failures });
    }
    // 四路内容哈希合成 snapshotId：runtimeId + manifest 哈希 + 注册表哈希 +
    // 挂载表哈希 + 策略哈希。任一路变化都会改变快照身份，供会话与状态上报
    // 判断运行环境是否漂移；快照一经构造即不可变。
    const mountsHash = hashText(JSON.stringify(config.runtime.mounts));
    const policyHash = hashText(JSON.stringify(config.runtime.policy));
    const registryHash = registry.hash();
    const runtimeManifestHash = hashText(JSON.stringify(manifest));
    const snapshotId = hashText(JSON.stringify({ runtimeId, runtimeManifestHash, registryHash, mountsHash, policyHash }));
    const snapshot: RuntimeSnapshot = {
      snapshotId,
      runtimeId,
      runtimeRoot: resolve(runtimeRoot),
      runtimeManifestHash,
      registryHash,
      mountsHash,
      policyHash,
      manifest,
      source: config.runtimeSource,
    };
    // 任一启动异常（指针问题、manifest 读取失败、深度校验失败、身份或模式
    // 不一致）都会把实例标记为恢复模式：诊断信息仍可输出，但运行时不再被信任。
    const recoveryRequired = config.runtimePointerIssues.length > 0
      || recoveryChecks.length > 0
      || failures.length > 0
      || manifest.runtimeId !== runtimeId
      || manifest.mode !== expectedMode;
    return new RuntimeManager(config, registry, snapshot, recoveryChecks, recoveryRequired);
  }

  /**
   * 定位 bash 可执行文件，返回第一个实际存在的候选。
   *
   * release 模式：只认 Runtime 内打包的 MSYS2 bash（msys/usr/bin/bash.exe），
   *   绝不回落到宿主机，保证命令执行环境可复现且受哈希校验保护。
   * development 模式候选链（按优先级）：
   *   1. 环境变量 POSIXLOOM_BASH（开发者显式指定）；
   *   2. Runtime 内打包的 msys bash；
   *   3. Windows 下从 PATH 上的 git.exe 推导 Git for Windows 自带 bash
   *      （deriveGitBashCandidates）；
   *   4. PATH 上的 bash，但排除 \Windows\System32\bash.exe--那是 WSL 的入口，
   *      启动的是 Linux 子系统内的 bash，与便携 POSIX 运行时语义不符。
   *
   * @returns 第一个存在的候选绝对路径；全部缺失时返回 undefined
   */
  findBash(): HostPath | undefined {
    const packaged = [
      join(this.snapshot.runtimeRoot, "msys", "usr", "bin", "bash.exe"),
      join(this.snapshot.runtimeRoot, "msys", "usr", "bin", "bash"),
    ];
    const candidates = this.snapshot.manifest.mode === "release"
      ? packaged
      : [
        process.env.POSIXLOOM_BASH,
        ...packaged,
        ...(process.platform === "win32" ? deriveGitBashCandidates(findAllOnPath("git.exe")) : []),
        ...findAllOnPath(process.platform === "win32" ? "bash.exe" : "bash")
          .filter((candidate) => !/\\Windows\\System32\\bash\.exe$/i.test(candidate)),
      ].filter((candidate): candidate is string => Boolean(candidate));
    // 候选按优先级排列，返回第一个实际存在的路径。
    return candidates.find((candidate) => existsSync(candidate));
  }

  /**
   * 定位 Rust 原生宿主（posixloom-host）二进制。
   *
   * 基础候选：Runtime 内 native/posixloom-host/ 下的 posixloom(.exe)/posixloom-host(.exe)，
   * 以及 runRoot 下的 launcher 副本。development 模式额外探测 cargo 的
   * target/debug 与 target/release 构建产物，以及 POSIXLOOM_NATIVE_HOST 显式
   * 指定的路径。
   *
   * @returns 第一个存在的候选路径；全部缺失时返回 undefined（上层回落到 Node 进程模式）
   */
  findNativeHost(): HostPath | undefined {
    const names = process.platform === "win32" ? ["posixloom.exe", "posixloom-host.exe"] : ["posixloom", "posixloom-host"];
    const runtimeHosts = names.map((name) => join(this.snapshot.runtimeRoot, "native", "posixloom-host", name));
    const launcherHosts = names.map((name) => join(this.config.runRoot, name));
    // 恢复模式下优先 launcher 副本（Runtime 本身已不可信，launcher 是与当前
    // 进程一同分发的副本）；正常模式优先 Runtime 内经哈希校验的版本。
    const packaged = this.recoveryRequired ? [...launcherHosts, ...runtimeHosts] : [...runtimeHosts, ...launcherHosts];
    const candidates = this.snapshot.manifest.mode === "release"
      ? packaged
      : [
      ...packaged,
      ...names.map((name) => join(this.config.runRoot, "native", "posixloom-host", "target", "debug", name)),
      ...names.map((name) => join(this.config.runRoot, "native", "posixloom-host", "target", "release", name)),
      process.env.POSIXLOOM_NATIVE_HOST ?? "",
      ];
    for (const relativePath of candidates) {
      if (relativePath && existsSync(relativePath)) return relativePath;
    }
    return undefined;
  }

  /**
   * 在命令执行边界复验 release 运行时完整性。
   *
   * 仅 release 模式生效（development 运行时本就不承诺哈希审计）。策略：
   * - 目录监听健康且无脏标记 -> 直接跳过（快路径，避免每条命令都全量哈希）；
   * - 否则重跑 validateRuntimeManifest，存在 FAIL 项即抛
   *   RUNTIME_INTEGRITY_CHANGED，阻止后续命令继续在已被篡改的运行时上执行。
   *
   * post-command 阶段且监听可用时额外等待 25ms：给文件系统（含 Windows 上
   * 递归 watch 的异步事件）留出发送变更事件的时间，缩小"命令刚改完文件、
   * 事件尚未送达"的漏检窗口；其余情况只需让出一次事件循环。
   *
   * @param stage 调用时机：命令执行前（pre-command，默认）或执行后（post-command）
   * @throws PosixLoomError RUNTIME_INTEGRITY_CHANGED 复验发现 FAIL 项时抛出
   */
  async assertRuntimeIntegrity(stage: "pre-command" | "post-command" = "pre-command"): Promise<void> {
    if (this.snapshot.manifest.mode !== "release") return;
    if (stage === "post-command" && this.integrityMonitorAvailable) {
      // post-command：等待 25ms 让 watch 事件送达，再判断是否有变化。
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    } else {
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    }
    // 快路径：监听器健康且期间无任何变化事件，无需重复全量哈希。
    if (this.integrityMonitorAvailable && !this.integrityDirty) return;
    // 慢路径：监听不可用或已捕获到变化，重跑完整 manifest 验证。
    const failures = validateRuntimeManifest(this.snapshot.manifest, this.snapshot.runtimeRoot).filter((check) => check.level === "FAIL");
    if (failures.length > 0) {
      throw new PosixLoomError("RUNTIME_INTEGRITY_CHANGED", `Release Runtime failed the ${stage} integrity check`, {
        runtimeId: this.snapshot.runtimeId,
        stage,
        failures,
      });
    }
    // 复验通过后清除脏标记，恢复快路径。
    this.integrityDirty = false;
  }

  /** 关闭目录监听器并标记监听不可用（后续完整性检查将退化为全量复验）。 */
  dispose(): void {
    this.integrityWatcher?.close();
    this.integrityWatcher = undefined;
    this.integrityMonitorAvailable = false;
  }

  /**
   * 生成 Runtime 自检报告（posixloom doctor 的核心数据源）。
   *
   * 覆盖十余项检查：指针状态与恢复诊断、manifest 模式与深度校验、workspace、
   * bash（是否为打包版本）、git/rg/node（release 必须来自 Runtime，dev 允许
   * PATH 或当前进程兜底）、原生宿主、挂载表、默认策略 profile、更新配置
   * （release 且启用更新时必须强制签名校验）等。
   *
   * @returns DoctorReport：ok 为 true 当且仅当不存在任何 FAIL 级别检查项
   */
  doctor(): DoctorReport {
    const checks: DoctorCheck[] = [];
    const add = (id: string, level: DoctorCheck["level"], message: string, details?: Record<string, unknown>) => checks.push({ id, level, message, details });
    if (this.config.runtimePointerIssues.length > 0) {
      add("runtime.pointer", "FAIL", "One or more Runtime pointers are invalid; recovery fallback is active", { issues: this.config.runtimePointerIssues });
    }
    checks.push(...this.recoveryChecks);
    const expectedMode = this.snapshot.source === "development" ? "development" : "release";
    if (this.snapshot.manifest.mode !== expectedMode) {
      add("runtime.selection-mode", "FAIL", "Runtime manifest mode does not match the selected source", {
        source: this.snapshot.source,
        expected: expectedMode,
        actual: this.snapshot.manifest.mode,
      });
    }
    const runtimeCurrent = this.snapshot.source === "data"
      ? join(this.config.dataRoot, "runtime", "current")
      : join(this.config.runRoot, "runtime", "current");
    if (existsSync(runtimeCurrent)) add("runtime.current", "PASS", `runtime/current → ${this.snapshot.runtimeId}`);
    else add("runtime.current", "WARN", "runtime/current missing; development fallback is active");
    const manifestPath = join(this.snapshot.runtimeRoot, "manifest.json");
    // manifest 存在且启动时未被判定为不可读时，才重新做深度校验，
    // 避免与 recoveryChecks 中的读取失败诊断重复报告。
    if (existsSync(manifestPath) && !this.recoveryChecks.some((check) => check.id === "runtime.manifest-read")) {
      const manifestChecks = validateRuntimeManifest(this.snapshot.manifest, this.snapshot.runtimeRoot);
      if (manifestChecks.length === 0) add("runtime.manifest", "PASS", "Runtime manifest found and validated", { path: manifestPath });
      else checks.push(...manifestChecks);
    } else if (!existsSync(manifestPath)) add("runtime.manifest", this.snapshot.manifest.mode === "release" ? "FAIL" : "WARN", "Packaged manifest missing", { path: manifestPath });
    if (existsSync(this.config.workspace)) add("workspace", "PASS", "Workspace exists", { path: this.config.workspace });
    else add("workspace", "FAIL", "Workspace does not exist", { path: this.config.workspace });
    const bash = this.findBash();
    if (bash) {
      const packagedRoot = `${resolve(join(this.snapshot.runtimeRoot, "msys")).toLowerCase()}${sep}`;
      const packaged = resolve(bash).toLowerCase().startsWith(packagedRoot);
      add("bash", packaged || this.snapshot.manifest.mode === "release" ? "PASS" : "WARN", packaged ? "Packaged Bash found" : "External Bash found; development fallback is active", { path: bash });
    }
    else add("bash", "FAIL", "Bash not found; set POSIXLOOM_BASH or install the packaged MSYS2 runtime");
    // release 模式下 git/rg/node 必须来自 Runtime 内的打包组件；
    // dev 模式允许 PATH 兜底（node 直接用当前进程）。
    const packagedNative: Record<string, string> = {
      git: join(this.snapshot.runtimeRoot, "native", "mingit", "cmd", process.platform === "win32" ? "git.exe" : "git"),
      rg: join(this.snapshot.runtimeRoot, "native", "rg", process.platform === "win32" ? "rg.exe" : "rg"),
      node: join(this.snapshot.runtimeRoot, "node", process.platform === "win32" ? "node.exe" : "node"),
    };
    for (const command of ["git", "rg", "node"]) {
      const path = this.snapshot.manifest.mode === "release"
        ? (existsSync(packagedNative[command]) ? packagedNative[command] : undefined)
        : command === "node" ? process.execPath : findOnPath(process.platform === "win32" ? `${command}.exe` : command);
      if (path) add(`native.${command}`, this.snapshot.manifest.mode === "release" ? "PASS" : "WARN", this.snapshot.manifest.mode === "release" ? `${command} found in Runtime` : `${command} found via development fallback`, { path });
      else add(`native.${command}`, this.snapshot.manifest.mode === "release" ? "FAIL" : "WARN", `${command} is not available in the selected Runtime`);
    }
    const nativeHost = this.findNativeHost();
    if (nativeHost) add("native-host", "PASS", "Native Host found", { path: nativeHost });
    else add("native-host", this.snapshot.manifest.mode === "release" ? "FAIL" : "WARN", this.snapshot.manifest.mode === "release" ? "Release Native Host is missing" : "Native Host not built; Node process fallback will be used");
    add("mounts", "PASS", "Mount table loaded", { mounts: this.mountTable.entries });
    const profile = this.config.runtime.policy.profiles[this.config.runtime.policy.defaultProfile];
    add("policy", profile ? "PASS" : "FAIL", profile ? `Default policy: ${this.config.runtime.policy.defaultProfile} (${profile.mode})` : "Default policy profile is missing");
    // 非 dev 来源（或 release manifest）启用更新时必须强制签名校验，
    // 否则更新通道本身会成为运行时的篡改入口。
    if ((this.snapshot.source !== "development" || this.snapshot.manifest.mode === "release") && this.config.runtime.updates.enabled && !this.config.runtime.updates.requireSignature) {
      add("updates.signature", "FAIL", "Release Runtime update signature verification cannot be disabled");
    }
    add("updates", this.config.runtime.updates.enabled && !this.config.runtime.updates.feedUrl ? "WARN" : "PASS", this.config.runtime.updates.enabled
      ? this.config.runtime.updates.feedUrl ? `Automatic updates enabled (${this.config.runtime.updates.channel})` : "Automatic updates enabled but feedUrl is not configured"
      : "Automatic updates disabled");
    return { ok: checks.every((check) => check.level !== "FAIL"), checks };
  }
}

/**
 * BOM 容错的 JSON 文件读取。
 *
 * Windows 工具（PowerShell 等）常在文件头写入 U+FEFF，直接 JSON.parse 会失败，
 * 因此读取后先剥离 BOM 再解析。文件不存在（ENOENT）返回 undefined；其余读取或
 * 解析错误统一抛 MANIFEST_INVALID。
 *
 * @param path JSON 文件路径
 * @returns 解析结果；文件不存在时为 undefined
 * @throws PosixLoomError MANIFEST_INVALID 文件无法读取或内容不是合法 JSON 时抛出
 */
export function readJsonSafe<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw new PosixLoomError("MANIFEST_INVALID", `Unable to parse runtime manifest: ${path}`, { path, cause: String(error) });
  }
}
