import { PosixLoomError } from "../errors.js";
export const NATIVE_PROTOCOL_VERSION = 1;
export const NATIVE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * 把任意可 JSON 序列化的值编码为一帧：4 字节小端长度头 + UTF-8 JSON payload。
 * 长度前缀让对端无需分隔符扫描即可定界，同时也是 NATIVE_MAX_FRAME_BYTES
 * 的编码侧强制点。
 * @throws {PosixLoomError} NATIVE_FRAME_TOO_LARGE - payload 超过协议单帧上限。
 */
export function encodeNativeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  // 发送侧同样受限，避免构造出对端必然拒绝的帧。
  if (payload.length > NATIVE_MAX_FRAME_BYTES) throw new PosixLoomError("NATIVE_FRAME_TOO_LARGE", "Native Host frame exceeds the protocol limit", { bytes: payload.length });
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * 流式帧解码器：把宿主 stdout 上连续到达的字节切回一组 JSON 值。
 *
 * 管道是无边界的字节流，解码器在内部缓冲区中凑满完整的
 * 「4 字节长度 + payload」才解析一帧，不足一帧则留待下一个 chunk；
 * 流结束时用 finish() 断言没有残留的半帧。
 */
export class NativeFrameDecoder {
  private readonly header = Buffer.allocUnsafe(4);
  private headerBytes = 0;
  private payload?: Buffer;
  private payloadBytes = 0;
  push(chunk: Buffer): unknown[] {
    const frames: unknown[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.payload) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.headerBytes += count; offset += count;
        if (this.headerBytes < 4) continue;
        const length = this.header.readUInt32LE(0);
        if (length > NATIVE_MAX_FRAME_BYTES) throw new PosixLoomError("NATIVE_FRAME_TOO_LARGE", "Native Host sent an oversized frame", { bytes: length });
        this.payload = Buffer.allocUnsafe(length);
        this.payloadBytes = 0;
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset);
      chunk.copy(this.payload, this.payloadBytes, offset, offset + count);
      this.payloadBytes += count; offset += count;
      if (this.payloadBytes === this.payload.length) {
        try { frames.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.payload))); }
        catch { throw new PosixLoomError("NATIVE_FRAME_INVALID", "Native Host sent invalid UTF-8 JSON"); }
        this.headerBytes = 0; this.payload = undefined; this.payloadBytes = 0;
      }
    }
    return frames;
  }
  finish(): void {
    if (this.headerBytes || this.payload) throw new PosixLoomError("NATIVE_FRAME_TRUNCATED", "Native Host closed with a partial frame", { bytes: this.headerBytes + this.payloadBytes });
  }
}

/**
 * 宿主事件帧的宽松形状（字段全部可选，仅作类型收窄用）；
 * 每个字段的合法性由 NativeEventValidator 状态机逐帧裁决。
 * decodedData 是校验 stdout/stderr 事件时解出的二进制输出（非协议字段）。
 */
interface NativeEvent {
  protocolVersion?: number;
  type?: string;
  pid?: number;
  data?: string;
  code?: number;
  outcome?: "exited" | "timed-out" | "cancelled" | "crashed";
  message?: string;
  maxFrameBytes?: number;
  capabilities?: string[];
  decodedData?: Buffer;
}

/**
 * 解码「规范 Base64」并对输入做双向验证。
 *
 * Base64 存在多种等价写法（可省略填充、可插入换行、URL-safe 字母表等），
 * 接受非规范形式会引入歧义与绕过空间。因此先用正则限定标准字母表 +
 * 严格填充，再做「解码 -> 重编码」往返比对，两道都通过才认作规范。
 * @param value 事件里的 data 字段（unknown，按不可信输入对待）。
 * @returns 解码后的二进制输出。
 * @throws {PosixLoomError} NATIVE_PROTOCOL_INVALID - 非字符串 / 长度非 4 的倍数 /
 *                   字符或填充不合规 / 重编码结果与原文不一致。
 */
function decodeCanonicalBase64(value: unknown): Buffer {
  // 第一道：结构校验--标准字母表、4 字节分组、正确的 = / == 填充。
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host stream data is not canonical Base64");
  }
  // 第二道：往返校验--解码后重新编码必须逐字符还原原文。
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host stream data is not canonical Base64");
  return decoded;
}

/**
 * Native Host 事件流状态机（fail-closed 严格校验器）。
 *
 * 合法序列唯一：hello -> started -> (stdout | stderr)* -> (exit | error)。
 * 宿主输出是不可信边界（宿主可能损坏、被替换或版本错配），因此校验策略是
 * 「凡不合法即拒绝」而不是尽力解释：
 * - hello 必须是首帧且只出现一次，并须回显一致的 maxFrameBytes；
 * - started 只出现一次，pid 必须为正安全整数；
 * - stdout/stderr 必须出现在 started 之后，data 必须是规范 Base64；
 * - exit/error 是终止事件，其后不允许再有任何事件；
 * - 未知事件类型一律拒绝--协议演进必须显式升版本，不做前向兼容。
 *
 * @throws {PosixLoomError} NATIVE_PROTOCOL_MISMATCH - 帧内 protocolVersion 与本侧不符。
 * @throws {PosixLoomError} NATIVE_PROTOCOL_INVALID - 其余一切乱序/重复/缺字段/未知类型。
 */
export class NativeEventValidator {
  constructor(private readonly allowPrestartStop = false) {}
  /** 是否已收到 hello（协议握手完成）。 */
  private hello = false;
  /** 是否已收到 started（子进程已创建并取得 pid）。 */
  private started = false;
  /** 是否已收到终止事件（exit/error），此后事件流必须结束。 */
  private terminal = false;

  /**
   * 校验单个事件帧；通过则返回该事件（stdout/stderr 额外附带解码后的
   * decodedData）。
   * @param value 帧解码出的 JSON 值，视为不可信输入。
   */
  accept(value: unknown): NativeEvent {
    // 事件必须是 JSON 对象；数组、标量、null 都不接受。
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host event must be a JSON object");
    const event = value as NativeEvent;
    // 每一帧都必须携带正确版本号；版本不符单列 MISMATCH，便于定位宿主版本错配。
    if (event.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
      throw new PosixLoomError("NATIVE_PROTOCOL_MISMATCH", `Native Host protocol mismatch: expected ${NATIVE_PROTOCOL_VERSION}, received ${event.protocolVersion ?? "missing"}`);
    }
    if (typeof event.type !== "string") throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host event type is required");
    if (event.type === "hello") {
      // hello 必须是第一帧：此前出现过任何事件（包括重复 hello）都算乱序。
      if (this.hello || this.started || this.terminal) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host hello event is duplicated or out of order");
      // 双方帧上限必须一致，否则本侧的 16MB 防线形同虚设。
      if (event.maxFrameBytes !== NATIVE_MAX_FRAME_BYTES) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host frame limit does not match protocol v1");
      this.hello = true;
      return event;
    }
    // hello 之前不允许任何其他事件；终止事件之后也不允许任何事件。
    if (!this.hello) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host sent data before protocol hello");
    if (this.terminal) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host sent data after a terminal event");
    if (event.type === "started") {
      // pid 必须是正的安全整数；重复 started 视为违规。
      if (this.started || !Number.isSafeInteger(event.pid) || (event.pid ?? 0) <= 0) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host started event is invalid or duplicated");
      this.started = true;
      return event;
    }
    if (event.type === "stdout" || event.type === "stderr") {
      // 输出事件必须在 started 之后；data 在此同步做规范 Base64 验证并解码。
      if (!this.started) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host emitted process output before started");
      return { ...event, decodedData: decodeCanonicalBase64(event.data) };
    }
    if (event.type === "exit") {
      // Namespace wait can stop without creating a child. Never accept a pre-start success.
      const waitingStop = this.allowPrestartStop && ((event.outcome === "cancelled" && event.code === 130) || (event.outcome === "timed-out" && event.code === 124));
      if ((!this.started && !waitingStop) || !["exited", "timed-out", "cancelled", "crashed"].includes(event.outcome ?? "") || !Number.isSafeInteger(event.code)) {
        throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host exit event is invalid");
      }
      this.terminal = true;
      return event;
    }
    if (event.type === "error") {
      // error 是另一类终止事件：宿主侧执行失败，必须有非空 message。
      if (typeof event.message !== "string" || !event.message) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host error event has no message");
      this.terminal = true;
      return event;
    }
    // 未知类型：协议没有「忽略未知事件」的宽容度，直接拒绝。
    throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", `Unknown Native Host event type: ${event.type}`);
  }
}
