/**
 * =============================================================================
 * PosixLoom 统一错误类型（全库唯一的错误出口）
 * =============================================================================
 *
 * 【职责】
 * 定义贯穿整个代码库的 PosixLoomError 与错误归一化工具 asPosixLoomError。
 *
 * 【设计意图（为什么这样设计）】
 * PosixLoom 的所有可预期失败都以"语义化错误码 + 人类可读消息 + 结构化上下文"
 * 三元组表达：
 * - code 是机器可读的稳定契约（全大写下划线风格，如 PATH_UNMOUNTED、
 *   STATE_CONFLICT、RUNTIME_ID_MISMATCH、UPDATE_SIGNATURE_INVALID，全库
 *   50+ 个），调用方（尤其是 control 协议的上层宿主）依据 code 做分支处理
 *   与告警，而不是脆弱地解析错误文案；
 * - message 面向人，仅用于展示与日志；
 * - details 携带结构化上下文（涉及的路径、期望值 / 实际值等），会被原样
 *   序列化进错误响应与 trace，便于事后审计。
 *
 * 【与相邻模块的关系】
 * config / path / policy / env / session / registry / runtime / updater /
 * process / service 等模块统一抛出 PosixLoomError；service 与 control 在边界处
 * 用 asPosixLoomError 把未知异常收口为 PosixLoomError，防止非 PosixLoomError 泄漏到协议层。
 */

/**
 * PosixLoom 统一错误类型。构造签名固定为 (code, message, details)，
 * 其中 code 与 details 为只读属性，保证错误一旦抛出即不可被中途改写。
 */
export class PosixLoomError extends Error {
  constructor(
    // 语义化错误码（机器可读），全库稳定契约，如 "PATH_UNMOUNTED"、"STATE_CONFLICT"。
    public readonly code: string,
    message: string,
    // 结构化错误上下文（路径、期望 / 实际值等），会被序列化进错误响应与 trace。
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    // 固定 name，便于在日志与 instanceof 之外的场景（如序列化输出）识别。
    this.name = "PosixLoomError";
  }
}

/**
 * 错误归一化：把任意抛出值收敛为 PosixLoomError。
 * - 已是 PosixLoomError：原样透传，保留原始错误码与 details（不重新包装）；
 * - 普通 Error：取其 message，套用 fallbackCode；
 * - 其他值（字符串、数字等）：String 化后包装。
 * fallbackCode 允许调用方按场景指定更具体的兜底错误码（默认 INTERNAL_ERROR），
 * 例如协议层可传入控制协议相关的错误码。
 */
export function asPosixLoomError(error: unknown, fallbackCode = "INTERNAL_ERROR"): PosixLoomError {
  if (error instanceof PosixLoomError) return error;
  if (error instanceof Error) return new PosixLoomError(fallbackCode, error.message);
  return new PosixLoomError(fallbackCode, String(error));
}
