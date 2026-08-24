/**
 * PosixLoom 虚拟/宿主路径双向翻译层。
 *
 * PosixLoom 采用"路径双轨制"：命令行参数、cwd、策略根一律以 POSIX 风格的虚拟路径
 * （如 /workspace/src）表达，仅在启动子进程前才翻译成 Windows 宿主路径
 * （如 D:\posixloom\data\home\src）。这样做的原因：
 *   - POSIX 工具链（tar/cp/bash 等）对反斜杠与盘符语义不兼容，必须先统一到
 *     正斜杠的虚拟空间，再在边界处一次性转换；
 *   - 策略（policy）在虚拟空间声明读写根，与用户宿主机的目录布局解耦，
 *     换机器只需换挂载表，策略本身不用改；
 *   - 虚拟路径有唯一规范形态，词法判定（是否在允许根内）因此精确且可审计。
 *
 * MountTable 使用"最长前缀匹配"：挂载点按虚拟路径长度降序排序后取首个命中项，
 * 嵌套挂载（/home 与 /home/proj 指向不同宿主目录）时最具体的规则获胜，
 * 与 mount(8) 等既有语义一致。
 *
 * 词法判定可被符号链接绕过：虚拟路径翻译后在允许根内，不代表真实位置在允许根内
 * （允许根里可以放一个指向 C:\Windows 的链接）。physicalCheck 因此用
 * realpathSync.native 把"最深现存祖先"解析成规范物理路径，再确认它落在某个
 * realpath 过的允许根之内，构成第二道防线。
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, win32 } from "node:path";
import { PosixLoomError } from "./errors.js";
import type { HostPath, MountSpec, PathDecision, PathIntent, VirtualPath } from "./types.js";

/**
 * 将输入归一化为规范虚拟路径：以 / 开头、正斜杠分隔、不含空段 / `.` / `..`、
 * 无尾部斜杠。不以 / 开头的相对输入原样返回（相对路径由子进程按其 cwd 解析，
 * 不属虚拟路径治理范围）。
 *
 * `..` 回退到虚拟根之外时抛 PATH_BOUNDARY_DENIED -- 这是抵御
 * `/workspace/../../..` 类越界的第一道防线，保证后续挂载翻译与前缀匹配
 * 面对的永远是干净形态。
 *
 * @throws PATH_BOUNDARY_DENIED `..` 试图越过虚拟根
 */
export function normalizeVirtual(input: string): VirtualPath {
  if (!input.startsWith("/")) return input;
  const parts: string[] = []; // 段栈：普通段压入，".." 弹出上一段
  // 反斜杠先统一为正斜杠，防止 Windows 风格输入绕过分段逻辑
  for (const part of input.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue; // 空段（连续斜杠）与当前目录段直接丢弃
    if (part === "..") {
      // 栈已空仍要回退 => 试图越过虚拟根，拒绝而非静默截断
      if (!parts.length) throw new PosixLoomError("PATH_BOUNDARY_DENIED", `Path escapes virtual root: ${input}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  // 空栈说明输入就是根本身，统一为 "/"
  return `/${parts.join("/")}` || "/";
}

/** Windows 风格归一化 + 转小写 + 去掉尾部斜杠，供大小写不敏感的路径前缀比较使用；
 *  去尾部分隔符让 D:\foo 与 D:\foo\ 判等，也保证 `root + "\\"` 前缀拼接正确。 */
function winCase(value: string): string {
  return win32.normalize(value).replace(/[\\/]$/, "").toLowerCase();
}

/**
 * 词法判断 target 是否等于 root 或位于 root 目录之下（Windows 大小写不敏感）。
 * 只做字符串前缀比较，不解析符号链接；物理层面的越界检测由 physicalCheck 负责。
 */
export function isHostPathInside(root: string, target: string): boolean {
  const r = winCase(root);
  const t = winCase(target);
  return t === r || t.startsWith(`${r}\\`);
}

/**
 * 挂载表：虚拟路径 <-> 宿主路径的双向翻译器，"路径双轨制"的核心组件。
 *
 * 构造时即完成归一化并准备两份排序副本：
 *  - entries：按虚拟路径长度降序，使 findMount 的顺序扫描天然实现"最长前缀匹配"，
 *    嵌套挂载（如 /home 与 /home/proj 指向不同宿主目录）时最具体的规则获胜；
 *  - hostEntries：按宿主路径长度降序，供 toVirtual 反向匹配时同样最具体优先。
 */
export class MountTable {
  readonly entries: MountSpec[];
  private readonly hostEntries: MountSpec[];

  constructor(entries: Record<string, string> | MountSpec[]) {
    const values = Array.isArray(entries)
      ? entries
      : Object.entries(entries).map(([virtualPath, hostPath]) => ({ virtualPath, hostPath }));
    this.entries = values
      .map((entry) => ({ virtualPath: normalizeVirtual(entry.virtualPath), hostPath: resolve(entry.hostPath) }))
      // 虚拟路径长者在前：顺序扫描首个命中即最长前缀
      .sort((a, b) => b.virtualPath.length - a.virtualPath.length);
    // 宿主路径同理排序，供 toVirtual 选取最具体的挂载
    this.hostEntries = [...this.entries].sort((a, b) => b.hostPath.length - a.hostPath.length);
  }

  /** 查找虚拟路径命中的挂载点：须整路径相等，或严格以 "挂载点/" 开头
   *  （避免 /home2 误命中 /home）；entries 已按长度降序，首个命中即最长前缀。 */
  findMount(path: VirtualPath): MountSpec | undefined {
    const normalized = normalizeVirtual(path);
    return this.entries.find((entry) => normalized === entry.virtualPath || normalized.startsWith(`${entry.virtualPath}/`));
  }

  /**
   * 虚拟路径 -> 宿主路径（启动子进程前替换参数时使用）。
   *
   * 处理顺序（前者优先）：
   *  1. 非 / 开头：相对路径，原样透传；
   *  2. //server/share：UNC 虚拟形式，直接转 \\server\share；
   *  3. 挂载表最长前缀命中：挂载宿主目录 + 去掉挂载前缀后的剩余后缀；
   *  4. /c/foo 单盘符形式：兜底映射为 C:\foo（未挂载也能访问任意盘）；
   *  5. 其余抛 PATH_UNMOUNTED。
   *
   * @throws PATH_UNMOUNTED 路径不在任何挂载点下，也不是合法的盘符形式
   */
  toHost(input: VirtualPath): HostPath {
    if (!input.startsWith("/")) return input;
    // //server/share 形式直通 UNC，不走挂载表
    if (input.startsWith("//")) return `\\\\${input.slice(2).replaceAll("/", "\\")}`;
    const normalized = normalizeVirtual(input);
    const mount = this.findMount(normalized);
    if (mount) {
      // 去掉挂载点前缀，剩余部分拼接到宿主目录之后
      const suffix = normalized.slice(mount.virtualPath.length).replace(/^\//, "");
      return suffix ? win32.join(mount.hostPath, suffix) : mount.hostPath;
    }
    // 兜底：/c/foo -> C:\foo，即使未配置挂载也能访问各盘符
    const drive = normalized.match(/^\/([A-Za-z])(?:\/(.*))?$/);
    if (drive) return `${drive[1].toUpperCase()}:\\${(drive[2] ?? "").replaceAll("/", "\\")}`;
    throw new PosixLoomError("PATH_UNMOUNTED", `No mount for virtual path: ${input}`, { input });
  }

  /**
   * 宿主路径 -> 虚拟路径（toHost 的逆运算），用于把子进程上报的宿主路径
   * （如 state report 中的 cwd）翻译回虚拟空间。
   * 优先反向匹配挂载点（hostEntries 已按宿主路径长度降序，天然最具体优先）；
   * 未命中时 UNC 还原为 //server/share、盘符路径还原为小写 /c/... 形式；
   * 都无法表达则抛 PATH_NOT_REPRESENTABLE。
   *
   * @throws PATH_NOT_REPRESENTABLE 无法映射为任何虚拟形态
   */
  toVirtual(input: HostPath): VirtualPath {
    const normalizedHost = win32.normalize(input);
    const mount = this.hostEntries.find((entry) => isHostPathInside(entry.hostPath, normalizedHost));
    if (mount) {
      // 相对挂载宿主目录求出后缀，再拼回虚拟挂载点
      const suffix = relative(mount.hostPath, normalizedHost).replaceAll("\\", "/");
      return normalizeVirtual(`${mount.virtualPath}/${suffix}`);
    }
    // 未挂载：UNC 直接还原为 //server/share
    if (normalizedHost.startsWith("\\\\")) return `//${normalizedHost.slice(2).replaceAll("\\", "/")}`;
    // 未挂载：盘符路径还原为小写 /c/... 形式
    const drive = normalizedHost.match(/^([A-Za-z]):[\\/]?(.*)$/);
    if (drive) return normalizeVirtual(`/${drive[1].toLowerCase()}/${drive[2].replaceAll("\\", "/")}`);
    throw new PosixLoomError("PATH_NOT_REPRESENTABLE", `Host path cannot be represented: ${input}`, { input });
  }

  /** 虚拟 -> 宿主 -> 虚拟 往返一次，得到与当前挂载表一致的规范虚拟路径
   *  （用于规范化用户输入或验证翻译稳定性）。 */
  roundTrip(input: VirtualPath): VirtualPath {
    return this.toVirtual(this.toHost(input));
  }
}

/**
 * 宿主路径 -> 正斜杠"混合形式"（UNC 还原为 //server/share，其余统一正斜杠）。
 * 用于需要嵌入 POSIX 语境的场合（bash 命令行、环境变量值）：
 * 反斜杠在 shell 中是转义字符，原样传入会破坏路径。
 */
export function toMixedHostPath(hostPath: HostPath): string {
  const normalized = win32.normalize(hostPath);
  if (normalized.startsWith("\\\\")) return `//${normalized.slice(2).replaceAll("\\", "/")}`;
  return normalized.replaceAll("\\", "/");
}

/**
 * 物理路径校验：防符号链接绕过词法检查。
 *
 * 词法校验只看翻译出的宿主路径字符串，但允许根内可能藏有指向外部的符号链接，
 * 使实际读写发生在允许范围之外（symlink escape）。本函数把路径解析为"真实物理
 * 位置"后再确认它落在任一允许根内：
 *  - 目标不存在时先上溯到最深现存祖先再 realpath（待创建的新文件只需祖先合法）；
 *  - 允许根同样 realpath，避免"根自身是链接"导致比较基准失真。
 *
 * @param hostPath 待校验的宿主路径（允许尚不存在）
 * @param allowedRoots 允许的宿主根目录列表
 * @param intent 本次访问意图（read/write/...），记入错误详情与审计
 * @returns "passed"：目标存在且真实路径在允许根内；
 *          "best-effort"：目标尚不存在，仅校验了现存祖先
 * @throws POLICY_PATH_DENIED 真实物理路径不在任何允许根内
 */
export function physicalCheck(hostPath: HostPath, allowedRoots: HostPath[], intent: PathIntent): PathDecision["physicalCheck"] {
  // 先上溯到最深现存祖先：对尚未创建的路径（如输出文件）只能校验其祖先
  const existing = findExistingAncestor(hostPath);
  // realpathSync.native 展开符号链接与相对段，得到真实物理位置；
  // 允许根也做同样处理，保证比较双方处于同一形态
  const physical = existsSync(existing) ? realpathSync.native(existing) : existing;
  const normalizedRoots = allowedRoots.map((root) => existsSync(root) ? realpathSync.native(root) : win32.normalize(root));
  if (!normalizedRoots.some((root) => isHostPathInside(root, physical))) {
    throw new PosixLoomError("POLICY_PATH_DENIED", `Physical path is outside allowed roots: ${hostPath}`, {
      hostPath,
      physical,
      intent,
    });
  }
  // 目标本身不存在：祖先合法即放行，但如实标记为 best-effort 以便审计
  return existsSync(hostPath) ? "passed" : "best-effort";
}

/**
 * 沿目录树向上找到第一个真实存在的祖先（供 physicalCheck 对"尚未创建的路径"
 * 做物理校验）。若一路上到卷根仍不存在，则返回卷根本身；
 * dirname(x) === x 是到达文件系统顶点的标志，防止死循环。
 */
function findExistingAncestor(hostPath: HostPath): HostPath {
  let current = win32.normalize(hostPath);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current; // 已到卷根仍不存在，返回根
    current = parent;
  }
  return current;
}

/** 判定命令行参数是否按"虚拟路径"处理：PosixLoom 约定仅以 / 开头的参数才是绝对路径，
 *  其余（相对路径、选项、URL 等）原样透传给子进程。 */
export function isPathLikeToken(token: string): boolean {
  return token.startsWith("/");
}

/**
 * registry 适配器的底层原语：把单个命令行参数从虚拟路径翻译成宿主路径，
 * 并产出可供审计/诊断的 PathDecision。
 *
 * 处理顺序：
 *  1. 非 / 开头的参数不属路径治理范围，原样返回（decision 记为
 *     lexicalAllowed=true、physicalCheck="not-applicable"）；
 *  2. 路径参数依次完成：挂载翻译（toHost）-> 调用方注入的 policyCheck
 *     词法校验 -> 提供了 allowedRoots 时的 physicalCheck 物理校验。
 *
 * @param token 原始参数
 * @param table 挂载表
 * @param kind 参数分类（path-scalar / path-list / pathspec / option / opaque）
 * @param intent 访问意图（read/write/create/execute/unknown）
 * @param argumentIndex 参数在 argv 中的下标，用于审计定位
 * @param allowedRoots 提供时执行物理校验；缺省则跳过并标记 not-applicable
 * @param policyCheck 调用方注入的词法策略校验钩子（可选）
 * @returns 翻译后的 token 与完整决策记录
 * @throws PATH_UNMOUNTED / POLICY_PATH_DENIED 等由下游翻译与校验传播
 */
export function translatePathToken(
  token: string,
  table: MountTable,
  kind: PathDecision["kind"],
  intent: PathIntent,
  argumentIndex: number,
  allowedRoots?: HostPath[],
  policyCheck?: (hostPath: HostPath, intent: PathIntent) => void,
): { token: string; decision: PathDecision } {
  // 普通参数/相对路径不属于路径治理范围，直接透传。
  if (!token.startsWith("/")) {
    return {
      token,
      decision: { argumentIndex, kind, intent, lexicalAllowed: true, physicalCheck: "not-applicable" },
    };
  }
  // 虚拟 -> 宿主翻译，随后执行调用方注入的词法策略校验。
  const host = table.toHost(token);
  policyCheck?.(host, intent);
  // 提供了允许根则再做物理校验，防符号链接逃逸；否则标记 not-applicable。
  const physical = allowedRoots ? physicalCheck(host, allowedRoots, intent) : "not-applicable";
  return {
    token: host,
    decision: {
      argumentIndex,
      kind,
      intent,
      virtualInput: normalizeVirtual(token),
      hostOutput: host,
      lexicalAllowed: true,
      physicalCheck: physical,
    },
  };
}

/**
 * 判断路径是否为真实存在的目录。刻意使用 lstat（不跟随符号链接），
 * 使目录判定不受链接指向影响；任何失败（不存在/无权限/非目录）统一归为 false，
 * 调用方无需关心具体错误。
 */
export function isSafeExistingDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
