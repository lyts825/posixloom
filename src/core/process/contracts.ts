import type { CommandOutcome, HostPath, TerminalSize } from "../types.js";
import type { InteractiveProcessController } from "./interactive.js";

/**
 * 进程执行请求。
 *
 * - program/args/cwd/env：目标程序、参数、工作目录与最小环境变量集。
 * - timeoutMs：硬超时；到期终止进程树（native 路径由宿主执行，node 路径本地执行）。
 * - cancelGraceMs：取消/超时后先温和终止，超过宽限期仍存活则强杀；默认 2000ms。
 * - input：写入子进程 stdin 的内容，写完即关闭写入端（EOF）。
 * - reportFd：为子进程开放 fd=3 作为报告通道（state-report 用，仅 Node 路径支持）。
 * - reportPath：报告文件路径（部分命令把报告落盘而非走 fd），结束时读取并删除。
 * - hostPath：Rust Native Host 可执行文件路径；提供且无需 reportFd 时走原生路径。
 * - signal：外部取消信号，触发即取消整次执行。
 * - maxOutputBytes：stdout/stderr 各自的采集上限，超出按头尾截断策略丢弃。
 * - outputDrainTimeoutMs：进程退出后等待异步输出接收器的硬上限。
 * - maxReportBytes：StateReport 文件或 fd 数据的硬上限。
 */
export interface ProcessRunOptions {
  program: HostPath;
  args: string[];
  cwd: HostPath;
  env: Record<string, string>;
  timeoutMs: number;
  cancelGraceMs?: number;
  input?: string | Buffer;
  reportFd?: boolean;
  reportPath?: string;
  hostPath?: HostPath;
  /** Windows MSYS installation/user identity; Native Host serializes its shared mounts. */
  shellNamespace?: string;
  signal?: AbortSignal;
  maxOutputBytes: number;
  outputDrainTimeoutMs?: number;
  maxReportBytes?: number;
  /**
   * 可选的实时输出接收器。返回的 Promise 在读取更多子进程输出前被等待，
   * 从而把下游写入速度作为背压传回进程管道。
   */
  onOutput?: (event: ProcessOutputEvent) => void | Promise<void>;
  /** 伪终端初始大小；提供时必须同时提供 Native Host。 */
  terminal?: TerminalSize;
  /** 运行期标准输入/EOF/窗口大小控制通道。 */
  interactive?: InteractiveProcessController;
}

/** 实时输出事件；sequence 在 stdout/stderr 两路之间统一单调递增。 */
export interface ProcessOutputEvent {
  sequence: number;
  stream: "stdout" | "stderr";
  data: Buffer;
}
/**
 * 进程执行结果。两种后端产出同一形状，上层无需感知差异。
 */
export interface ProcessRunResult {
  /** Milliseconds from backend entry; absent phases indicate the process never reached them. */
  timings?: Record<string, number>;
  /** 终局判定：exited / timed-out / cancelled / crashed / spawn-failed。 */
  outcome: CommandOutcome;
  /** 截断后的 stdout（若发生截断，内含 [PosixLoom OUTPUT TRUNCATED] 分隔标记）。 */
  stdout: Buffer;
  /** 截断后的 stderr。 */
  stderr: Buffer;
  /** 报告数据：优先读 reportPath 文件，否则回退 reportFd 管道内容，皆无则为空 Buffer。 */
  report: Buffer;
  /** stdout 真实总字节数（截断前口径），反映进程实际产出规模。 */
  stdoutBytes: number;
  /** stderr 真实总字节数（截断前口径）。 */
  stderrBytes: number;
  /** stdout 或 stderr 任一发生截断即为 true。 */
  truncated: boolean;
  /** 实际使用的后端：native-host（Rust 宿主）或 node-fallback（Node 直启）。 */
  processMode: "native-host" | "node-fallback";
}
