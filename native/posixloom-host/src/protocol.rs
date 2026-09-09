use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;

/// v1 帧协议版本号。hello 事件与 exec/control 请求帧都必须携带该值，
/// 任一端不匹配即拒绝；修改它属于不兼容的协议变更，需与 TS 侧同步演进。
pub(crate) const PROTOCOL_VERSION: u32 = 1;
/// 单帧字节上限（16MB），对请求帧与事件帧双向生效：既为 stdout/stderr 的
/// 大块输出留出余量，又封顶了恶意/异常长度前缀可能触发的内存分配，
/// 是协议层的资源耗尽防护。
pub(crate) const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// 交互控制与待写终端输入各自最多缓存的事件数。单个 input 帧上限 64 KiB，
/// 两级有界通道把宿主内部积压限制在约 2 MiB，并把背压传回控制端管道。
pub(crate) const MAX_PENDING_INTERACTIVE_EVENTS: usize = 16;

/// 控制端发来的 exec 请求帧（stdin 上的首帧，JSON 反序列化目标）。
/// 注意 env 是“完整环境”而非增量：宿主自身的环境变量不会泄漏给子进程。
#[derive(Debug, Deserialize)]
pub(crate) struct ExecRequest {
    /// 协议版本，必须精确等于 PROTOCOL_VERSION。
    #[serde(rename = "protocolVersion")]
    pub(crate) protocol_version: u32,
    /// 请求类型，v1 仅支持 "exec"。
    #[serde(rename = "type")]
    pub(crate) kind: String,
    /// 待运行的程序。Windows 侧直接作为 CreateProcessW 的 lpApplicationName
    /// 传入（不经 shell 解释），因此没有命令注入面，也无需引用。
    pub(crate) program: String,
    /// 命令行参数，Windows 侧按 MSVCRT 规则精确引用后拼接为命令行。
    pub(crate) args: Vec<String>,
    /// 子进程工作目录，必须非空。
    pub(crate) cwd: String,
    /// 子进程的完整环境变量表。
    pub(crate) env: BTreeMap<String, String>,
    /// 超时毫秒数，缺省取 default_timeout；必须大于 0。
    #[serde(rename = "timeoutMs", default = "default_timeout")]
    pub(crate) timeout_ms: u64,
    /// Windows-only coordination key for the shared MSYS installation mount table.
    #[serde(rename = "shellNamespace")]
    pub(crate) shell_namespace: Option<String>,
    /// base64 编码的 stdin 初始载荷；None 表示不向子进程写入任何字节。
    #[serde(rename = "inputBase64")]
    pub(crate) input_base64: Option<String>,
    /// true 时使用 Windows ConPTY；非 Windows 宿主会显式拒绝。
    #[serde(default)]
    pub(crate) tty: bool,
    /// 伪终端初始字符列/行数。
    pub(crate) columns: Option<u16>,
    pub(crate) rows: Option<u16>,
}

/// 运行期间从 stdin 持续读取的控制帧；v1 只定义了 "cancel" 一种，
/// 用于协作式取消当前 CommandJob。
#[derive(Debug, Deserialize)]
pub(crate) struct ControlRequest {
    /// 协议版本，必须等于 PROTOCOL_VERSION。
    #[serde(rename = "protocolVersion")]
    pub(crate) protocol_version: u32,
    /// 帧类型；合法值为 "cancel"。
    #[serde(rename = "type")]
    pub(crate) kind: String,
    /// input 帧的规范 Base64 字节。
    pub(crate) data: Option<String>,
    /// resize 帧的新字符列/行数。
    pub(crate) columns: Option<u16>,
    pub(crate) rows: Option<u16>,
}

/// stdin 监听线程传给执行后端的运行期控制。
pub(crate) enum RuntimeControl {
    Input(Vec<u8>),
    Resize(u16, u16),
    Eof,
}

/// timeoutMs 字段的缺省值（30 秒），与 TS 侧 process.ts 的默认值保持一致。
pub(crate) fn default_timeout() -> u64 {
    30_000
}

/// 宿主发往控制端（stdout）的事件帧。可选字段按事件类型只携带相关子集
/// （skip_serializing_if 保证缺省字段不出现在 JSON 里），让不同事件在
/// 协议线上保持最小形态，控制端可据此做严格的形态校验。
#[derive(Debug, Serialize)]
pub(crate) struct Event {
    /// 固定为 PROTOCOL_VERSION，控制端据此确认对端身份。
    #[serde(rename = "protocolVersion")]
    pub(crate) protocol_version: u32,
    /// 事件类型：hello / started / stdout / stderr / exit / error。
    #[serde(rename = "type")]
    pub(crate) kind: String,
    /// started 事件携带的子进程 PID。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pid: Option<u32>,
    /// stdout/stderr 事件携带的 base64 编码字节流。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) data: Option<String>,
    /// exit 事件携带的退出码。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) code: Option<i32>,
    /// exit 事件携带的结局标签：exited / cancelled / timed-out / crashed。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) outcome: Option<String>,
    /// error 事件携带的人读错误信息。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
    /// hello 事件携带的单帧上限，控制端据此在发送前自行限流。
    #[serde(rename = "maxFrameBytes", skip_serializing_if = "Option::is_none")]
    pub(crate) max_frame_bytes: Option<usize>,
    /// Optional negotiated features; old controllers may ignore this field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) capabilities: Option<Vec<String>>,
}

impl Event {
    /// 以指定事件类型构造骨架事件，可选字段全部置 None，
    /// 由各 send_* 辅助函数按需填充。
    pub(crate) fn new(kind: &str) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            kind: kind.to_string(),
            pid: None,
            data: None,
            code: None,
            outcome: None,
            message: None,
            max_frame_bytes: None,
            capabilities: None,
        }
    }
}

/// 按 v1 帧格式写出事件：4 字节小端长度前缀 + JSON 载荷。
/// 写出前先检查长度上限，超限直接报错而不是默默截断，让协议错误显式化；
/// 写完立即 flush，保证流式事件实时到达控制端。
pub(crate) fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), String> {
    let payload = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    // 上限检查放在写出之前：帧头一旦写出就没有回头路。
    if payload.len() > MAX_FRAME_BYTES {
        return Err(format!("frame exceeds {MAX_FRAME_BYTES} bytes"));
    }
    writer
        .write_all(&(payload.len() as u32).to_le_bytes())
        .and_then(|_| writer.write_all(&payload))
        .and_then(|_| writer.flush())
        .map_err(|error| error.to_string())
}

/// 从 reader 读取一个 v1 帧（4 字节小端长度 + JSON 载荷）并反序列化为 T。
/// 长度超过 MAX_FRAME_BYTES 时在读载荷之前就拒绝，避免一个恶意/损坏的
/// 长度前缀触发巨大的堆分配（资源耗尽防护）。
pub(crate) fn read_frame<R: Read, T: DeserializeOwned>(reader: &mut R) -> Result<T, String> {
    let mut header = [0u8; 4];
    reader
        .read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    let length = u32::from_le_bytes(header) as usize;
    // 先校验长度再分配缓冲：分配发生在信任边界之外的数据被验证之后。
    if length > MAX_FRAME_BYTES {
        return Err(format!("frame exceeds {MAX_FRAME_BYTES} bytes"));
    }
    let mut payload = vec![0u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&payload).map_err(|error| error.to_string())
}

/// 把事件帧写到本进程 stdout。写失败（通常是控制端已断开）时立即退出进程：
/// 宿主一死，其 kill-on-close Job Object 会被内核关闭，整棵子进程树随之
/// 终止--这是防止孤儿进程的关键兜底路径（见下方英文注释）。
pub(crate) fn send_event(event: Event) {
    let mut stdout = std::io::stdout().lock();
    if write_frame(&mut stdout, &event).is_err() {
        // A disconnected controller must not leave this host (and therefore its
        // kill-on-close Job Object) alive with an orphaned child process.
        std::process::exit(1);
    }
}

/// 发送 error 终态事件，附人读错误描述。协议约定 error 之后不再有其他事件。
pub(crate) fn send_error(message: impl Into<String>) {
    let mut event = Event::new("error");
    event.message = Some(message.into());
    send_event(event);
}

/// 发送 started 事件，向控制端公布子进程 PID。
pub(crate) fn send_started(pid: u32) {
    let mut event = Event::new("started");
    event.pid = Some(pid);
    send_event(event);
}

/// 把一段 stdout/stderr 原始字节以 base64 编码后作为流式事件发出；
/// base64 让任意二进制输出都能安全地放进 JSON 帧。
pub(crate) fn send_stream(kind: &str, bytes: &[u8]) {
    let mut event = Event::new(kind);
    event.data = Some(BASE64.encode(bytes));
    send_event(event);
}

/// 发送终态 exit 事件（退出码 + 结局标签）。
pub(crate) fn send_exit(code: i32, outcome: &str) {
    let mut event = Event::new("exit");
    event.code = Some(code);
    event.outcome = Some(outcome.to_string());
    send_event(event);
}

/// 解码请求中的 inputBase64 字段；缺省表示空输入（不向子进程写任何字节）。
/// 解码失败按协议错误上报，绝不静默丢弃用户输入。
pub(crate) fn decode_input(value: Option<String>) -> Result<Vec<u8>, String> {
    match value {
        Some(encoded) => BASE64
            .decode(encoded)
            .map_err(|error| format!("invalid inputBase64: {error}")),
        None => Ok(Vec::new()),
    }
}

/// 对 exec 请求做逐字段协议校验，任何一条不满足都返回错误。这里防的是
/// “畸形输入在进入 Win32 API 之前就把宿主打崩或骗过”：
///   - 协议版本与请求类型必须精确匹配（防不同协议版本的帧被误接）；
///   - program/cwd/args/env 中的 NUL 会截断底层 UTF-16 API 的字符串，
///     相当于绕过长度校验注入额外内容，必须提前拒绝；
///   - 环境键不允许为空或包含 '='（否则会被环境块解析器重新切分键值）；
///   - Windows 环境变量名不区分大小写，大小写变体的重复键在
///     CreateProcessW 后行为不确定，这里显式拒绝以保持确定性。
pub(crate) fn validate_exec_request(request: &ExecRequest) -> Result<(), String> {
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(format!("protocol mismatch: {}", request.protocol_version));
    }
    if request.kind != "exec" {
        return Err("unsupported request type".to_string());
    }
    if request.program.is_empty() || request.program.contains('\0') {
        return Err("program must be a non-empty string without NUL".to_string());
    }
    if request.cwd.is_empty() || request.cwd.contains('\0') {
        return Err("cwd must be a non-empty string without NUL".to_string());
    }
    if request.timeout_ms == 0 {
        return Err("timeoutMs must be greater than zero".to_string());
    }
    if let Some(key) = &request.shell_namespace {
        if key.len() != 64
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(
                "shellNamespace must contain exactly 64 lowercase hexadecimal characters"
                    .to_string(),
            );
        }
    }
    if request.tty {
        match (request.columns, request.rows) {
            (Some(columns), Some(rows))
                if columns > 0 && rows > 0 && columns <= 32767 && rows <= 32767 => {}
            _ => return Err("tty requires columns and rows between 1 and 32767".to_string()),
        }
    } else if request.columns.is_some() || request.rows.is_some() {
        return Err("columns and rows require tty=true".to_string());
    }
    if request.args.iter().any(|argument| argument.contains('\0')) {
        return Err("arguments cannot contain NUL".to_string());
    }
    // 环境键按大写化去重：Windows 环境变量名不区分大小写，
    // "Path" 与 "PATH" 重复传入会产生未定义的覆盖顺序。
    let mut environment_keys = BTreeSet::new();
    for (key, value) in &request.env {
        if key.is_empty()
            || key
                .chars()
                .any(|character| character == '=' || character == '\0')
            || value.contains('\0')
        {
            return Err("environment contains an invalid key or NUL".to_string());
        }
        if !environment_keys.insert(key.to_uppercase()) {
            return Err("environment contains case-insensitive duplicate keys".to_string());
        }
    }
    Ok(())
}
