/**
 * policy.ts —— 运行时策略闸门（PolicyGate）。
 *
 * 职责：
 * 在 workspace-guard（护栏）模式下，对命令的工作目录、待执行二进制与
 * 路径访问意图做逐项断言，拦截明显越界的操作：cwd 落在挂载表或策略读根
 * 之外、release 模式下执行 RuntimeRoot 之外的二进制、对只读运行时根的
 * 写入等。
 *
 * 设计意图：
 * - guardrail 是“防误操作的护栏”，不是安全沙箱：目标是阻止配置错误与
 *   意外越界，而不是抵御恶意进程。因此 trusted 模式下所有断言直接短路放行。
 * - 校验分两层：先在虚拟路径层做词法判定（策略读/写根），再对宿主物理
 *   路径做 physicalCheck，两层同时通过才放行。
 * - 允许的宿主根由策略根与挂载表求交（allowedHostRoots）：只有同时被
 *   策略允许且已挂载的宿主目录才可访问，避免策略引用未挂载区域。
 */
import { existsSync } from "node:fs";
import { resolve, win32 } from "node:path";
import { PosixLoomError } from "./errors.js";
import { isHostPathInside, MountTable, physicalCheck } from "./path.js";
import type { HostPath, PathIntent, PolicyProfile, RuntimeSnapshot, VirtualPath } from "./types.js";

/**
 * 判断虚拟路径 candidate 是否位于 root 之下（含 root 自身）。
 * 先剥掉 root 结尾的 "/"（根路径回退为 "/"），避免 "/foo" 命中 "/foobar"
 * 这类前缀假阳性。
 */
function rootContains(root: VirtualPath, candidate: VirtualPath): boolean {
  const normalizedRoot = root.replace(/\/$/, "") || "/";
  return candidate === normalizedRoot
    || (normalizedRoot === "/" ? candidate.startsWith("/") : candidate.startsWith(`${normalizedRoot}/`));
}

/**
 * 策略闸门：以只读形式持有 profile、挂载表与运行时快照，
 * 为执行计划提供 cwd、可执行文件、路径访问三类断言。
 *
 * @param profileName 对外暴露的 profile 名称（"trusted" | "workspace-guard"）
 * @param profile 策略内容（模式、读/写根、runtimeReadOnly 开关）
 * @param mounts 会话挂载表（虚拟路径 -> 宿主路径）
 * @param snapshot 运行时快照（含 RuntimeRoot 与清单，用于可执行文件校验）
 */
export class PolicyGate {
  constructor(
    readonly profileName: "trusted" | "workspace-guard",
    readonly profile: PolicyProfile,
    private readonly mounts: MountTable,
    private readonly snapshot: RuntimeSnapshot,
  ) {}

  /** trusted 短路开关：为 true 时全部断言直接放行（护栏仅对 guard 模式生效）。 */
  get trusted(): boolean {
    return this.profile.mode === "trusted";
  }

  /**
   * 断言命令工作目录（cwd）可用。
   *
   * trusted 模式直接放行；guard 模式下要求三关全部通过：
   * 1) cwd 必须落在挂载表内（未挂载区域不可作为 cwd）；
   * 2) cwd 必须位于策略读根内（虚拟层词法判定）；
   * 3) 对应宿主物理路径必须通过读意图的 physicalCheck。
   *
   * @param virtualCwd 虚拟工作目录
   * @param hostCwd 对应的宿主工作目录
   * @throws {PosixLoomError} POLICY_CWD_DENIED -- cwd 在挂载表之外或策略读根之外
   */
  assertCwd(virtualCwd: VirtualPath, hostCwd: HostPath): void {
    if (this.trusted) return;
    const mount = this.mounts.findMount(virtualCwd);
    if (!mount) throw new PosixLoomError("POLICY_CWD_DENIED", `Working directory is outside configured mounts: ${virtualCwd}`, { virtualCwd, hostCwd });
    if (!this.isVirtualAllowed(virtualCwd, "read")) {
      throw new PosixLoomError("POLICY_CWD_DENIED", `Working directory is outside policy read roots: ${virtualCwd}`, { virtualCwd, hostCwd, profile: this.profileName });
    }
    physicalCheck(hostCwd, this.allowedHostRoots("read"), "read");
  }

  /**
   * 断言待执行二进制可用。
   *
   * trusted 模式直接放行；guard 模式下：
   * - release 模式（来自快照清单）要求可执行文件必须位于 RuntimeRoot 内，
   *   防止运行时调用携带范围之外的宿主程序；
   * - 存在性检查对两种 guard 情形都生效（development/release），缺文件
   *   直接报错，尽早失败而不是交给 spawn。
   *
   * @param executable 宿主可执行文件路径
   * @throws {PosixLoomError} POLICY_EXECUTABLE_DENIED -- release 模式下可执行文件在 RuntimeRoot 之外
   * @throws {PosixLoomError} POLICY_EXECUTABLE_MISSING -- 可执行文件不存在
   */
  assertExecutable(executable: HostPath): void {
    if (this.trusted) return;
    const resolved = resolve(executable);
    const runtimeOwned = isHostPathInside(this.snapshot.runtimeRoot, resolved);
    if (this.snapshot.manifest.mode === "release" && !runtimeOwned) {
      throw new PosixLoomError("POLICY_EXECUTABLE_DENIED", "Release execution cannot use an executable outside RuntimeRoot", { executable: resolved });
    }
    if (!existsSync(resolved)) throw new PosixLoomError("POLICY_EXECUTABLE_MISSING", `Executable does not exist: ${resolved}`, { executable: resolved });
  }

  /**
   * 计算指定意图下允许访问的宿主根列表（策略根与挂载表求交）。
   *
   * trusted 模式返回全部挂载点宿主路径；guard 模式先按意图选取策略根
   * （write/create 用 knownWriteRoots，其余用 knownReadRoots），
   * 再与挂载表逐项求交：策略根包含挂载点时放行整个挂载；策略根位于更宽
   * 的挂载内部时，只返回与策略根对应的宿主子目录，避免扩大授权范围。
   *
   * @param intent 路径访问意图（read/write/create/execute/unknown）
   * @returns 允许访问的宿主根路径列表
   */
  allowedHostRoots(intent: PathIntent): HostPath[] {
    if (this.trusted) return this.mounts.entries.map((entry) => entry.hostPath);
    // 按意图选择读根或写根，再与挂载表求交
    const roots = intent === "write" || intent === "create" ? this.profile.knownWriteRoots : this.profile.knownReadRoots;
    const intersections = new Map<string, HostPath>();
    for (const entry of this.mounts.entries) {
      for (const root of roots) {
        if (rootContains(root, entry.virtualPath)) {
          intersections.set(entry.hostPath.toLowerCase(), entry.hostPath);
        } else if (rootContains(entry.virtualPath, root)) {
          // 策略根位于一个更宽的挂载内时，只放行对应的宿主子目录；返回整个
          // 挂载根会让 /workspace 策略意外放行同一根挂载下的 /other。
          const suffix = entry.virtualPath === "/"
            ? root.slice(1)
            : root.slice(entry.virtualPath.length).replace(/^\//, "");
          const hostRoot = suffix ? win32.join(entry.hostPath, suffix) : entry.hostPath;
          intersections.set(hostRoot.toLowerCase(), hostRoot);
        }
      }
    }
    return [...intersections.values()];
  }

  /**
   * 断言宿主路径访问意图放行。
   *
   * trusted 模式直接放行；guard 模式下：
   * - runtimeReadOnly 开启且意图为 write/create 时，拒绝写入 RuntimeRoot，
   *   保证运行时本体在会话期间不可被篡改；
   * - 最后对 allowedHostRoots(intent) 的交集根做物理路径校验。
   *
   * @param hostPath 待访问的宿主路径
   * @param intent 访问意图
   * @throws {PosixLoomError} POLICY_RUNTIME_READ_ONLY -- 只读运行时根收到写/创建意图
   */
  assertPath(hostPath: HostPath, intent: PathIntent): void {
    if (this.trusted) return;
    if (this.profile.runtimeReadOnly && (intent === "write" || intent === "create") && isHostPathInside(this.snapshot.runtimeRoot, hostPath)) {
      throw new PosixLoomError("POLICY_RUNTIME_READ_ONLY", "RuntimeRoot is read-only under workspace-guard", { hostPath, intent });
    }
    physicalCheck(hostPath, this.allowedHostRoots(intent), intent);
  }

  /**
   * 虚拟路径的词法判定：路径是否落在策略根内。
   * 写/创建意图查 knownWriteRoots，其余意图查 knownReadRoots。
   */
  private isVirtualAllowed(path: VirtualPath, intent: PathIntent): boolean {
    const roots = intent === "write" || intent === "create" ? this.profile.knownWriteRoots : this.profile.knownReadRoots;
    return roots.some((root) => rootContains(root, path));
  }
}
