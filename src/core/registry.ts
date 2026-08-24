/**
 * 原生命令注册表（Native Fast Path）。
 *
 * 职责：
 * 1. 声明哪些命令可以绕过 MSYS2 bash，直接以 Windows 原生进程执行（backend = "native"）；
 * 2. 在命令行参数层面完成 POSIX 风格虚拟路径 -> Windows 宿主路径的翻译（参数级路径翻译）；
 * 3. 为每个被翻译的参数生成 PathDecision 决策记录，供策略校验与执行追踪使用。
 *
 * 设计意图：
 * - 为什么只有 git / rg / node 三个原生命令：这三者随运行时以受管组件形式分发
 *   （位于 $RUNTIME_ROOT 之下，受运行时清单与哈希校验保护），且对 POSIX shell
 *   环境（管道、glob 展开、shell 变量等）没有硬依赖，脱离 bash 单独执行的
 *   行为与在 shell 中等价（git/rg 因此标记 shellEquivalent: true）。其余命令
 *   统一回退 MSYS2 后端，以保证完整 POSIX 兼容性。
 * - 为什么做参数级路径翻译：MSYS2 bash 在启动子进程时会自动把 POSIX 风格路径
 *   转换成 Windows 路径，而原生进程不会做这种转换。若把 /workspace/... 这类
 *   虚拟路径直接交给原生进程，路径将无法解析。因此在 argv 层把以 "/" 开头的
 *   token 翻译为宿主路径，翻译过程同时接受策略门（PolicyGate）校验。
 * - 为什么 release 模式找不到可执行文件即判 miss（fail-closed，不回退 PATH 查找）：
 *   release 运行时的组件都是经过供应链校验的（来源锁定 / 哈希），而 PATH 上的
 *   同名可执行文件来源不可控。宁可让命令回退 MSYS2，也不执行未经校验的二进制；
 *   development 模式允许回退 PATH，便于本机开发调试。
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PosixLoomError } from "./errors.js";
import { findOnPath } from "./executable.js";
import { MountTable, translatePathToken } from "./path.js";
import { PolicyGate } from "./policy.js";
import type { HostPath, NativeCommandDescriptor, PathDecision, PathIntent, RuntimeSnapshot } from "./types.js";

/** 适配器统一返回结构：翻译改写后的 argv，以及逐参数记录的路径翻译决策（PathDecision）。 */
export interface AdapterResult {
  argv: string[];
  decisions: PathDecision[];
}

/** A pluggable argv adapter used by one or more native command descriptors. */
export interface NativeCommandAdapter {
  id: string;
  adapt(argv: string[], table: MountTable, gate: PolicyGate): AdapterResult;
}

/**
 * 把描述符的 executable 引用解析为实际存在的宿主可执行文件路径。
 *
 * 解析规则：
 * - node 优先使用运行时自带的 node 可执行文件（runtimeRoot/node）；release 模式下
 *   缺失即返回 undefined（fail-closed），development 模式回退到当前宿主进程自身
 *   （process.execPath，即运行 PosixLoom 的那个 node）；
 * - 其他命令把 "$RUNTIME_ROOT/" 前缀展开为 snapshot.runtimeRoot 下的实际路径；
 * - release 模式下任何未命中都返回 undefined（绝不回退 PATH 查找，避免执行未经
 *   供应链校验的外部二进制）；development 模式允许回退到 PATH。
 *
 * 返回 undefined 表示该原生命令当前不可用，调用方（NativeRegistry.resolve）据此
 * 判定 miss，让命令回退 MSYS2 后端。
 */
function resolveExecutable(descriptor: NativeCommandDescriptor, snapshot: RuntimeSnapshot): HostPath | undefined {
  if (descriptor.name === "node") {
    const packaged = join(snapshot.runtimeRoot, "node", process.platform === "win32" ? "node.exe" : "node");
    if (existsSync(packaged)) return packaged;
    if (snapshot.manifest.mode === "release") return undefined;
    return process.execPath;
  }
  if (descriptor.executable.startsWith("$RUNTIME_ROOT/")) {
    const candidate = join(snapshot.runtimeRoot, descriptor.executable.slice("$RUNTIME_ROOT/".length));
    if (existsSync(candidate)) return candidate;
  }
  // Trusted embedding plugins may point at an explicit host executable. Release
  // policy still rejects paths outside RuntimeRoot in PolicyGate.assertExecutable.
  if (isAbsolute(descriptor.executable) && existsSync(descriptor.executable)) return descriptor.executable;
  if (snapshot.manifest.mode === "release") return undefined;
  return findOnPath(descriptor.name);
}

/**
 * 计算指定意图下允许访问的宿主根目录列表。
 * 受信任（trusted）策略返回 undefined，表示跳过物理路径校验；
 * 守卫策略返回该意图允许访问的挂载点宿主路径（供 physicalCheck 使用）。
 */
function roots(gate: PolicyGate, intent: PathIntent): HostPath[] | undefined {
  return gate.trusted ? undefined : gate.allowedHostRoots(intent);
}

/**
 * 构造传给 translatePathToken 的宿主路径断言闭包：
 * 受信任策略下为空操作，守卫策略下委托 gate.assertPath 做路径策略校验。
 */
function check(gate: PolicyGate): (hostPath: HostPath, intent: PathIntent) => void {
  return (hostPath, intent) => gate.assertPath(hostPath, intent);
}

/**
 * ripgrep 适配器：区分 pattern 位置参数与路径位置参数，只翻译以 "/" 开头的路径 token。
 *
 * 解析规则：
 * - valueOptions：会"吞掉"下一个 token 作为值的选项集合（上下文行数 -A/-B/-C、
 *   glob -g、线程数 -j、--encoding 等），这些值不可能是路径，原样跳过；
 * - pathValueOptions（-f/--file/--ignore-file）：值是路径，需要翻译；
 *   其中 -f/--file 同时意味着 pattern 已由该文件提供（rg 从文件读取 pattern）；
 * - pattern 判定：--files（pathOnlyMode）模式下只有路径、没有 pattern；
 *   -e/--regexp（含 -epat、--regexp=pat 组合形式）显式给出 pattern；
 *   否则第一个非选项位置参数视为 pattern，其后所有位置参数才按路径翻译；
 * - "--" 之后的 token 一律按路径处理。
 *
 * 返回的 decisions 记录每个被翻译参数的位置、类型、意图与校验结果，
 * 会进入执行计划（ResolutionTemplate / NativeExecutionPlan 的 pathDecisions）供审计。
 */
function rgAdapter(argv: string[], table: MountTable, gate: PolicyGate): AdapterResult {
  const output = [...argv];
  const decisions: PathDecision[] = [];
  // 会"吞掉"下一个 token 作为值的选项集合（上下文行数、glob、线程数、编码等），这些值不是路径。
  const valueOptions = new Set([
    "-A", "--after-context", "-B", "--before-context", "-C", "--context", "-E", "--encoding", "-M", "--max-columns", "-m", "--max-count",
    "--max-depth", "--max-filesize", "--path-separator", "--pre", "--pre-glob", "--regex-size-limit", "--sort", "--sortr", "--type-add", "--type-clear",
    "-g", "--glob", "-j", "--threads", "-r", "--replace", "-t", "--type", "-T", "--type-not",
  ]);
  // 值为路径的选项（pattern 来源文件 / 忽略规则文件），其值需要做路径翻译。
  const pathValueOptions = new Set(["-f", "--file", "--ignore-file"]);
  let explicitPattern = false;
  let positionalPatternSeen = false;
  let pathOnlyMode = false;
  let afterSeparator = false;
  // 通用翻译闭包：把 output[index] 处的 token 翻译为宿主路径并记录决策。
  const translate = (index: number): void => {
    const token = output[index];
    // 路径判定：必须以 "/" 开头，且要么命中某个挂载点、要么形如 "/c/..." 的盘符路径；否则不是路径，跳过。
    if (!token?.startsWith("/") || (!table.findMount(token) && !/^\/[A-Za-z](?:\/|$)/.test(token))) return;
    const translated = translatePathToken(token, table, "path-scalar", "read", index, roots(gate, "read"), check(gate));
    output[index] = translated.token;
    decisions.push(translated.decision);
  };
  // 选项解析主循环：先识别控制 token（--、--files、显式 pattern），再区分选项值与位置参数。
  for (let index = 1; index < output.length; index += 1) {
    const token = output[index];
    // "--" 分隔符：其后的 token 全部按路径处理，不再解析选项。
    if (!afterSeparator && token === "--") { afterSeparator = true; continue; }
    if (!afterSeparator && token === "--files") { pathOnlyMode = true; continue; }
    if (!afterSeparator && (token === "-e" || token === "--regexp")) { explicitPattern = true; index += 1; continue; }
    if (!afterSeparator && pathValueOptions.has(token)) { explicitPattern ||= token === "-f" || token === "--file"; translate(index + 1); index += 1; continue; }
    // --file=PATH / --ignore-file=PATH 等号形式：值为 "/" 开头时翻译并重新拼回选项。
    const pathEquals = !afterSeparator ? token.match(/^(--file|--ignore-file)=(.*)$/) : undefined;
    if (pathEquals) {
      explicitPattern ||= pathEquals[1] === "--file";
      if (pathEquals[2].startsWith("/")) {
        const translated = translatePathToken(pathEquals[2], table, "path-scalar", "read", index, roots(gate, "read"), check(gate));
        output[index] = `${pathEquals[1]}=${translated.token}`;
        decisions.push(translated.decision);
      }
      continue;
    }
    if (!afterSeparator && ((token.startsWith("-e") && token !== "-e") || token.startsWith("--regexp="))) { explicitPattern = true; continue; }
    // -fPATH 组合形式：pattern 已由文件提供；仅当内嵌值以 "/" 开头时才翻译。
    if (!afterSeparator && token.startsWith("-f") && token !== "-f") {
      explicitPattern = true;
      const original = token.slice(2);
      if (original.startsWith("/")) {
        const translated = translatePathToken(original, table, "path-scalar", "read", index, roots(gate, "read"), check(gate));
        output[index] = `-f${translated.token}`;
        decisions.push(translated.decision);
      }
      continue;
    }
    if (!afterSeparator && valueOptions.has(token)) { index += 1; continue; }
    if (!afterSeparator && token.startsWith("-")) continue;
    // 未显式提供 pattern 时，第一个位置参数是 pattern（不是路径）；其后的位置参数才按路径翻译。
    if (!pathOnlyMode && !explicitPattern && !positionalPatternSeen) { positionalPatternSeen = true; continue; }
    translate(index);
  }
  return { argv: output, decisions };
}

/**
 * node 适配器：翻译预加载模块路径与真正的脚本入口。
 * 脚本入口不一定是 argv[1]（例如 `node --inspect /workspace/app.js`），因此需要
 * 跳过 Node 选项及其值，直到找到第一个位置参数；入口之后的 token 都是脚本参数，
 * 即使以 `/` 开头也必须原样保留。`-e` / `-p` 直接提供代码，不再寻找脚本入口。
 */
function nodeAdapter(argv: string[], table: MountTable, gate: PolicyGate): AdapterResult {
  const output = [...argv];
  const decisions: PathDecision[] = [];
  const moduleOptions = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
  const inlineCodeOptions = new Set(["-e", "--eval", "-p", "--print"]);
  let afterSeparator = false;
  let entrypointSeen = false;

  const translate = (index: number, intent: PathIntent): void => {
    const token = output[index];
    if (!token?.startsWith("/")) return;
    const translated = translatePathToken(token, table, "path-scalar", intent, index, roots(gate, intent), check(gate));
    output[index] = translated.token;
    decisions.push(translated.decision);
  };

  for (let index = 1; index < output.length; index += 1) {
    const token = output[index];
    if (entrypointSeen) continue;
    if (!afterSeparator && token === "--") { afterSeparator = true; continue; }
    if (!afterSeparator && index === 1 && token === "inspect") continue;

    // 预加载模块选项允许独立值、长选项等号形式和 -rPATH 组合形式。
    if (!afterSeparator && moduleOptions.has(token)) {
      translate(index + 1, "read");
      index += 1;
      continue;
    }
    const moduleEquals = !afterSeparator ? token.match(/^(--require|--import|--loader|--experimental-loader)=(.*)$/) : undefined;
    if (moduleEquals?.[2]?.startsWith("/")) {
      const translated = translatePathToken(moduleEquals[2], table, "path-scalar", "read", index, roots(gate, "read"), check(gate));
      output[index] = `${moduleEquals[1]}=${translated.token}`;
      decisions.push(translated.decision);
      continue;
    }
    if (!afterSeparator && token.startsWith("-r") && token !== "-r") {
      const modulePath = token.slice(2);
      if (modulePath.startsWith("/")) {
        const translated = translatePathToken(modulePath, table, "path-scalar", "read", index, roots(gate, "read"), check(gate));
        output[index] = `-r${translated.token}`;
        decisions.push(translated.decision);
      }
      continue;
    }

    // eval/print 的下一个 token 是代码而不是脚本路径；组合形式同样终止入口搜索。
    if (!afterSeparator && inlineCodeOptions.has(token)) {
      entrypointSeen = true;
      index += 1;
      continue;
    }
    if (!afterSeparator && (/^-(?:e|p).+/.test(token) || /^--(?:eval|print|run)=/.test(token))) {
      entrypointSeen = true;
      continue;
    }
    if (!afterSeparator && token === "-") { entrypointSeen = true; continue; }
    if (!afterSeparator && token.startsWith("-")) continue;

    // 第一个非选项 token 是脚本入口（相对入口无需翻译，但仍会结束入口搜索）。
    translate(index, "execute");
    entrypointSeen = true;
  }
  return { argv: output, decisions };
}

/**
 * 定位 git 子命令在 argv 中的位置（如 "git -C /x status" 中的 "status"）。
 * 需要跳过子命令之前的全局选项：先跳过消耗独立值的全局选项（-C/-c/--git-dir 等，
 * 连同其值一起），再跳过组合 / 等号形式（-Cdir、--git-dir=x），最后跳过其他
 * 短横线开头的 token。找不到子命令时返回 -1。
 */
function gitSubcommandIndex(argv: string[]): number {
  const valueOptions = new Set(["-C", "-c", "--config-env", "--exec-path", "--git-dir", "--namespace", "--super-prefix", "--work-tree"]);
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (valueOptions.has(token)) { index += 1; continue; }
    if (/^(?:-C|-c).+/.test(token) || /^--(?:config-env|exec-path|git-dir|namespace|super-prefix|work-tree)=/.test(token)) continue;
    if (token.startsWith("-")) continue;
    return index;
  }
  return -1;
}

/**
 * 定位 "git init" 的目标目录位置参数。
 * 跳过 init 自身消耗值的选项（--template/--separate-git-dir/-b 等）与 "--" 分隔符，
 * 取最后一个非选项位置参数作为目标目录；未显式给出目录时返回 -1
 * （表示在当前目录初始化，无需翻译）。
 */
function gitInitDestinationIndex(argv: string[], subcommandIndex: number): number {
  const valueOptions = new Set(["--template", "--separate-git-dir", "--object-format", "--ref-format", "-b", "--initial-branch"]);
  let afterSeparator = false;
  let destination = -1;
  for (let index = subcommandIndex + 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!afterSeparator && token === "--") { afterSeparator = true; continue; }
    if (!afterSeparator && valueOptions.has(token)) { index += 1; continue; }
    if (!afterSeparator && token.startsWith("-")) continue;
    destination = index;
  }
  return destination;
}

/**
 * git 适配器：翻译 git 命令行中的路径参数。
 *
 * 识别的参数形态（同一选项同时支持独立参数、组合形式、等号形式三种写法）：
 * - -C / --git-dir / --work-tree / --separate-git-dir / --template 的值：
 *   一般按 read 意图翻译；--separate-git-dir 在 init 子命令下按 create 意图，
 *   因为该目录将被新建为从属仓库；
 * - "git init <dir>" 的目标目录位置参数：按 create 意图翻译（目录将被创建）；
 * - "--" 之后的 token 视为 pathspec（kind 为 "pathspec"、read 意图），
 *   但跳过 ":(!...)" 等 magic pathspec -- 它们属于 pathspec 语法而非路径字面量。
 *
 * 返回的 decisions 与 rgAdapter 相同，逐参数记录翻译决策供审计。
 */
function gitAdapter(argv: string[], table: MountTable, gate: PolicyGate): AdapterResult {
  const output = [...argv];
  const decisions: PathDecision[] = [];
  const subcommandIndex = gitSubcommandIndex(argv);
  const subcommand = argv[subcommandIndex];
  const initDestination = subcommand === "init" ? gitInitDestinationIndex(argv, subcommandIndex) : -1;
  let afterDoubleDash = false;
  // 逐 token 解析：先处理五种路径选项（独立参数 / -Cdir 组合 / --opt=val 等号），再处理 init 目标与 pathspec。
  for (let index = 1; index < output.length; index += 1) {
    const token = output[index];
    // "--" 分隔符：之后的 token 一律按 pathspec 处理。
    if (token === "--") { afterDoubleDash = true; continue; }
    if (token === "-C" || token === "--git-dir" || token === "--work-tree" || token === "--separate-git-dir" || token === "--template") {
      const next = output[index + 1];
      if (next?.startsWith("/")) {
        const intent: PathIntent = subcommand === "init" && token === "--separate-git-dir" ? "create" : "read";
        const translated = translatePathToken(next, table, "path-scalar", intent, index + 1, roots(gate, intent), check(gate));
        output[index + 1] = translated.token;
        decisions.push(translated.decision);
      }
      index += 1;
      continue;
    }
    const combinedC = token.match(/^-C(.+)$/);
    if (combinedC?.[1]?.startsWith("/")) {
      const translated = translatePathToken(combinedC[1], table, "path-scalar", "read", index, roots(gate, "read"), check(gate));
      output[index] = `-C${translated.token}`;
      decisions.push(translated.decision);
      continue;
    }
    const equals = token.match(/^(--git-dir|--work-tree|--separate-git-dir|--template)=(.*)$/);
    if (equals?.[2]?.startsWith("/")) {
      const intent: PathIntent = subcommand === "init" && equals[1] === "--separate-git-dir" ? "create" : "read";
      const translated = translatePathToken(equals[2], table, "path-scalar", intent, index, roots(gate, intent), check(gate));
      output[index] = `${equals[1]}=${translated.token}`;
      decisions.push(translated.decision);
      continue;
    }
    if (!afterDoubleDash && index === initDestination && token.startsWith("/")) {
      const translated = translatePathToken(token, table, "path-scalar", "create", index, roots(gate, "create"), check(gate));
      output[index] = translated.token;
      decisions.push(translated.decision);
      continue;
    }
    // 跳过 ":(!...)" 等 magic pathspec：它们是 pathspec 语法而非路径字面量，不应翻译。
    if (afterDoubleDash && token.startsWith(":(")) continue;
    if (afterDoubleDash && token.startsWith("/")) {
      const translated = translatePathToken(token, table, "pathspec", "read", index, roots(gate, "read"), check(gate));
      output[index] = translated.token;
      decisions.push(translated.decision);
    }
  }
  return { argv: output, decisions };
}

/**
 * 默认原生命令注册表：git（MinGit）、rg（ripgrep）、node。
 * - executable 以 "$RUNTIME_ROOT/" 为前缀，由 resolveExecutable 展开为运行时根目录下的实际路径；
 * - adapterId 的前缀（git / rg / 其他）决定 NativeRegistry.resolve 选用哪个适配器；
 * - shellEquivalent 表示该命令脱离 bash 直接执行与在 shell 中执行行为是否等价：
 *   git/rg 为 true（可直接走原生快路径）；node 为 false（脚本可能依赖 POSIX 环境，
 *   例如再派生 POSIX 子进程，故不承诺等价）。
 */
export const DEFAULT_REGISTRY: NativeCommandDescriptor[] = [
  { name: "git", executable: "$RUNTIME_ROOT/native/mingit/cmd/git.exe", adapterId: "git-v1", shellEquivalent: true },
  { name: "rg", executable: "$RUNTIME_ROOT/native/rg/rg.exe", adapterId: "rg-v1", shellEquivalent: true },
  { name: "node", executable: "$RUNTIME_ROOT/node/node.exe", adapterId: "node-v1", shellEquivalent: false },
];

/** Built-in adapters are contributions just like third-party native tool adapters. */
export const DEFAULT_NATIVE_ADAPTERS: NativeCommandAdapter[] = [
  { id: "git-v1", adapt: gitAdapter },
  { id: "rg-v1", adapt: rgAdapter },
  { id: "node-v1", adapt: nodeAdapter },
];

const NATIVE_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const NATIVE_ADAPTER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * 原生命令注册表。
 *
 * 职责：
 * - resolve()：判断某个简单命令能否走原生后端（Native Fast Path），命中时给出
 *   宿主可执行文件路径与完成参数级路径翻译后的 argv；未命中（miss）由调用方回退 MSYS2；
 * - hash()：生成注册表指纹，纳入 RuntimeSnapshot（snapshotId 的合成材料之一）；
 * - validate()：运行时加载阶段的注册表自检，拦截不合法配置。
 */
export class NativeRegistry {
  private readonly descriptors: readonly NativeCommandDescriptor[];
  private readonly adapters: readonly NativeCommandAdapter[];

  /** @param descriptors 注册表条目，默认使用 DEFAULT_REGISTRY；允许注入便于测试。 */
  constructor(
    descriptors: readonly NativeCommandDescriptor[] = DEFAULT_REGISTRY,
    adapters: readonly NativeCommandAdapter[] = DEFAULT_NATIVE_ADAPTERS,
  ) {
    this.descriptors = Object.freeze(descriptors.map((descriptor) => Object.freeze({ ...descriptor })));
    this.adapters = Object.freeze(adapters.map((adapter) => Object.freeze({ id: adapter.id, adapt: adapter.adapt })));
  }

  /** 返回注册表条目的防御性副本，供 runtime info 等只读诊断接口使用。 */
  list(): NativeCommandDescriptor[] {
    return this.descriptors.map((descriptor) => ({ ...descriptor }));
  }

  /** Return adapter ids without exposing executable adapter functions. */
  listAdapters(): string[] {
    return this.adapters.map((adapter) => adapter.id);
  }

  /**
   * 计算注册表内容的 base64url 指纹。
   * 该值作为 registryHash 写入 RuntimeSnapshot，并参与 snapshotId 的合成：
   * 注册表内容一旦变化，快照身份随之变化，避免执行计划 / 会话错误复用
   * 基于旧注册表的解析结果。
   */
  hash(): string {
    return Buffer.from(JSON.stringify({ descriptors: this.descriptors, adapters: this.adapters.map((adapter) => adapter.id) })).toString("base64url");
  }

  /**
   * 解析一个简单命令是否可走原生后端（Native Fast Path）。
   *
   * @param command 命令名（argv[0]）
   * @param argv 完整命令行参数（含命令名本身）
   * @param snapshot 当前运行时快照（提供 runtimeRoot 与 manifest.mode 等）
   * @param table 挂载表，适配器用它做虚拟路径 -> 宿主路径的翻译
   * @param gate 策略门，用于可执行文件与路径的策略校验
   * @returns 命中时返回 { descriptor, executable, adapter }：
   *          - descriptor：命中的注册表条目；
   *          - executable：实际可执行文件的宿主路径；
   *          - adapter：适配器翻译结果（改写后的 argv 与 pathDecisions）。
   *          命令不在注册表、或可执行文件不可用（release 模式 fail-closed 不回退
   *          PATH）时返回 undefined，即 miss，调用方回退 MSYS2 后端。
   * @throws 策略校验失败时抛 PosixLoomError（POLICY_PATH_DENIED /
   *         POLICY_EXECUTABLE_DENIED / POLICY_EXECUTABLE_MISSING 等）。
   *         注意：抛错表示"策略拒绝"，与返回 undefined 的"miss"语义不同。
   */
  resolve(command: string, argv: string[], snapshot: RuntimeSnapshot, table: MountTable, gate: PolicyGate): {
    descriptor: NativeCommandDescriptor;
    executable: HostPath;
    adapter: AdapterResult;
  } | undefined {
    // 1) 查表：命令不在注册表 -> miss。
    const descriptor = this.descriptors.find((entry) => entry.name === command);
    if (!descriptor) return undefined;
    // 2) 定位可执行文件：找不到（release 模式 fail-closed，不回退 PATH）同样视为 miss。
    const executable = resolveExecutable(descriptor, snapshot);
    if (!executable) return undefined;
    // 3) 按 adapterId 前缀选择适配器，完成参数级路径翻译（只改写 argv，不执行命令）。
    const adapterPlugin = this.adapters.find((candidate) => candidate.id === descriptor.adapterId);
    if (!adapterPlugin) {
      throw new PosixLoomError("REGISTRY_ADAPTER_MISSING", `Native command ${descriptor.name} references an unavailable adapter: ${descriptor.adapterId}`, {
        command: descriptor.name,
        adapterId: descriptor.adapterId,
      });
    }
    const adapter = adapterPlugin.adapt([...argv], table, gate);
    if (!adapter || !Array.isArray(adapter.argv) || adapter.argv.some((argument) => typeof argument !== "string") || !Array.isArray(adapter.decisions)) {
      throw new PosixLoomError("REGISTRY_ADAPTER_INVALID", `Native adapter returned an invalid result: ${adapterPlugin.id}`, { adapterId: adapterPlugin.id, command });
    }
    // 4) 策略断言：守卫模式下校验可执行文件必须位于 runtimeRoot 内（release）且确实存在；失败抛错而非回退。
    gate.assertExecutable(executable);
    return {
      descriptor,
      executable,
      adapter: {
        argv: [...adapter.argv],
        decisions: adapter.decisions.map((decision) => ({ ...decision })),
      },
    };
  }

  /**
   * 注册表自检（运行时加载阶段调用）。
   * 规则一：每条目必须具备 name / executable / adapterId 三个必填字段；
   * 规则二：executable 不得包含 "runtime/current/" -- 该目录指向运行时切换用的
   * "当前"目标，其内容未经过清单与哈希校验，注册表引用它会绕过供应链验证。
   *
   * @throws PosixLoomError 错误码固定为 REGISTRY_INVALID。
   */
  validate(): void {
    const commandNames = new Set<string>();
    const adapterIds = new Set<string>();
    for (const adapter of this.adapters) {
      if (typeof adapter.id !== "string" || !NATIVE_ADAPTER_ID.test(adapter.id) || typeof adapter.adapt !== "function" || adapterIds.has(adapter.id)) {
        throw new PosixLoomError("REGISTRY_INVALID", `Invalid or duplicate Native adapter: ${adapter.id}`);
      }
      adapterIds.add(adapter.id);
    }
    for (const descriptor of this.descriptors) {
      // 字段完整性检查。
      if (typeof descriptor.name !== "string" || !NATIVE_COMMAND_NAME.test(descriptor.name) || typeof descriptor.executable !== "string" || !descriptor.executable || typeof descriptor.adapterId !== "string" || !NATIVE_ADAPTER_ID.test(descriptor.adapterId) || typeof descriptor.shellEquivalent !== "boolean") {
        throw new PosixLoomError("REGISTRY_INVALID", `Invalid Native registry entry: ${JSON.stringify(descriptor)}`);
      }
      if (commandNames.has(descriptor.name)) {
        throw new PosixLoomError("REGISTRY_INVALID", `Duplicate Native registry command: ${descriptor.name}`);
      }
      commandNames.add(descriptor.name);
      if (!adapterIds.has(descriptor.adapterId)) {
        throw new PosixLoomError("REGISTRY_INVALID", `Native registry entry references an unavailable adapter: ${descriptor.name}/${descriptor.adapterId}`);
      }
      if (descriptor.executable.includes("\0") || (descriptor.executable.includes("$RUNTIME_ROOT") && !descriptor.executable.startsWith("$RUNTIME_ROOT/"))) {
        throw new PosixLoomError("REGISTRY_INVALID", `Native registry entry has an invalid executable reference: ${descriptor.name}`);
      }
      if (descriptor.executable.startsWith("$RUNTIME_ROOT/")) {
        const relative = descriptor.executable.slice("$RUNTIME_ROOT/".length);
        if (!relative || relative.split(/[\\/]+/).some((segment) => segment === "..")) {
          throw new PosixLoomError("REGISTRY_INVALID", `Native registry entry escapes RuntimeRoot: ${descriptor.name}`);
        }
      }
      // 禁止引用未经验证的 runtime/current/ 路径。
      if (descriptor.executable.includes("runtime/current/")) {
        throw new PosixLoomError("REGISTRY_INVALID", `Registry entry uses forbidden runtime/current path: ${descriptor.name}`);
      }
    }
  }
}
