import type { CommandOutcome } from "../types.js";
import type { ProcessRunResult } from "./contracts.js";
import { OutputCollector } from "./output.js";

/**
 * 把两个输出收集器与报告数据组装成统一的 ProcessRunResult。
 * stdoutBytes/stderrBytes 采用截断前的真实总量（totalBytes）；
 * truncated 为两路输出中任一发生截断的标记。
 */
export function makeResult(
  outcome: CommandOutcome,
  stdout: OutputCollector,
  stderr: OutputCollector,
  report: Buffer,
  processMode: ProcessRunResult["processMode"],
): ProcessRunResult {
  const stdoutResult = stdout.finish();
  const stderrResult = stderr.finish();
  return {
    outcome,
    stdout: stdoutResult.data,
    stderr: stderrResult.data,
    report,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
    truncated: stdoutResult.truncated || stderrResult.truncated,
    processMode,
  };
}
