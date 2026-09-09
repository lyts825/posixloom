/** Stable process API; implementation is split by trust boundary and backend. */
export * from "./process/contracts.js";
export * from "./process/interactive.js";
export * from "./process/protocol.js";
export { OutputCollector } from "./process/output.js";
import { PosixLoomError } from "./errors.js";
import type { ProcessRunOptions, ProcessRunResult } from "./process/contracts.js";
import { validateTerminalSize } from "./process/interactive.js";
import { DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS, DEFAULT_MAX_REPORT_BYTES } from "./process/output.js";
import { runViaNativeHost } from "./process/native.js";
import { runViaNode } from "./process/node.js";

/**
 * 进程执行统一入口。
 *
 * 分派规则：提供 hostPath 且不需要 reportFd 时走 Rust Native Host（可靠的
 * Job Object 进程树管理）；否则走 Node 回退。reportFd 场景
 * （shell 内建命令的报告通道）目前仅 Node 路径支持--fd=3 由 Node 建管道，
 * 报告文件/数据由 service 层在进程结束后读取。
 */
export async function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  if (options.shellNamespace !== undefined && (process.platform !== "win32" || !options.hostPath || options.reportFd || !/^[a-f0-9]{64}$/.test(options.shellNamespace))) {
    throw new PosixLoomError("SHELL_NAMESPACE_INVALID", "Shell namespace coordination requires Windows Native Host and a 64-digit lowercase SHA-256 identity");
  }
  const outputDrainTimeoutMs = options.outputDrainTimeoutMs ?? DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS;
  const maxReportBytes = options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
  if (!Number.isSafeInteger(outputDrainTimeoutMs) || outputDrainTimeoutMs <= 0) {
    throw new PosixLoomError("OUTPUT_DRAIN_TIMEOUT_INVALID", "outputDrainTimeoutMs must be a positive integer", { outputDrainTimeoutMs });
  }
  if (!Number.isSafeInteger(maxReportBytes) || maxReportBytes <= 0) {
    throw new PosixLoomError("REPORT_LIMIT_INVALID", "maxReportBytes must be a positive integer", { maxReportBytes });
  }
  if (options.terminal) {
    validateTerminalSize(options.terminal);
    if (!options.hostPath) throw new PosixLoomError("PTY_UNAVAILABLE", "Interactive terminal execution requires the Native Host");
  }
  if (options.interactive && !options.terminal) throw new PosixLoomError("TERMINAL_MODE_REQUIRED", "Interactive input requires terminal mode");
  if (options.hostPath && !options.reportFd) return runViaNativeHost(options);
  return runViaNode(options);
}
