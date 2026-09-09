/** Strict, binary-safe StateReport v1 decoder. */
import { PosixLoomError } from "./errors.js";
import { canonicalEnvKey } from "./env.js";

export interface ParsedStateReport {
  exitCode: number;
  cwd: string;
  exportedEnv: Record<string, string>;
}

/** Minimal isolated receipt; full v1 reports remain valid for custom backends. */
export function parseIsolatedReport(report: Buffer): { exitCode: number } | undefined {
  if (!report.length) return undefined;
  const stateHeader = Buffer.from("__POSIXLOOM_REPORT_V1\n");
  if (report.subarray(0, stateHeader.length).equals(stateHeader)) return parseStateReport(report);
  const match = /^__POSIXLOOM_COMPLETION_V1\nexit-code=(0|[1-9][0-9]{0,2})\n__POSIXLOOM_REPORT_END\n$/.exec(report.toString("utf8"));
  if (!match || match[0].length !== report.length || Number(match[1]) > 255) throw new PosixLoomError("STATE_PROTOCOL_FAILED", "Isolated completion receipt is invalid");
  return { exitCode: Number(match[1]) };
}

/** Strictly decode StateReport v1 without accepting truncated or ambiguous data. */
export function parseStateReport(report: Buffer): ParsedStateReport | undefined {
  const header = Buffer.from("__POSIXLOOM_REPORT_V1\n");
  if (!report.length) return undefined;
  if (!report.subarray(0, header.length).equals(header)) throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport header is invalid");
  let offset = header.length;
  const readLine = (): string => {
    const end = report.indexOf(0x0a, offset);
    if (end < 0) throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport line is truncated");
    const line = report.subarray(offset, end).toString("utf8");
    offset = end + 1;
    return line;
  };
  const exitLine = readLine();
  const cwdLine = readLine();
  const bytesLine = readLine();
  if (!exitLine.startsWith("exit-code=") || !cwdLine.startsWith("cwd-b64=") || !bytesLine.startsWith("env-bytes=")) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport metadata labels are invalid");
  }
  const exitCode = Number(exitLine.slice("exit-code=".length));
  const cwd64 = cwdLine.slice("cwd-b64=".length);
  const envBytes = Number(bytesLine.slice("env-bytes=".length));
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255 || !Number.isSafeInteger(envBytes) || envBytes < 0 || offset + envBytes > report.length) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport metadata is invalid");
  }
  const envBlock = report.subarray(offset, offset + envBytes);
  offset += envBytes;
  const endMarker = Buffer.from("__POSIXLOOM_REPORT_END\n");
  if (!report.subarray(offset, offset + endMarker.length).equals(endMarker)) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport end marker is missing");
  }
  if (offset + endMarker.length !== report.length) throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport contains trailing data");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cwd64)) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport cwd is not canonical Base64");
  }
  const cwdBytes = Buffer.from(cwd64, "base64");
  if (cwdBytes.toString("base64") !== cwd64) throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport cwd is not canonical Base64");
  let cwd: string;
  try {
    cwd = new TextDecoder("utf-8", { fatal: true }).decode(cwdBytes);
  } catch (error) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport cwd is not valid UTF-8", { cause: String(error) });
  }
  const exportedEnv: Record<string, string> = {};
  const sourceKeys = new Map<string, string>();
  let envText: string;
  try {
    envText = new TextDecoder("utf-8", { fatal: true }).decode(envBlock);
  } catch (error) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport environment is not valid UTF-8", { cause: String(error) });
  }
  for (const entry of envText.split("\0")) {
    if (!entry) continue;
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    const sourceKey = entry.slice(0, equals);
    const key = canonicalEnvKey(sourceKey);
    const prior = sourceKeys.get(key);
    if (prior) throw new PosixLoomError("STATE_PROTOCOL_FAILED", `StateReport environment keys are duplicated or collide on Windows: ${prior} / ${sourceKey}`);
    sourceKeys.set(key, sourceKey);
    exportedEnv[key] = entry.slice(equals + 1);
  }
  return { exitCode, cwd, exportedEnv };
}
