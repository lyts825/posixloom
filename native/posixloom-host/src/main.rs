// ============================================================================
// posixloom-host —— PosixLoom 原生宿主（crate posixloom-host，二进制名 posixloom）
//
// 本文件承载两个由 argv[1] 分派的、彼此独立的角色：
//
// 【角色 A：启动器（`posixloom launch`）】
//   在信任 Node 之前完成全部完整性验证，然后用校验过的 Node 运行打包的
//   dist/src/cli/main.js。把验证放在 Rust 侧而不是 TS 侧，是因为 TS 代码本身
//   就在被验证范围内：若先启动 Node 再自检，被篡改的 dist/ 完全可以在运行期
//   跳过校验逻辑，形成“用被审者审查被审者”的悖论。核心策略为 fail-closed：
//     - 一旦出现 SHA256SUMS、release 指针或 release 运行时目录三者之一，
//       即强制校验整个应用包（package.json、config/、dist/ 必须被清单哈希
//       精确覆盖；禁止符号链接与逃逸路径）；
//     - 存在 release 运行时却缺少 runtime/current 指针时，拒绝回退到
//       PATH 上的 node，防止环境注入的解释器绕过一切校验接管启动；
//     - release 运行时的 Node 可执行文件必须通过 manifest 声明的
//       SHA-256 校验后才会被使用。
//   恢复模式（runtime doctor/info/update/rollback）只放宽“如何挑一个可用运行时”，
//   不放宽完整性校验本身——修复坏指针的操作同样需要可信的应用包。
//
// 【角色 B：进程执行宿主（`posixloom __exec-host --protocol-v1`）】
//   与 TS 侧 process.ts 对偶的 v1 帧协议实现：4 字节小端长度前缀 + JSON 载荷，
//   单帧上限 MAX_FRAME_BYTES。事件序列固定为
//   hello -> started -> stdout/stderr* -> exit（或以 error 终态收尾）。
//   Windows 实现的关键设计：
//     - CREATE_SUSPENDED 创建进程 -> AssignProcessToJobObject -> ResumeThread，
//       保证子进程从第一条指令起就在 Job 管辖内，无法在入笼前逃逸；
//     - Job 设置 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE，宿主无论以何种方式退出，
//       内核都会终止整棵进程树——Windows 上没有可移植的进程组强杀语义，
//       Job Object 是保证“不留孤儿进程”的唯一可靠手段；
//     - 超时/取消通过 TerminateJobObject 强杀整棵树；取消为协作式信号
//       （控制端发 cancel 帧或直接关闭 stdin，宿主轮询原子标志位）。
//
// 文件布局：前半部分（main 之前）是角色 B 的协议层与执行后端；
// main 之后（launch 起）是角色 A 的运行时选择与完整性验证。
// ============================================================================

// 协议与哈希依赖：base64 负责 stdin 载荷与流式输出的编码，
// serde/serde_json 负责帧序列化，sha2 负责完整性校验。
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// v1 帧协议版本号。hello 事件与 exec/control 请求帧都必须携带该值，
/// 任一端不匹配即拒绝；修改它属于不兼容的协议变更，需与 TS 侧同步演进。
const PROTOCOL_VERSION: u32 = 1;
/// 单帧字节上限（16MB），对请求帧与事件帧双向生效：既为 stdout/stderr 的
/// 大块输出留出余量，又封顶了恶意/异常长度前缀可能触发的内存分配，
/// 是协议层的资源耗尽防护。
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// 控制端发来的 exec 请求帧（stdin 上的首帧，JSON 反序列化目标）。
/// 注意 env 是“完整环境”而非增量：宿主自身的环境变量不会泄漏给子进程。
#[derive(Debug, Deserialize)]
struct ExecRequest {
    /// 协议版本，必须精确等于 PROTOCOL_VERSION。
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    /// 请求类型，v1 仅支持 "exec"。
    #[serde(rename = "type")]
    kind: String,
    /// 待运行的程序。Windows 侧直接作为 CreateProcessW 的 lpApplicationName
    /// 传入（不经 shell 解释），因此没有命令注入面，也无需引用。
    program: String,
    /// 命令行参数，Windows 侧按 MSVCRT 规则精确引用后拼接为命令行。
    args: Vec<String>,
    /// 子进程工作目录，必须非空。
    cwd: String,
    /// 子进程的完整环境变量表。
    env: BTreeMap<String, String>,
    /// 超时毫秒数，缺省取 default_timeout；必须大于 0。
    #[serde(rename = "timeoutMs", default = "default_timeout")]
    timeout_ms: u64,
    /// base64 编码的 stdin 初始载荷；None 表示不向子进程写入任何字节。
    #[serde(rename = "inputBase64")]
    input_base64: Option<String>,
    /// true 时使用 Windows ConPTY；非 Windows 宿主会显式拒绝。
    #[serde(default)]
    tty: bool,
    /// 伪终端初始字符列/行数。
    columns: Option<u16>,
    rows: Option<u16>,
}

/// 运行期间从 stdin 持续读取的控制帧；v1 只定义了 "cancel" 一种，
/// 用于协作式取消当前 CommandJob。
#[derive(Debug, Deserialize)]
struct ControlRequest {
    /// 协议版本，必须等于 PROTOCOL_VERSION。
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    /// 帧类型；合法值为 "cancel"。
    #[serde(rename = "type")]
    kind: String,
    /// input 帧的规范 Base64 字节。
    data: Option<String>,
    /// resize 帧的新字符列/行数。
    columns: Option<u16>,
    rows: Option<u16>,
}

/// stdin 监听线程传给执行后端的运行期控制。
enum RuntimeControl {
    Input(Vec<u8>),
    Resize(u16, u16),
    Eof,
}

/// timeoutMs 字段的缺省值（30 秒），与 TS 侧 process.ts 的默认值保持一致。
fn default_timeout() -> u64 {
    30_000
}

/// 宿主发往控制端（stdout）的事件帧。可选字段按事件类型只携带相关子集
/// （skip_serializing_if 保证缺省字段不出现在 JSON 里），让不同事件在
/// 协议线上保持最小形态，控制端可据此做严格的形态校验。
#[derive(Debug, Serialize)]
struct Event {
    /// 固定为 PROTOCOL_VERSION，控制端据此确认对端身份。
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    /// 事件类型：hello / started / stdout / stderr / exit / error。
    #[serde(rename = "type")]
    kind: String,
    /// started 事件携带的子进程 PID。
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    /// stdout/stderr 事件携带的 base64 编码字节流。
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    /// exit 事件携带的退出码。
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
    /// exit 事件携带的结局标签：exited / cancelled / timed-out / crashed。
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    /// error 事件携带的人读错误信息。
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    /// hello 事件携带的单帧上限，控制端据此在发送前自行限流。
    #[serde(rename = "maxFrameBytes", skip_serializing_if = "Option::is_none")]
    max_frame_bytes: Option<usize>,
}

impl Event {
    /// 以指定事件类型构造骨架事件，可选字段全部置 None，
    /// 由各 send_* 辅助函数按需填充。
    fn new(kind: &str) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            kind: kind.to_string(),
            pid: None,
            data: None,
            code: None,
            outcome: None,
            message: None,
            max_frame_bytes: None,
        }
    }
}

/// 按 v1 帧格式写出事件：4 字节小端长度前缀 + JSON 载荷。
/// 写出前先检查长度上限，超限直接报错而不是默默截断，让协议错误显式化；
/// 写完立即 flush，保证流式事件实时到达控制端。
fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), String> {
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
fn read_frame<R: Read, T: DeserializeOwned>(reader: &mut R) -> Result<T, String> {
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
fn send_event(event: Event) {
    let mut stdout = std::io::stdout().lock();
    if write_frame(&mut stdout, &event).is_err() {
        // A disconnected controller must not leave this host (and therefore its
        // kill-on-close Job Object) alive with an orphaned child process.
        std::process::exit(1);
    }
}

/// 发送 error 终态事件，附人读错误描述。协议约定 error 之后不再有其他事件。
fn send_error(message: impl Into<String>) {
    let mut event = Event::new("error");
    event.message = Some(message.into());
    send_event(event);
}

/// 发送 started 事件，向控制端公布子进程 PID。
fn send_started(pid: u32) {
    let mut event = Event::new("started");
    event.pid = Some(pid);
    send_event(event);
}

/// 把一段 stdout/stderr 原始字节以 base64 编码后作为流式事件发出；
/// base64 让任意二进制输出都能安全地放进 JSON 帧。
fn send_stream(kind: &str, bytes: &[u8]) {
    let mut event = Event::new(kind);
    event.data = Some(BASE64.encode(bytes));
    send_event(event);
}

/// 发送终态 exit 事件（退出码 + 结局标签）。
fn send_exit(code: i32, outcome: &str) {
    let mut event = Event::new("exit");
    event.code = Some(code);
    event.outcome = Some(outcome.to_string());
    send_event(event);
}

/// 解码请求中的 inputBase64 字段；缺省表示空输入（不向子进程写任何字节）。
/// 解码失败按协议错误上报，绝不静默丢弃用户输入。
fn decode_input(value: Option<String>) -> Result<Vec<u8>, String> {
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
fn validate_exec_request(request: &ExecRequest) -> Result<(), String> {
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

/// Windows 执行后端。与 unix_exec 暴露同名 execute 入口，但用 Win32 API
/// 手工搭建管道与进程，以换取三个 std::process 给不了的性质：
///   - 精确的 argv 引用（CreateProcessW 的命令行是单一字符串，必须自己转义）；
///   - Job Object 的进程树级强杀与 kill-on-close 兜底；
///   - CREATE_SUSPENDED -> AssignProcessToJobObject -> ResumeThread 的
///     “先入笼、再放行”窗口，杜绝子进程在加入 Job 之前启动。
#[cfg(windows)]
mod windows_exec {
    use super::*;
    use std::ffi::OsStr;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::System::Console::{
        ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES,
        STARTUPINFOEXW, STARTUPINFOW,
    };

    /// 把 UTF-8 字符串编码为 NUL 结尾的 UTF-16 宽字符向量，
    /// 供所有 *W 系列 Win32 API 直接使用。
    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// 按 MSVCRT argv 解析规则精确引用单个参数。CreateProcessW 的命令行是
    /// 一整条字符串，如何切分由子进程的 CRT 决定，引用规则是：
    ///   - 不含空白、引号、反斜杠的参数原样输出（最常见快路径）；
    ///   - 其余参数整体加双引号；双引号前按“前导反斜杠数 * 2 + 1”转义
    ///     （反斜杠只在紧邻引号时才有转义含义，偶数个保持字面量）；
    ///   - 末尾连续反斜杠因紧邻收尾引号，同样需要翻倍。
    /// 引用一旦出错参数边界就会漂移，这是 Windows 上最经典的命令注入来源，
    /// 因此本函数被设计为纯函数并有独立单元测试覆盖。
    fn quote_arg(value: &str) -> String {
        if !value.is_empty()
            && !value
                .chars()
                .any(|c| c.is_whitespace() || "\"\\".contains(c))
        {
            return value.to_string();
        }
        let mut out = String::from("\"");
        let mut slashes = 0usize;
        for ch in value.chars() {
            if ch == '\\' {
                slashes += 1;
                continue;
            }
            if ch == '"' {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
                continue;
            }
            out.push_str(&"\\".repeat(slashes));
            out.push(ch);
            slashes = 0;
        }
        out.push_str(&"\\".repeat(slashes * 2));
        out.push('"');
        out
    }

    /// 把环境映射构建为 CreateProcessW 需要的 UTF-16 环境块：
    /// 各条 "KEY=VALUE\0" 顺序排列，块尾再补一个额外的 \0。
    /// 条目按大写化排序，保证同一份环境生成的块字节级可复现，
    /// 也规避了 Windows 对大小写不敏感环境键的排序歧义。
    fn env_block(env: &BTreeMap<String, String>) -> Vec<u16> {
        let mut entries: Vec<String> = env
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect();
        entries.sort_by_key(|entry| entry.to_ascii_uppercase());
        if entries.is_empty() {
            // 空环境也必须保留双 NUL 终止符，这是环境块的最小合法形态。
            return vec![0, 0];
        }
        let mut result = Vec::new();
        for entry in entries {
            result.extend(OsStr::new(&entry).encode_wide());
            result.push(0);
        }
        result.push(0);
        result
    }

    /// Job Object 的 RAII 包装：析构时关闭句柄。配合构造阶段设置的
    /// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE，句柄一关内核就会终止整棵进程树--
    /// 即使宿主 panic 或被强杀也能兜底，不留下孤儿进程。
    struct Job(HANDLE);
    impl Drop for Job {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    /// Win32 HANDLE 的通用 RAII 包装；转交给 File 时用 take 避免双重关闭。
    struct OwnedHandle(HANDLE);
    impl OwnedHandle {
        fn take(&mut self) -> HANDLE {
            std::mem::replace(&mut self.0, std::ptr::null_mut())
        }
    }
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    /// ConPTY 句柄的 RAII 包装。ClosePseudoConsole 可能产生最后一段终端输出，
    /// 因此输出排水线程必须在关闭前已经运行。
    struct PseudoConsole(HPCON);
    impl Drop for PseudoConsole {
        fn drop(&mut self) {
            if self.0 != 0 {
                unsafe { ClosePseudoConsole(self.0) };
            }
        }
    }

    /// 在独立线程上持续读取一条输出管道，按 32KB 块逐段转发为流式事件，
    /// 返回“结束信号”接收端供主循环做有界等待。读错误一律按流结束处理：
    /// 管道破裂后继续等待只会永久阻塞排水线程。
    fn emit_stream<R: Read + Send + 'static>(
        mut stream: R,
        kind: &'static str,
    ) -> std::sync::mpsc::Receiver<()> {
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 32 * 1024];
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => send_stream(kind, &buffer[..size]),
                    Err(_) => break,
                }
            }
            let _ = finished_tx.send(());
        });
        finished_rx
    }

    /// Windows ConPTY 执行路径：终端输出是一条包含 VT/ANSI 序列的合并字节流，
    /// 统一以 stdout 事件转发。运行期 input/resize/eof 通过 controls 通道进入。
    fn execute_pty(
        request: ExecRequest,
        cancelled: Arc<AtomicBool>,
        controls: std::sync::mpsc::Receiver<RuntimeControl>,
    ) -> Result<(), String> {
        let initial_input = decode_input(request.input_base64.clone())?;
        let columns = request.columns.ok_or("tty columns are missing")?;
        let rows = request.rows.ok_or("tty rows are missing")?;

        let job = Job(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
        if job.0.is_null() {
            return Err(format!("CreateJobObjectW failed: {}", unsafe {
                GetLastError()
            }));
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *mut _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(format!("SetInformationJobObject failed: {}", unsafe {
                GetLastError()
            }));
        }

        // ConPTY 需要两条同步管道：输入 read 端和输出 write 端交给 HPCON，
        // 对端由本宿主的独立线程持续写/读，避免同步 IO 互相阻塞。
        let mut input_read_raw: HANDLE = std::ptr::null_mut();
        let mut input_write_raw: HANDLE = std::ptr::null_mut();
        let mut output_read_raw: HANDLE = std::ptr::null_mut();
        let mut output_write_raw: HANDLE = std::ptr::null_mut();
        if unsafe {
            CreatePipe(
                &mut input_read_raw,
                &mut input_write_raw,
                std::ptr::null(),
                0,
            )
        } == 0
        {
            return Err(format!("CreatePipe ConPTY input failed: {}", unsafe {
                GetLastError()
            }));
        }
        let input_read = OwnedHandle(input_read_raw);
        let mut input_write = OwnedHandle(input_write_raw);
        if unsafe {
            CreatePipe(
                &mut output_read_raw,
                &mut output_write_raw,
                std::ptr::null(),
                0,
            )
        } == 0
        {
            return Err(format!("CreatePipe ConPTY output failed: {}", unsafe {
                GetLastError()
            }));
        }
        let mut output_read = OwnedHandle(output_read_raw);
        let output_write = OwnedHandle(output_write_raw);

        let mut hpc: HPCON = 0;
        let create_pty = unsafe {
            CreatePseudoConsole(
                COORD {
                    X: columns as i16,
                    Y: rows as i16,
                },
                input_read.0,
                output_write.0,
                0,
                &mut hpc,
            )
        };
        if create_pty < 0 {
            return Err(format!(
                "CreatePseudoConsole failed: HRESULT 0x{:08x}",
                create_pty as u32
            ));
        }
        let pseudo = PseudoConsole(hpc);

        // STARTUPINFOEX 的 attribute list 使用双调用获取尺寸，并用 usize
        // 容器保证指针对齐。
        let mut attribute_bytes = 0usize;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attribute_bytes)
        };
        if attribute_bytes == 0 {
            return Err("InitializeProcThreadAttributeList did not report a size".to_string());
        }
        let words = (attribute_bytes + size_of::<usize>() - 1) / size_of::<usize>();
        let mut attribute_storage = vec![0usize; words];
        let attribute_list = attribute_storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_bytes) }
            == 0
        {
            return Err(format!(
                "InitializeProcThreadAttributeList failed: {}",
                unsafe { GetLastError() }
            ));
        }
        if unsafe {
            UpdateProcThreadAttribute(
                attribute_list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                hpc as *const std::ffi::c_void,
                size_of::<HPCON>(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
        {
            let error = unsafe { GetLastError() };
            unsafe { DeleteProcThreadAttributeList(attribute_list) };
            return Err(format!("UpdateProcThreadAttribute failed: {error}"));
        }

        let command_line = std::iter::once(quote_arg(&request.program))
            .chain(request.args.iter().map(|argument| quote_arg(argument)))
            .collect::<Vec<_>>()
            .join(" ");
        let mut command_w = wide(&command_line);
        let cwd_w = wide(&request.cwd);
        let mut environment = env_block(&request.env);
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        // Native Host 自身的 stdio 是与 Node 相连的协议管道。Windows 可能在
        // 创建 ConPTY 子进程时复制这些已重定向的标准句柄，导致用户输出
        // 绕过伪终端并破坏帧协议。显式启用 STARTF_USESTDHANDLES 且保持
        // hStd* 为 NULL，可禁止默认复制，随后由 PSEUDOCONSOLE attribute 建立终端句柄。
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.lpAttributeList = attribute_list;
        let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
        let created = unsafe {
            CreateProcessW(
                std::ptr::null(),
                command_w.as_mut_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                environment.as_mut_ptr() as *mut _,
                cwd_w.as_ptr(),
                &startup.StartupInfo,
                &mut process_info,
            )
        };
        let create_error = (created == 0).then(|| unsafe { GetLastError() });
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        // CreateProcess 完成后本进程不再需要传给 HPCON 的两个管道端，
        // 及时关闭才能让对端终止时正确观测到 broken pipe。
        drop(input_read);
        drop(output_write);
        if let Some(error) = create_error {
            return Err(format!("CreateProcessW ConPTY failed: {error}"));
        }

        if unsafe { AssignProcessToJobObject(job.0, process_info.hProcess) } == 0 {
            let error = unsafe { GetLastError() };
            unsafe {
                TerminateProcess(process_info.hProcess, 1);
                CloseHandle(process_info.hThread);
                CloseHandle(process_info.hProcess);
            }
            return Err(format!("AssignProcessToJobObject failed: {error}"));
        }
        let resumed = unsafe { ResumeThread(process_info.hThread) };
        let resume_error = (resumed == u32::MAX).then(|| unsafe { GetLastError() });
        unsafe { CloseHandle(process_info.hThread) };
        if let Some(error) = resume_error {
            unsafe {
                TerminateProcess(process_info.hProcess, 1);
                CloseHandle(process_info.hProcess);
            }
            return Err(format!("ResumeThread failed: {error}"));
        }
        send_started(process_info.dwProcessId);

        let output_finished = emit_stream(
            unsafe { std::fs::File::from_raw_handle(output_read.take() as _) },
            "stdout",
        );
        let (input_tx, input_rx) = std::sync::mpsc::channel::<Option<Vec<u8>>>();
        let (input_finished_tx, input_finished_rx) = std::sync::mpsc::channel();
        let input_write_value = input_write.take() as usize;
        std::thread::spawn(move || {
            let mut stream = unsafe { std::fs::File::from_raw_handle(input_write_value as _) };
            while let Ok(message) = input_rx.recv() {
                match message {
                    Some(bytes) => {
                        if stream.write_all(&bytes).is_err() || stream.flush().is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            let _ = input_finished_tx.send(());
        });
        let mut input_sender = Some(input_tx);
        if !initial_input.is_empty() {
            let _ = input_sender.as_ref().unwrap().send(Some(initial_input));
        }

        let started = Instant::now();
        let mut control_error: Option<String> = None;
        let outcome = loop {
            while let Ok(control) = controls.try_recv() {
                match control {
                    RuntimeControl::Input(bytes) => {
                        if let Some(sender) = input_sender.as_ref() {
                            if sender.send(Some(bytes)).is_err() {
                                control_error = Some("ConPTY input channel closed".to_string());
                                break;
                            }
                        }
                    }
                    RuntimeControl::Resize(new_columns, new_rows) => {
                        let result = unsafe {
                            ResizePseudoConsole(
                                pseudo.0,
                                COORD {
                                    X: new_columns as i16,
                                    Y: new_rows as i16,
                                },
                            )
                        };
                        if result < 0 {
                            control_error = Some(format!(
                                "ResizePseudoConsole failed: HRESULT 0x{:08x}",
                                result as u32
                            ));
                            break;
                        }
                    }
                    RuntimeControl::Eof => {
                        // 不直接关闭 ConPTY 输入管道：Windows 会把连接断开解释为
                        // console close/CTRL_C，子进程可能以 0xC000013A 异常终止。
                        // Ctrl+Z 是 Windows 控制台的文本 EOF 键，既能让行模式程序观测
                        // EOF，又不会拆掉伪终端会话。
                        if let Some(sender) = input_sender.as_ref() {
                            let _ = sender.send(Some(vec![0x1a]));
                        }
                    }
                }
            }
            if control_error.is_some() {
                unsafe { TerminateJobObject(job.0, 1) };
                break "crashed";
            }
            let wait = unsafe { WaitForSingleObject(process_info.hProcess, 50) };
            if wait == 0 {
                break "exited";
            }
            if cancelled.load(Ordering::SeqCst) {
                unsafe { TerminateJobObject(job.0, 130) };
                break "cancelled";
            }
            if started.elapsed() >= Duration::from_millis(request.timeout_ms) {
                unsafe { TerminateJobObject(job.0, 124) };
                break "timed-out";
            }
            if wait == u32::MAX {
                unsafe { TerminateJobObject(job.0, 1) };
                break "crashed";
            }
        };
        if outcome == "exited" {
            unsafe { TerminateJobObject(job.0, 0) };
        }
        unsafe { WaitForSingleObject(process_info.hProcess, 5000) };
        if let Some(sender) = input_sender.take() {
            let _ = sender.send(None);
        }

        let mut exit_code = 1u32;
        let exit_code_ok = unsafe { GetExitCodeProcess(process_info.hProcess, &mut exit_code) };
        let exit_code_error = (exit_code_ok == 0).then(|| unsafe { GetLastError() });
        unsafe { CloseHandle(process_info.hProcess) };
        // 输出线程已在独立线程持续排水，此时关闭 HPCON 以便它收到最终 EOF。
        drop(pseudo);
        let _ = input_finished_rx.recv_timeout(Duration::from_secs(2));
        let _ = output_finished.recv_timeout(Duration::from_secs(2));
        if let Some(error) = exit_code_error {
            return Err(format!("GetExitCodeProcess failed: {error}"));
        }
        if let Some(error) = control_error {
            return Err(error);
        }
        if outcome == "timed-out" {
            exit_code = 124;
        } else if outcome == "cancelled" {
            exit_code = 130;
        }
        send_exit(exit_code as i32, outcome);
        Ok(())
    }

    /// 执行一次 CommandJob 的完整生命周期：
    ///   1. 解码 stdin 初始载荷；
    ///   2. 创建启用 KILL_ON_JOB_CLOSE 的 Job Object（进程树管理锚点）；
    ///   3. 建三条匿名管道，子进程端可继承、宿主端显式关闭继承；
    ///   4. CREATE_SUSPENDED 启动子进程 -> AssignProcessToJobObject -> ResumeThread；
    ///   5. 后台线程写 stdin、排空并转发 stdout/stderr；
    ///   6. 主循环 50ms 轮询：正常退出 / 协作取消 / 超时 / 等待调用失败；
    ///   7. 终态收尾：强杀残余子进程、有界等待排水线程、读退出码、发 exit 事件。
    /// 任一阶段失败都显式释放已创建的句柄并返回错误（错误帧 + 退出码 1），
    /// 保证没有句柄泄漏、没有进程逃出 Job。
    fn execute_pipe(request: ExecRequest, cancelled: Arc<AtomicBool>) -> Result<(), String> {
        if request.kind != "exec" {
            return Err("unsupported request type".to_string());
        }
        if request.protocol_version != PROTOCOL_VERSION {
            return Err(format!("protocol mismatch: {}", request.protocol_version));
        }
        let input = decode_input(request.input_base64)?;
        // 创建 Job Object：后续所有进程树级强杀（超时/取消/收尾）都通过它完成。
        let job = Job(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
        if job.0.is_null() {
            return Err(format!("CreateJobObjectW failed: {}", unsafe {
                GetLastError()
            }));
        }
        // KILL_ON_JOB_CLOSE：宿主进程无论正常退出、panic 还是被外部杀死，
        // Job 的最后一个句柄都会被内核关闭并终止整棵进程树--防孤儿进程的兜底。
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set_ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *mut _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set_ok == 0 {
            return Err(format!("SetInformationJobObject failed: {}", unsafe {
                GetLastError()
            }));
        }

        // 三条匿名管道（stdin/stdout/stderr）。bInheritHandle 让子进程端句柄
        // 可以传给 CreateProcessW；每个失败分支都手动关闭已创建的句柄，
        // 防止句柄泄漏导致输出管道永远等不到 EOF。
        let mut security: SECURITY_ATTRIBUTES = unsafe { zeroed() };
        security.nLength = size_of::<SECURITY_ATTRIBUTES>() as u32;
        security.bInheritHandle = 1;
        let mut stdin_read: HANDLE = std::ptr::null_mut();
        let mut stdin_write: HANDLE = std::ptr::null_mut();
        let mut stdout_read: HANDLE = std::ptr::null_mut();
        let mut stdout_write: HANDLE = std::ptr::null_mut();
        let mut stderr_read: HANDLE = std::ptr::null_mut();
        let mut stderr_write: HANDLE = std::ptr::null_mut();
        if unsafe { CreatePipe(&mut stdin_read, &mut stdin_write, &security, 0) } == 0 {
            return Err("CreatePipe stdin failed".into());
        }
        if unsafe { CreatePipe(&mut stdout_read, &mut stdout_write, &security, 0) } == 0 {
            unsafe {
                CloseHandle(stdin_read);
                CloseHandle(stdin_write)
            };
            return Err("CreatePipe stdout failed".into());
        }
        if unsafe { CreatePipe(&mut stderr_read, &mut stderr_write, &security, 0) } == 0 {
            unsafe {
                CloseHandle(stdin_read);
                CloseHandle(stdin_write);
                CloseHandle(stdout_read);
                CloseHandle(stdout_write);
            }
            return Err("CreatePipe stderr failed".into());
        }
        // 宿主侧的三个管道端点必须清除继承标志：只有传给子进程的三个端点
        // 允许被继承，否则宿主后续再创建子进程时会把旧管道句柄一并带下去。
        for handle in [stdin_write, stdout_read, stderr_read] {
            if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
                let error = unsafe { GetLastError() };
                unsafe {
                    CloseHandle(stdin_read);
                    CloseHandle(stdin_write);
                    CloseHandle(stdout_read);
                    CloseHandle(stdout_write);
                    CloseHandle(stderr_read);
                    CloseHandle(stderr_write);
                }
                return Err(format!("SetHandleInformation failed: {error}"));
            }
        }

        // 按 MSVCRT 规则逐参数精确引用后拼成单一命令行字符串（见 quote_arg）。
        let command_line = std::iter::once(quote_arg(&request.program))
            .chain(request.args.iter().map(|argument| quote_arg(argument)))
            .collect::<Vec<_>>()
            .join(" ");
        let mut command_w = wide(&command_line);
        let program_w = wide(&request.program);
        let cwd_w = wide(&request.cwd);
        let mut environment = env_block(&request.env);
        // STARTF_USESTDHANDLES：把三条管道指定为子进程的标准句柄。
        let mut startup: STARTUPINFOW = unsafe { zeroed() };
        startup.cb = size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = stdin_read;
        startup.hStdOutput = stdout_write;
        startup.hStdError = stderr_write;
        let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
        // CREATE_SUSPENDED：进程创建即挂起，等 AssignProcessToJobObject 成功后
        // 才 ResumeThread--保证子进程从第一条指令起就处于 Job 管辖内，
        // 不会出现“先跑起来、再入笼”的窗口。CREATE_NO_WINDOW 避免弹出
        // 额外控制台窗口；环境块按 UTF-16 传递（CREATE_UNICODE_ENVIRONMENT）。
        let created = unsafe {
            CreateProcessW(
                program_w.as_ptr(),
                command_w.as_mut_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                environment.as_mut_ptr() as *mut _,
                cwd_w.as_ptr(),
                &startup,
                &mut process_info,
            )
        };
        // 先取出错误码再关句柄：GetLastError 会被任何后续 API 调用覆盖。
        // 无论创建成败都关闭父进程持有的子进程侧端点，否则管道读不到 EOF。
        let create_error = (created == 0).then(|| unsafe { GetLastError() });
        unsafe {
            CloseHandle(stdin_read);
            CloseHandle(stdout_write);
            CloseHandle(stderr_write);
        }
        if let Some(error) = create_error {
            unsafe {
                CloseHandle(stdin_write);
                CloseHandle(stdout_read);
                CloseHandle(stderr_read);
            }
            return Err(format!("CreateProcessW failed: {error}"));
        }
        // 把挂起中的进程加入 Job。失败则只能直接终止它：绝不能放一个
        // 不受 Job 管辖的进程开始运行（那正是要防的逃逸窗口）。
        let assigned = unsafe { AssignProcessToJobObject(job.0, process_info.hProcess) };
        if assigned == 0 {
            let error = unsafe { GetLastError() };
            unsafe {
                TerminateProcess(process_info.hProcess, 1);
                CloseHandle(process_info.hThread);
                CloseHandle(process_info.hProcess);
                CloseHandle(stdin_write);
                CloseHandle(stdout_read);
                CloseHandle(stderr_read);
            }
            return Err(format!("AssignProcessToJobObject failed: {error}"));
        }
        // 进程已入笼，现在才放行主线程，让它真正开始执行。
        let resumed = unsafe { ResumeThread(process_info.hThread) };
        let resume_error = (resumed == u32::MAX).then(|| unsafe { GetLastError() });
        unsafe { CloseHandle(process_info.hThread) };
        if let Some(error) = resume_error {
            unsafe {
                TerminateProcess(process_info.hProcess, 1);
                CloseHandle(process_info.hProcess);
                CloseHandle(stdin_write);
                CloseHandle(stdout_read);
                CloseHandle(stderr_read);
            }
            return Err(format!("ResumeThread failed: {error}"));
        }
        // 子进程已在 Job 管辖内开始运行，此刻才向控制端公布 PID。
        send_started(process_info.dwProcessId);
        // stdin 写入放在独立线程：子进程不读 stdin 时 write_all 可能永久阻塞，
        // 不能让它卡住主循环的取消/超时判定。
        let stdin_write_value = stdin_write as usize;
        let (stdin_finished_tx, stdin_finished_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut stream = unsafe { std::fs::File::from_raw_handle(stdin_write_value as _) };
            let _ = stream.write_all(&input);
            let _ = stdin_finished_tx.send(());
        });
        // stdout/stderr 各起一个排水线程，边读边转发为流式事件。
        let stdout_finished = emit_stream(
            unsafe { std::fs::File::from_raw_handle(stdout_read as _) },
            "stdout",
        );
        let stderr_finished = emit_stream(
            unsafe { std::fs::File::from_raw_handle(stderr_read as _) },
            "stderr",
        );
        let started = Instant::now();
        // 主循环：50ms 轮询一次，兼顾取消/超时的响应速度与 CPU 占用。
        // 四种结局：正常退出（WAIT_OBJECT_0）、协作取消、超时、等待调用本身失败。
        // 取消/超时用 TerminateJobObject 强杀整棵进程树（对齐退出码 130/124）。
        let outcome = loop {
            let wait = unsafe { WaitForSingleObject(process_info.hProcess, 50) };
            if wait == 0 {
                break "exited";
            }
            if cancelled.load(Ordering::SeqCst) {
                unsafe { TerminateJobObject(job.0, 130) };
                break "cancelled";
            }
            if started.elapsed() >= Duration::from_millis(request.timeout_ms) {
                unsafe { TerminateJobObject(job.0, 124) };
                break "timed-out";
            }
            if wait == u32::MAX {
                unsafe { TerminateJobObject(job.0, 1) };
                break "crashed";
            }
        };
        if outcome == "exited" {
            // Detached/background lifetime is not part of protocol v1. Once
            // the primary process exits, close out any descendants before
            // draining pipes so no stream frame can arrive after `exit`.
            unsafe { TerminateJobObject(job.0, 0) };
        }
        // 等待（可能刚被强杀的）主进程彻底退出并沉淀最终退出码。
        unsafe { WaitForSingleObject(process_info.hProcess, 5000) };
        // A child may leave a descendant holding the inherited read handle or
        // never consume a large stdin payload. Never let that writer prevent
        // the host from reaching the terminal event and dropping its Job.
        let _ = stdin_finished_rx.recv_timeout(Duration::from_secs(2));
        // Some Windows console helpers keep inherited pipe handles open briefly. Do not let
        // output-drain bookkeeping outlive the CommandJob indefinitely.
        let _ = stdout_finished.recv_timeout(Duration::from_secs(2));
        let _ = stderr_finished.recv_timeout(Duration::from_secs(2));
        let mut exit_code = 1u32;
        let exit_code_ok = unsafe { GetExitCodeProcess(process_info.hProcess, &mut exit_code) };
        let exit_code_error = (exit_code_ok == 0).then(|| unsafe { GetLastError() });
        unsafe {
            CloseHandle(process_info.hProcess);
        }
        if let Some(error) = exit_code_error {
            return Err(format!("GetExitCodeProcess failed: {error}"));
        }
        // 超时/取消时统一改写退出码：124 对齐 GNU timeout 约定，
        // 130 对齐 128 + SIGINT；控制端以 exit(code) + outcome 组合做最终判定。
        if outcome == "timed-out" {
            exit_code = 124;
        } else if outcome == "cancelled" {
            exit_code = 130;
        }
        send_exit(exit_code as i32, outcome);
        Ok(())
    }

    /// 按 exec 请求选择普通管道或 ConPTY 后端。
    pub fn execute(
        request: ExecRequest,
        cancelled: Arc<AtomicBool>,
        controls: std::sync::mpsc::Receiver<RuntimeControl>,
    ) -> Result<(), String> {
        if request.tty {
            execute_pty(request, cancelled, controls)
        } else {
            drop(controls);
            execute_pipe(request, cancelled)
        }
    }

    // 纯函数单元测试：argv 引用规则与环境块构造，不涉及真实进程。
    #[cfg(test)]
    mod tests {
        use super::*;

        // 参数引用必须保持边界：空参数、含空格、含引号各有不同转义形态。
        #[test]
        fn windows_argument_quoting_preserves_boundaries() {
            assert_eq!(quote_arg("plain"), "plain");
            assert_eq!(quote_arg(""), "\"\"");
            assert_eq!(quote_arg("a b"), "\"a b\"");
            assert_eq!(quote_arg("a\"b"), "\"a\\\"b\"");
        }

        // 空环境块必须以双 NUL 结尾，这是 CreateProcessW 的合法下界。
        #[test]
        fn empty_environment_has_double_nul() {
            assert_eq!(env_block(&BTreeMap::new()), vec![0, 0]);
        }
    }
}

/// 非 Windows 平台的执行后端（开发/CI 用）。语义与 Windows 侧对齐：
/// 超时退出码 124、取消退出码 130、stdout/stderr 流式转发、stdin 写入
/// 放独立线程。用 std::process 即可实现；注意 Unix 上 child.kill 只作用于
/// 直接子进程，树级强杀在 v1 中是 Windows 侧的专属保证。
#[cfg(not(windows))]
mod unix_exec {
    use super::*;
    use std::process::Stdio;

    /// 与 windows_exec::execute 同构的 Unix 实现：spawn 后轮询 try_wait，
    /// 期间响应协作取消与超时；三路 IO 各占一个线程，最后 join 排水
    /// 线程保证 exit 之前所有流式事件都已发出。
    pub fn execute(
        request: ExecRequest,
        cancelled: Arc<AtomicBool>,
        controls: std::sync::mpsc::Receiver<RuntimeControl>,
    ) -> Result<(), String> {
        if request.kind != "exec" || request.protocol_version != PROTOCOL_VERSION {
            return Err("unsupported request or protocol version".to_string());
        }
        if request.tty {
            return Err(
                "PTY_UNAVAILABLE: pseudoconsole execution is only supported on Windows".to_string(),
            );
        }
        drop(controls);
        let input = decode_input(request.input_base64)?;
        let mut command = Command::new(&request.program);
        command
            .args(&request.args)
            .current_dir(&request.cwd)
            .envs(&request.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        send_started(child.id());
        let stdin = child
            .stdin
            .take()
            .map(|mut stream| std::thread::spawn(move || stream.write_all(&input)));
        let stdout = child
            .stdout
            .take()
            .map(|stream| std::thread::spawn(move || stream_bytes(stream, "stdout")));
        let stderr = child
            .stderr
            .take()
            .map(|stream| std::thread::spawn(move || stream_bytes(stream, "stderr")));
        let started = Instant::now();
        // 轮询循环：正常退出 / 协作取消 / 超时。try_wait 非阻塞，
        // sleep 25ms 控制轮询频率。
        let (code, outcome) = loop {
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                break (status.code().unwrap_or(1), "exited");
            }
            if cancelled.load(Ordering::SeqCst) {
                let _ = child.kill();
                break (130, "cancelled");
            }
            if started.elapsed() >= Duration::from_millis(request.timeout_ms) {
                let _ = child.kill();
                break (124, "timed-out");
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        let _ = child.wait();
        if let Some(thread) = stdin {
            let _ = thread.join();
        }
        if let Some(thread) = stdout {
            let _ = thread.join();
        }
        if let Some(thread) = stderr {
            let _ = thread.join();
        }
        send_exit(code, outcome);
        Ok(())
    }

    /// 排空一条输出管道，把读到的字节逐块（32KB）转发为流式事件；
    /// 读错误按流结束处理。
    fn stream_bytes<R: Read>(mut stream: R, kind: &'static str) {
        let mut buffer = [0u8; 32 * 1024];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => send_stream(kind, &buffer[..size]),
                Err(_) => break,
            }
        }
    }
}

/// 入口：按 argv[1] 分派两种角色。
///   - "launch"                       -> 角色 A 启动器（不返回）；
///   - "__exec-host --protocol-v1"    -> 角色 B 进程执行宿主；
///   - 其他（含缺省）                -> 打印用法并以退出码 2 结束。
/// 角色 B 的协议顺序固定：先发 hello（附 maxFrameBytes），再读 exec 请求，
/// 通过校验后启动取消监听线程，最后进入平台执行后端。
fn main() {
    let mode = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "help".to_string());
    if mode == "launch" {
        launch();
    }
    if mode != "__exec-host" || std::env::args().nth(2).as_deref() != Some("--protocol-v1") {
        // 协议标志必须精确匹配：这同时是防止本二进制被当普通程序误用的门闩。
        eprintln!(
            "posixloom-host: use __exec-host --protocol-v1 for the internal process protocol"
        );
        std::process::exit(2);
    }
    // 握手第一步：hello 事件声明协议版本与本端单帧上限。
    let mut hello = Event::new("hello");
    hello.max_frame_bytes = Some(MAX_FRAME_BYTES);
    send_event(hello);
    // 读取唯一一条 exec 请求帧；读取/解析失败立即发 error 并以退出码 1 终止。
    let request = {
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        match read_frame::<_, ExecRequest>(&mut input) {
            Ok(request) => request,
            Err(error) => {
                send_error(format!("invalid request: {error}"));
                std::process::exit(1);
            }
        }
    };
    if request.protocol_version != PROTOCOL_VERSION {
        // serde 反序列化不校验取值范围，协议版本在这里显式比对。
        send_error(format!("protocol mismatch: {}", request.protocol_version));
        std::process::exit(1);
    }
    if let Err(error) = validate_exec_request(&request) {
        // 字段级语义校验（NUL、空串、环境键合法性、大小写重复等）。
        send_error(error);
        std::process::exit(1);
    }
    // 协作式取消：后台线程持续读 stdin。收到 cancel 帧置位标志；收到任何
    // 其他帧（协议违约）或 stdin EOF（控制端进程消失，见下方英文注释）
    // 同样置位--宁可误杀子进程，也不让 CommandJob 悬挂到超时。
    let cancelled = Arc::new(AtomicBool::new(false));
    let listener_flag = cancelled.clone();
    let request_tty = request.tty;
    let (control_tx, control_rx) = std::sync::mpsc::channel::<RuntimeControl>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        loop {
            match read_frame::<_, ControlRequest>(&mut input) {
                Ok(control)
                    if control.protocol_version == PROTOCOL_VERSION && control.kind == "cancel" =>
                {
                    listener_flag.store(true, Ordering::SeqCst);
                    break;
                }
                Ok(control)
                    if request_tty
                        && control.protocol_version == PROTOCOL_VERSION
                        && control.kind == "input" =>
                {
                    let decoded = control.data.and_then(|value| {
                        let bytes = BASE64.decode(&value).ok()?;
                        (BASE64.encode(&bytes) == value).then_some(bytes)
                    });
                    match decoded {
                        Some(bytes) if bytes.len() <= 64 * 1024 => {
                            if control_tx.send(RuntimeControl::Input(bytes)).is_err() {
                                listener_flag.store(true, Ordering::SeqCst);
                                break;
                            }
                        }
                        _ => {
                            listener_flag.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                }
                Ok(control)
                    if request_tty
                        && control.protocol_version == PROTOCOL_VERSION
                        && control.kind == "resize" =>
                {
                    match (control.columns, control.rows) {
                        (Some(columns), Some(rows))
                            if columns > 0 && rows > 0 && columns <= 32767 && rows <= 32767 =>
                        {
                            if control_tx
                                .send(RuntimeControl::Resize(columns, rows))
                                .is_err()
                            {
                                listener_flag.store(true, Ordering::SeqCst);
                                break;
                            }
                        }
                        _ => {
                            listener_flag.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                }
                Ok(control)
                    if request_tty
                        && control.protocol_version == PROTOCOL_VERSION
                        && control.kind == "eof" =>
                {
                    if control_tx.send(RuntimeControl::Eof).is_err() {
                        listener_flag.store(true, Ordering::SeqCst);
                        break;
                    }
                }
                Ok(_) => {
                    listener_flag.store(true, Ordering::SeqCst);
                    break;
                }
                Err(_) => {
                    // stdin EOF means the owning Node process disappeared. Abort
                    // the CommandJob instead of waiting for the command timeout.
                    listener_flag.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }
    });
    #[cfg(windows)]
    let result = windows_exec::execute(request, cancelled, control_rx);
    #[cfg(not(windows))]
    let result = unix_exec::execute(request, cancelled, control_rx);
    if let Err(error) = result {
        send_error(error);
        std::process::exit(1);
    }
}

/// 角色 A：启动器入口（永不返回）。
/// 流程：确定 RunRoot（POSIXLOOM_RUN_ROOT 优先，否则从 exe 位置向上探测）
/// -> 判定是否恢复命令 -> 选择 Node（正常路径严格校验、恢复路径放宽）
/// -> 用选出的 Node 运行 dist/src/cli/main.js 并透传其退出码。
/// Node 选择失败时直接以退出码 1 终止，绝不静默回退到不受信任的解释器。
fn launch() -> ! {
    // RunRoot 来源优先级：POSIXLOOM_RUN_ROOT 环境变量（显式覆盖，测试/嵌入部署用）
    // > 从 exe 位置向上探测 > 退化为当前目录。
    let root_value = std::env::var("POSIXLOOM_RUN_ROOT")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(find_project_root)
        .unwrap_or_else(|| ".".to_string());
    let root = match absolute_path(std::path::PathBuf::from(root_value)) {
        Ok(root) => root,
        Err(error) => {
            eprintln!("posixloom launcher: {error}");
            std::process::exit(1);
        }
    };
    // launch 之后的参数原样透传给 Node CLI。
    let forwarded: Vec<String> = std::env::args().skip(2).collect();
    // 恢复命令判定：runtime doctor/info/update/rollback 需要能诊断或修复坏掉的运行时
    // 指针，因此 Node 选择策略放宽（见 select_recovery_launcher_node）。
    let recovery_command = forwarded.first().map(String::as_str) == Some("runtime")
        && matches!(
            forwarded.get(1).map(String::as_str),
            Some("doctor" | "info" | "update" | "rollback")
        );
    let node = match if recovery_command {
        select_recovery_launcher_node(&root)
    } else {
        select_launcher_node(&root.to_string_lossy())
    } {
        Ok(node) => node,
        Err(error) => {
            eprintln!("posixloom launcher: {error}");
            std::process::exit(1);
        }
    };
    // 固定入口脚本：它位于 dist/ 下，属于应用包完整性校验的覆盖范围。
    let script = root.join("dist").join("src").join("cli").join("main.js");
    let status = Command::new(node).arg(script).args(forwarded).status();
    std::process::exit(status.map(|value| value.code().unwrap_or(1)).unwrap_or(1));
}

/// 从 exe 所在目录向上最多 6 层探测 PosixLoom 安装根（RunRoot）。
/// 认定标志是 package.json、dist/src/cli/main.js、config/defaults.json
/// 任意一个存在。层数上限避免在异常深的目录里一路扫到盘符根；
/// 找不到返回 None，由调用方决定回退。
fn find_project_root() -> Option<String> {
    let mut current = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..6 {
        if current.join("package.json").exists()
            || current
                .join("dist")
                .join("src")
                .join("cli")
                .join("main.js")
                .exists()
            || current.join("config").join("defaults.json").exists()
        {
            return Some(current.to_string_lossy().into_owned());
        }
        if !current.pop() {
            break;
        }
    }
    None
}

/// 运行时清单中的单个组件描述（目前实际消费的只有 node 组件）。
#[derive(Deserialize)]
struct LauncherComponent {
    /// 组件标识，例如 "node"。
    id: String,
    /// 相对 Runtime 根目录的入口文件路径。
    entrypoint: String,
    /// 入口文件的 SHA-256（十六进制）；release 组件必须提供。
    sha256: Option<String>,
}

/// runtime/versions/<id>/manifest.json 的反序列化目标。
#[derive(Deserialize)]
struct LauncherManifest {
    /// 清单结构版本；release 路径目前只接受 1，未知版本宁可拒绝。
    #[serde(rename = "manifestVersion")]
    manifest_version: Option<u32>,
    /// 运行时 ID，必须与所在目录名一致（防目录与内容对不上）。
    #[serde(rename = "runtimeId")]
    runtime_id: String,
    /// "release" 或 "development"，必须与选择侧推断的模式一致。
    mode: Option<String>,
    /// 组件列表（node 等）。
    #[serde(default)]
    components: Vec<LauncherComponent>,
}

/// 校验运行时 ID 的合法形态：非空、最长 128、首字符必须是 ASCII 字母数字，
/// 其后额外允许 '.'、'_'、'-'。
/// ID 会被直接拼进 runtime/versions/<id> 路径，因此这里是路径遍历与
/// 分隔符注入的第一道防线："../outside"、"a/b" 等都会被拒绝。
fn valid_runtime_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().enumerate().all(|(index, ch)| {
            ch.is_ascii_alphanumeric() || (index > 0 && matches!(ch, '.' | '_' | '-'))
        })
}

/// 把相对路径锚定到当前目录得到绝对路径；绝对路径原样返回。
/// 启动器的所有安全判定都基于绝对路径，避免后续相对路径拼接
/// 随 cwd 漂移产生歧义。
fn absolute_path(path: std::path::PathBuf) -> Result<std::path::PathBuf, String> {
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|current| current.join(path))
            .map_err(|error| format!("cannot resolve current directory: {error}"))
    }
}

/// 实测某目录是否真的可写：先确保目录存在，再以独占方式写入并 fsync 一个
/// 一次性探测文件（带进程 ID 与纳秒时间戳，避免并发冲突），随后无论成败
/// 都删除。只有真正落盘成功才算通过--“目录存在”不等于“可写”，
/// 只读介质上的探测必须失败才能触发 DataRoot 的后续回退。
fn probe_writable_directory(directory: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let probe = directory.join(format!(
        ".posixloom-write-probe-{}-{nonce}",
        std::process::id()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .map_err(|error| format!("cannot write {}: {error}", directory.display()))?;
        file.write_all(b"posixloom")
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())
    })();
    let _ = std::fs::remove_file(&probe);
    result
}

/// 与 TS 侧 config.ts 相同的 DataRoot 探测顺序：
///   1. POSIXLOOM_DATA_ROOT 环境变量（显式指定；创建失败直接报错，不再回退）；
///   2. RunRoot 下的 data/（真正的便携模式；写探测失败才继续回退）；
///   3. LOCALAPPDATA，或 USERPROFILE\.local\share，或 HOME/.local/share
///      下的 PosixLoom/data。
/// 便携目录优先于用户目录：只有便携盘不可写时才落到用户目录。
fn selected_data_root(run_root: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if let Some(value) = std::env::var("POSIXLOOM_DATA_ROOT")
        .ok()
        .filter(|value| !value.is_empty())
    {
        let requested = absolute_path(std::path::PathBuf::from(value))?;
        std::fs::create_dir_all(&requested)
            .map_err(|error| format!("cannot create {}: {error}", requested.display()))?;
        return Ok(requested);
    }
    let portable = run_root.join("data");
    if probe_writable_directory(&portable).is_ok() {
        return Ok(portable);
    }
    let base = std::env::var("LOCALAPPDATA")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var("USERPROFILE")
                .ok()
                .filter(|value| !value.is_empty())
                .map(|home| format!("{home}\\.local\\share"))
        })
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|value| !value.is_empty())
                .map(|home| format!("{home}/.local/share"))
        })
        .ok_or_else(|| "cannot determine fallback DataRoot".to_string())?;
    let fallback = absolute_path(std::path::PathBuf::from(base))?
        .join("PosixLoom")
        .join("data");
    probe_writable_directory(&fallback)?;
    Ok(fallback)
}

/// 一次运行时选择的结论。
struct SelectedRuntime {
    /// 运行时 ID（同时是 versions/ 下的目录名）。
    id: String,
    /// 运行时根目录（<base>/runtime/versions/<id>）。
    root: std::path::PathBuf,
    /// 是否按 release 规则对待（release 走哈希与模式强校验）。
    release: bool,
    /// 是否为捆绑在 RunRoot 内的运行时（相对 data 侧安装的运行时而言）。
    bundled: bool,
}

/// 解析当前生效的运行时与 DataRoot（runtime/current 指针链探测）。
/// 探测顺序固定：data 根的指针优先（用户安装/更新过的运行时），
/// 其次 RunRoot 自带的捆绑指针（通常是 runtime-dev）。
/// release 判定：data 侧指针指向的任何 ID 一律按 release 对待
/// （运行时更新只会安装 release）；RunRoot 侧仅当 ID 不是 "runtime-dev"
/// 时按 release 对待。指针存在但读取失败或 ID 非法时直接报错，
/// 不做静默降级（fail-closed）。返回 (选中的运行时或 None, DataRoot)。
fn selected_runtime(
    run_root: &std::path::Path,
) -> Result<(Option<SelectedRuntime>, std::path::PathBuf), String> {
    let data_root = selected_data_root(run_root)?;
    for (base, source_release, bundled) in
        [(data_root.as_path(), true, false), (run_root, false, true)]
    {
        let pointer = base.join("runtime").join("current");
        if !pointer.exists() {
            continue;
        }
        let id = std::fs::read_to_string(&pointer)
            .map_err(|error| format!("cannot read {}: {error}", pointer.display()))?
            .trim()
            .to_string();
        if !valid_runtime_id(&id) {
            return Err(format!("invalid runtime id in {}", pointer.display()));
        }
        let release = source_release || id != "runtime-dev";
        return Ok((
            Some(SelectedRuntime {
                id: id.clone(),
                root: base.join("runtime").join("versions").join(id),
                release,
                bundled,
            }),
            data_root.clone(),
        ));
    }
    Ok((None, data_root))
}

/// 探测某基目录下是否存在 mode 为 "release" 的运行时目录
/// （扫描 runtime/versions/*/manifest.json）。
/// versions 目录不存在视为“没有”；其他 IO/解析错误一律上抛--
/// 探测器自身异常不能被吞掉，否则 fail-closed 判定会基于不完整信息做出。
fn release_runtime_present(base: &std::path::Path) -> Result<bool, String> {
    let versions = base.join("runtime").join("versions");
    let entries = match std::fs::read_dir(&versions) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("cannot inspect {}: {error}", versions.display())),
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("cannot inspect {}: {error}", versions.display()))?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        let manifest: LauncherManifest = serde_json::from_slice(
            &std::fs::read(&manifest_path)
                .map_err(|error| format!("cannot read {}: {error}", manifest_path.display()))?,
        )
        .map_err(|error| format!("invalid {}: {error}", manifest_path.display()))?;
        if manifest.mode.as_deref() == Some("release") {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 探测 runtime/current 指针是否存在且指向 release 运行时
/// （即指针值不是 "runtime-dev"）。指针不存在返回 false；
/// 存在但读取失败或内容非法则报错，而非当作不存在。
fn release_pointer_present(base: &std::path::Path) -> Result<bool, String> {
    let pointer = base.join("runtime").join("current");
    let value = match std::fs::read_to_string(&pointer) {
        Ok(value) => value.trim().to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("cannot read {}: {error}", pointer.display())),
    };
    if !valid_runtime_id(&value) {
        return Err(format!("invalid runtime id in {}", pointer.display()));
    }
    Ok(value != "runtime-dev")
}

/// 判断字符串是否是“安全”的相对路径：非空、非绝对，且所有路径分量
/// 都是普通分量或 "."。这明确排除了 ".."、根、盘符/UNC 前缀等分量，
/// 是所有来自外部数据（清单 entrypoint、SHA256SUMS 条目）的路径
/// 在参与拼接前必须通过的关卡，防止拼出的路径逃逸出预期根目录。
fn safe_relative_path(value: &str) -> bool {
    let path = std::path::Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path.components().all(|component| {
            matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
}

/// 以 64KB 块流式计算文件的 SHA-256，返回十六进制小写字符串。
/// 流式而非一次读入，避免对大文件（如 node.exe）做整文件内存映射。
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// 校验单个文件与清单期望的 SHA-256 一致，三段防御：
///   1. 期望值本身必须是 64 位十六进制（防清单塞入畸形值绕过比较）；
///   2. 目标必须是真实普通文件且不是符号链接。用 symlink_metadata
///      （不跟随链接）做判定，防止“校验的是 A、实际执行的是 B”的
///      链接替换攻击；
///   3. 实算哈希与期望值（统一转小写后）精确比较。
/// 任一环节失败都返回带 label 的错误信息。
fn verify_hash(path: &std::path::Path, expected: &str, label: &str) -> Result<(), String> {
    if expected.len() != 64 || !expected.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(format!("{label} has an invalid SHA-256 value"));
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!("{label} must be a real file, not a link"));
    }
    let actual = sha256_file(path)?;
    if actual != expected.to_ascii_lowercase() {
        return Err(format!(
            "{label} SHA-256 mismatch (expected {expected}, actual {actual})"
        ));
    }
    Ok(())
}

/// 解析并严格校验 RunRoot 下的 SHA256SUMS 清单，返回 (相对路径, 小写哈希) 列表。
/// 清单自身必须是真实文件而非符号链接。逐行校验规则（任一不满足整体拒绝）：
///   - 行格式必须是 "<64 位十六进制哈希><两个空格><路径>"（GNU sha256sum 格式）；
///   - 路径不允许反斜杠、冒号（盘符/备用数据流语法）、NUL，
///     也不允许空段或 "."/".." 段（杜绝 Windows 路径遍历）；
///   - 不允许条目指向 SHA256SUMS 自身（清单不能校验自己）；
///   - 路径按小写去重（NTFS 大小写不敏感，重复条目会造成覆盖歧义）；
///   - 清单为空视为损坏。
fn package_checksum_records(run_root: &std::path::Path) -> Result<Vec<(String, String)>, String> {
    let sums_path = run_root.join("SHA256SUMS");
    let sums_metadata = std::fs::symlink_metadata(&sums_path)
        .map_err(|error| format!("cannot inspect {}: {error}", sums_path.display()))?;
    if !sums_metadata.is_file() || sums_metadata.file_type().is_symlink() {
        return Err("SHA256SUMS must be a real file, not a link".to_string());
    }
    let sums = std::fs::read_to_string(&sums_path)
        .map_err(|error| format!("cannot read {}: {error}", sums_path.display()))?;
    let mut seen = BTreeSet::new();
    let mut records = Vec::new();
    for (index, line) in sums.lines().enumerate() {
        let (hash, path) = line
            .split_once("  ")
            .ok_or_else(|| format!("invalid SHA256SUMS line {}", index + 1))?;
        if hash.len() != 64 || !hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(format!("invalid SHA256SUMS digest on line {}", index + 1));
        }
        // 路径白名单化：拒绝一切能让条目脱离 RunRoot 或指向清单自身的语法。
        if path.is_empty()
            || path.chars().any(|ch| matches!(ch, '\\' | ':' | '\0'))
            || path
                .split('/')
                .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
            || path.eq_ignore_ascii_case("SHA256SUMS")
        {
            return Err(format!("unsafe SHA256SUMS path on line {}", index + 1));
        }
        if !seen.insert(path.to_lowercase()) {
            return Err(format!("duplicate SHA256SUMS path: {path}"));
        }
        records.push((path.to_string(), hash.to_ascii_lowercase()));
    }
    if records.is_empty() {
        return Err("SHA256SUMS contains no package records".to_string());
    }
    Ok(records)
}

/// 校验 RunRoot 下某个包内文件与 SHA256SUMS 一致：
/// 先确认目标路径本身是安全相对路径（防逃逸），再要求清单中恰好存在
/// 一条与之匹配的记录（“恰好一条”排除大小写变体重复造成的歧义），
/// 最后做哈希比对。捆绑运行时的 manifest.json 就是通过它逐文件校验的。
fn verify_package_checksum(run_root: &std::path::Path, relative: &str) -> Result<(), String> {
    if !safe_relative_path(relative) {
        return Err(format!("unsafe package checksum path: {relative}"));
    }
    let records = package_checksum_records(run_root)?;
    let matches: Vec<&String> = records
        .iter()
        .filter_map(|(path, hash)| path.eq_ignore_ascii_case(relative).then_some(hash))
        .collect();
    if matches.len() != 1 {
        return Err(format!(
            "SHA256SUMS must contain exactly one entry for {relative}"
        ));
    }
    verify_hash(&run_root.join(relative), matches[0], relative)
}

/// 递归收集 config/ 与 dist/ 下的真实文件清单（相对 RunRoot、'/' 分隔）。
/// 遍历本身就是完整性检查：目录或文件是符号链接、出现既非文件又非目录的
/// 条目、或路径无法映射回 RunRoot（逃逸）都立即报错。
/// 结果用于稍后与 SHA256SUMS 做“精确覆盖”双向比对。
fn collect_real_package_files(
    run_root: &std::path::Path,
    directory: &std::path::Path,
    files: &mut Vec<String>,
) -> Result<(), String> {
    let directory_metadata = std::fs::symlink_metadata(directory)
        .map_err(|error| format!("cannot inspect {}: {error}", directory.display()))?;
    if !directory_metadata.is_dir() || directory_metadata.file_type().is_symlink() {
        return Err(format!(
            "package application directory must be a real directory: {}",
            directory.display()
        ));
    }
    for entry in std::fs::read_dir(directory)
        .map_err(|error| format!("cannot inspect {}: {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "package application cannot contain a link: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            collect_real_package_files(run_root, &path, files)?;
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(run_root)
                .map_err(|_| {
                    format!(
                        "package application file escapes RunRoot: {}",
                        path.display()
                    )
                })?
                .to_string_lossy()
                .replace('\\', "/");
            files.push(relative);
        } else {
            return Err(format!(
                "package application contains an unsupported file: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

/// 应用包完整性校验的主入口（必须在信任 Node 之前调用）。三层保证：
///   1. 清单中属于应用包的记录（package.json 与 config/、dist/ 前缀）
///      逐条做哈希校验，且 package.json、config/defaults.json、
///      dist/src/cli/main.js 三个启动必需文件必须在场；
///   2. 递归实扫 config/ 与 dist/，要求与清单记录精确互相覆盖：
///      磁盘上多出的文件（未被清单覆盖）与清单里多出的记录都算失败--
///      “精确覆盖”确保没有文件能躲在清单之外被加载，也没有死记录掩盖缺文件；
///   3. 扫描本身排除符号链接与逃逸路径（见 collect_real_package_files）。
/// 换言之：对 dist/config 的任何篡改、增删都会让启动在此失败。
fn verify_package_application(run_root: &std::path::Path) -> Result<(), String> {
    let records = package_checksum_records(run_root)?;
    // 启动必需的三个应用文件：缺失任何一个 CLI 都无法运行，提前给出明确错误。
    let mut required = BTreeSet::from([
        "package.json".to_string(),
        "config/defaults.json".to_string(),
        "dist/src/cli/main.js".to_string(),
    ]);
    let mut application_records = BTreeSet::new();
    // 只校验属于应用包的记录（package.json 与 config/、dist/ 前缀）；
    // 其余记录（例如捆绑运行时的 manifest.json）由各自路径单独校验。
    for (path, hash) in records {
        let normalized = path.to_ascii_lowercase();
        if path.eq_ignore_ascii_case("package.json")
            || normalized.starts_with("config/")
            || normalized.starts_with("dist/")
        {
            verify_hash(&run_root.join(&path), &hash, &path)?;
            required.retain(|entry| !entry.eq_ignore_ascii_case(&path));
            application_records.insert(path.to_lowercase());
        }
    }
    if application_records.is_empty() || !required.is_empty() {
        return Err(format!(
            "SHA256SUMS is missing required application files: {}",
            required.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
    // 实际扫描磁盘：config/ 与 dist/ 的真实文件集合（package.json 上面已校验过）。
    let mut application_files = vec!["package.json".to_string()];
    collect_real_package_files(run_root, &run_root.join("config"), &mut application_files)?;
    collect_real_package_files(run_root, &run_root.join("dist"), &mut application_files)?;
    let actual: BTreeSet<String> = application_files
        .into_iter()
        .map(|path| path.to_lowercase())
        .collect();
    // 双向精确覆盖：磁盘上多出清单没有的文件（uncovered 非空），
    // 或清单记录数与实际文件数不一致（清单里有磁盘上不存在的记录），都算失败。
    let uncovered: Vec<&String> = actual.difference(&application_records).collect();
    if !uncovered.is_empty() || actual.len() != application_records.len() {
        return Err(format!(
            "SHA256SUMS does not exactly cover package application files{}",
            uncovered
                .first()
                .map(|path| format!(": {path}"))
                .unwrap_or_default()
        ));
    }
    Ok(())
}

/// 从 release 运行时解析出可用且已验证的 Node 可执行文件路径。
/// 逐条防御：
///   - manifestVersion 必须是 1（未知结构宁可拒绝也不猜测）；
///   - id 为 "node" 的组件必须恰好一个（零个无法启动，多个意味着选择歧义）；
///   - entrypoint 归一化为 '/' 后必须精确等于 node/node[.exe]，
///     且通过 safe_relative_path--禁止清单把入口指到 Runtime 之外；
///   - 组件必须声明 SHA-256 且实算一致（verify_hash 同时排除符号链接）。
/// 返回的路径是“此刻内容已验证”的；之后若被替换，下次校验仍会失败。
fn release_node(
    runtime: &SelectedRuntime,
    manifest: &LauncherManifest,
) -> Result<std::path::PathBuf, String> {
    if manifest.manifest_version != Some(1) {
        return Err("release Runtime has an unsupported manifestVersion".to_string());
    }
    let nodes: Vec<&LauncherComponent> = manifest
        .components
        .iter()
        .filter(|component| component.id == "node")
        .collect();
    if nodes.len() != 1 {
        return Err("release Runtime must declare exactly one Node component".to_string());
    }
    let node = nodes[0];
    let normalized = node.entrypoint.replace('\\', "/");
    let expected_entrypoint = if cfg!(windows) {
        "node/node.exe"
    } else {
        "node/node"
    };
    if normalized != expected_entrypoint || !safe_relative_path(&node.entrypoint) {
        return Err(format!(
            "release Runtime Node entrypoint must be {expected_entrypoint}"
        ));
    }
    let candidate = runtime.root.join(&node.entrypoint);
    if !candidate.is_file() {
        return Err("release Runtime is missing its packaged Node executable".to_string());
    }
    let expected_hash = node
        .sha256
        .as_deref()
        .ok_or_else(|| "release Runtime Node component has no SHA-256".to_string())?;
    verify_hash(&candidate, expected_hash, "Node component")?;
    Ok(candidate)
}

/// 校验清单声明的模式与选择侧推断的模式一致：
/// release 位置出现 development 清单（或反之）意味着运行时被降级/伪造，
/// 直接拒绝。典型攻击场景：把“已安装 release 运行时”换成无哈希要求的
/// dev 清单来绕过 node 组件哈希校验。
fn verify_launcher_mode(
    runtime: &SelectedRuntime,
    manifest: &LauncherManifest,
) -> Result<(), String> {
    let expected_mode = if runtime.release {
        "release"
    } else {
        "development"
    };
    if manifest.mode.as_deref() != Some(expected_mode) {
        return Err(format!(
            "selected Runtime must declare {expected_mode} mode"
        ));
    }
    Ok(())
}

/// 给定已选择的运行时，解析出可用的 Node 路径。
/// 统一流程：读 manifest -> runtimeId 必须与目录名一致 -> 模式一致 ->
/// release 走 release_node（含组件哈希），development 直接取 node/node[.exe]。
/// 捆绑在 RunRoot 内的 release 运行时，其 manifest.json 自身也必须先通过
/// SHA256SUMS 校验，防止攻击者改 manifest 里的哈希来“洗白”被篡改的 node。
fn runtime_node_candidate(
    run_root: &std::path::Path,
    runtime: SelectedRuntime,
    package_integrity_required: bool,
) -> Result<std::path::PathBuf, String> {
    let manifest_path = runtime.root.join("manifest.json");
    // 捆绑在 RunRoot 内且要求完整性时，manifest 自身也在 SHA256SUMS 覆盖范围内，
    // 必须先校验再读取其中的哈希声明。
    if runtime.release && runtime.bundled && package_integrity_required {
        let relative_manifest = manifest_path
            .strip_prefix(run_root)
            .map_err(|_| "bundled Runtime manifest escapes RunRoot".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        verify_package_checksum(run_root, &relative_manifest)?;
    }
    let manifest: LauncherManifest = serde_json::from_slice(
        &std::fs::read(&manifest_path)
            .map_err(|error| format!("cannot read {}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("invalid {}: {error}", manifest_path.display()))?;
    if manifest.runtime_id != runtime.id {
        return Err("Runtime directory does not match manifest runtimeId".to_string());
    }
    verify_launcher_mode(&runtime, &manifest)?;
    if runtime.release {
        return release_node(&runtime, &manifest);
    }
    // development 运行时直接取 node/node[.exe]，无哈希要求（本地开发产物，
    // 只有 release 运行时才承诺供应链完整性）。
    for name in ["node.exe", "node"] {
        let candidate = runtime.root.join("node").join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("development Runtime has no packaged Node".to_string())
}

/// 读取某基目录的 runtime/current 指针并构造 SelectedRuntime。
/// 指针不存在返回 None（未选择运行时）；存在但读取失败或 ID 非法则报错，
/// 不静默忽略。release 判定：data 侧（非捆绑）一律按 release；
/// RunRoot 侧（捆绑）仅当 ID 不是 "runtime-dev" 时按 release。
fn runtime_from_pointer(
    base: &std::path::Path,
    bundled: bool,
) -> Result<Option<SelectedRuntime>, String> {
    let pointer = base.join("runtime").join("current");
    let id = match std::fs::read_to_string(&pointer) {
        Ok(value) => value.trim().to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read {}: {error}", pointer.display())),
    };
    if !valid_runtime_id(&id) {
        return Err(format!("invalid runtime id in {}", pointer.display()));
    }
    Ok(Some(SelectedRuntime {
        release: !bundled || id != "runtime-dev",
        root: base.join("runtime").join("versions").join(&id),
        id,
        bundled,
    }))
}

/// 恢复模式专用：在一个基目录下尽力找到一个能通过全部校验的 Node。
/// 策略（优先级递降）：
///   1. 指针指向的运行时，若能完整通过校验则直接用；
///   2. 否则枚举 runtime/versions/ 下所有目录，按名称降序（最新优先）
///      逐个尝试能通过 manifest/runtimeId/模式/哈希校验的运行时；
///   3. 都不行返回 None，由调用方决定后续。
/// 这里的失败被静默跳过--恢复模式的目标是“尽力拉起”，但每一个最终
/// 被选中的候选仍然必须通过全部校验，放宽的只是“指针必须有效”这一条。
fn recovery_node_from_base(
    run_root: &std::path::Path,
    base: &std::path::Path,
    bundled: bool,
    package_integrity_required: bool,
) -> Option<std::path::PathBuf> {
    if let Ok(Some(runtime)) = runtime_from_pointer(base, bundled) {
        if let Ok(node) = runtime_node_candidate(run_root, runtime, package_integrity_required) {
            return Some(node);
        }
    }
    let versions = base.join("runtime").join("versions");
    let mut entries: Vec<_> = std::fs::read_dir(versions)
        .ok()?
        .filter_map(Result::ok)
        .collect();
    // 版本名降序排列：优先尝试最新版本；坏掉的指针往往指向次新的可用版本。
    entries.sort_by_key(|entry| entry.file_name());
    entries.reverse();
    for entry in entries {
        if !entry
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if !valid_runtime_id(&id) {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        let manifest: LauncherManifest = match std::fs::read(&manifest_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        {
            Some(manifest) => manifest,
            None => continue,
        };
        if manifest.runtime_id != id {
            continue;
        }
        let runtime = SelectedRuntime {
            release: manifest.mode.as_deref() == Some("release"),
            id,
            root: entry.path(),
            bundled,
        };
        if let Ok(node) = runtime_node_candidate(run_root, runtime, package_integrity_required) {
            return Some(node);
        }
    }
    None
}

/// 只有 RunRoot 明确指向一个结构有效的 development Runtime 时，恢复命令才可
/// 在捆绑 Node 缺失后使用开发机上的 Node。SHA256SUMS 仍负责校验应用代码；这里
/// 只区分“带完整性清单的开发包”和必须坚持捆绑 Node 的 release 包。
fn bundled_development_fallback_allowed(run_root: &std::path::Path) -> Result<bool, String> {
    if release_pointer_present(run_root)? || release_runtime_present(run_root)? {
        return Ok(false);
    }
    let Some(runtime) = runtime_from_pointer(run_root, true)? else {
        return Ok(false);
    };
    if runtime.release {
        return Ok(false);
    }
    let manifest_path = runtime.root.join("manifest.json");
    if run_root.join("SHA256SUMS").is_file() {
        verify_package_checksum(run_root, "runtime/current")?;
        let relative_manifest = manifest_path
            .strip_prefix(run_root)
            .map_err(|_| "bundled development Runtime manifest escapes RunRoot".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        verify_package_checksum(run_root, &relative_manifest)?;
    }
    let manifest: LauncherManifest = serde_json::from_slice(
        &std::fs::read(&manifest_path)
            .map_err(|error| format!("cannot read {}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("invalid {}: {error}", manifest_path.display()))?;
    if manifest.runtime_id != runtime.id {
        return Err("runtime/current does not match manifest runtimeId".to_string());
    }
    verify_launcher_mode(&runtime, &manifest)?;
    Ok(true)
}

/// 恢复模式（runtime doctor/update/rollback）的 Node 选择入口。
/// 与正常路径 select_launcher_node 的差异只在“如何挑运行时”：
///   - 完整性要求（SHA256SUMS 存在 / release 指针 / release 运行时目录）
///     仍然全额执行--恢复操作本身不能运行被篡改的应用包；
///   - Node 候选放宽为：先捆绑 RunRoot、再 data 根，各自按
///     recovery_node_from_base 的降级枚举策略尽力找一个通过校验的运行时；
///   - 仍找不到时：release 包直接失败；明确的 development Runtime 则与普通
///     启动路径一致，允许 POSIXLOOM_NODE 或 PATH 上的 node。
fn select_recovery_launcher_node(root: &std::path::Path) -> Result<String, String> {
    let root_path = absolute_path(root.to_path_buf())?;
    let data_root = selected_data_root(&root_path)?;
    // 完整性判定与正常路径同一套三信号：任一成立即强制整包校验。
    let package_integrity_required = root_path.join("SHA256SUMS").exists()
        || release_pointer_present(&root_path)?
        || release_runtime_present(&root_path)?;
    if package_integrity_required {
        verify_package_application(&root_path)?;
    }
    // 捆绑运行时（RunRoot 内）优先，data 侧安装的运行时次之；
    // 两者都按放宽策略“尽力找一个通过校验的 Node”。
    if let Some(node) =
        recovery_node_from_base(&root_path, &root_path, true, package_integrity_required).or_else(
            || recovery_node_from_base(&root_path, &data_root, false, package_integrity_required),
        )
    {
        return Ok(node.to_string_lossy().into_owned());
    }
    // SHA256SUMS 要求应用代码通过校验，但 development 包按定义允许缺少第三方
    // 组件。仅当 RunRoot 明确指向有效的 runtime-dev 时放行外部 Node；release
    // 包、指针缺失或清单损坏仍然 fail-closed。
    let development_fallback_allowed = bundled_development_fallback_allowed(&root_path)?;
    if package_integrity_required && !development_fallback_allowed {
        return Err(
            "no validated bundled or previous Runtime Node is available for recovery".to_string(),
        );
    }
    // 纯开发布局以及已校验应用代码的 development 包都可使用显式/系统 Node。
    if let Ok(node) = std::env::var("POSIXLOOM_NODE") {
        if std::path::Path::new(&node).is_file() {
            return Ok(node);
        }
    }
    Ok("node".to_string())
}

/// 正常（非恢复）路径的 Node 选择入口，全流程 fail-closed：
///   1. 解析指针链得到当前运行时（data 优先于捆绑）；
///   2. 判定是否强制应用包完整性（SHA256SUMS / release 指针 / release
///      运行时目录任一成立），成立则先整包校验；
///   3. 有指针：读 manifest，校验 runtimeId 与模式；release 还要校验
///      （捆绑时含 manifest 自身的清单哈希）与 node 组件哈希，
///      development 直接取 node/node[.exe]；
///   4. 无指针但检测到 release 运行时：说明指针丢失/被删，状态损坏，
///      直接拒绝--绝不回退 PATH 上的 node，防止环境注入的解释器
///      绕过一切完整性校验接管启动；
///   5. 开发布局（无 release 痕迹且无指针）才允许 POSIXLOOM_NODE / PATH 的 node。
fn select_launcher_node(root: &str) -> Result<String, String> {
    let root_path = absolute_path(std::path::PathBuf::from(root))?;
    let (selected, data_root) = selected_runtime(&root_path)?;
    // 完整性判定三信号：SHA256SUMS 在场、指针指向 release、
    // 或 versions/ 下存在 release 运行时。任一成立即启用强制校验。
    let package_integrity_required = root_path.join("SHA256SUMS").exists()
        || release_pointer_present(&root_path)?
        || release_runtime_present(&root_path)?;
    if package_integrity_required {
        verify_package_application(&root_path)?;
    }
    // 有指针：解析 manifest 并逐项校验；捆绑的 release 运行时还要先校验
    // manifest 自身的 SHA256SUMS 记录（防止改 manifest 哈希来洗白 node）。
    if let Some(runtime) = selected {
        let manifest_path = runtime.root.join("manifest.json");
        if runtime.release && runtime.bundled {
            let relative_manifest = manifest_path
                .strip_prefix(&root_path)
                .map_err(|_| "bundled Runtime manifest escapes RunRoot".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            verify_package_checksum(&root_path, &relative_manifest)?;
        }
        let manifest: LauncherManifest = serde_json::from_slice(
            &std::fs::read(&manifest_path)
                .map_err(|error| format!("cannot read {}: {error}", manifest_path.display()))?,
        )
        .map_err(|error| format!("invalid {}: {error}", manifest_path.display()))?;
        if manifest.runtime_id != runtime.id {
            return Err("runtime/current does not match manifest runtimeId".to_string());
        }
        verify_launcher_mode(&runtime, &manifest)?;
        if runtime.release {
            return Ok(release_node(&runtime, &manifest)?
                .to_string_lossy()
                .into_owned());
        }
        // development 运行时：直接取 node/node[.exe]，无哈希要求。
        for name in ["node.exe", "node"] {
            let candidate = runtime.root.join("node").join(name);
            if candidate.exists() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    } else {
        // 关键 fail-closed 点：无指针时仍要检查两个基目录有没有 release 运行时。
        // 有则说明指针丢失/被删（状态损坏），拒绝启动而不是回退 PATH--
        // 否则环境里任何 node 都能绕过全部校验接管启动流程。
        if [&data_root, &root_path]
            .iter()
            .map(|base| release_runtime_present(base))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .any(|present| present)
        {
            return Err(
                "release Runtime pointer is missing; refusing PATH Node fallback".to_string(),
            );
        }
    }
    // 开发布局兜底：显式 POSIXLOOM_NODE 优先于 PATH 上的 node。
    if let Ok(node) = std::env::var("POSIXLOOM_NODE") {
        if std::path::Path::new(&node).exists() {
            return Ok(node);
        }
    }
    Ok("node".to_string())
}

// 启动器与协议层的单元测试，覆盖四个安全性质：帧编解码往返、运行时 ID
// 的路径遍历拒绝、exec 请求的字段校验，以及 fail-closed 的运行时/完整性
// 决策（指针缺失拒绝启动、恢复模式回退、node 哈希、模式降级、精确覆盖）。
#[cfg(test)]
mod tests {
    use super::*;

    // 生成带进程 ID 与纳秒时间戳的唯一临时目录路径，避免测试并行互相干扰。
    fn temp_root(label: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("posixloom-{label}-{}-{nonce}", std::process::id()))
    }

    /// 写入启动器完整性检查所需的最小应用树、Runtime 与对应 SHA256SUMS。
    fn write_hashed_application(root: &std::path::Path, runtime_id: &str, mode: &str) {
        let package = root.join("package.json");
        let defaults = root.join("config").join("defaults.json");
        let script = root.join("dist").join("src").join("cli").join("main.js");
        let current = root.join("runtime").join("current");
        let manifest = root
            .join("runtime")
            .join("versions")
            .join(runtime_id)
            .join("manifest.json");
        std::fs::create_dir_all(defaults.parent().unwrap()).unwrap();
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        std::fs::write(&package, br#"{"type":"module"}"#).unwrap();
        std::fs::write(&defaults, b"{}").unwrap();
        std::fs::write(&script, b"// fixture").unwrap();
        std::fs::write(&current, runtime_id).unwrap();
        std::fs::write(
            &manifest,
            format!(r#"{{"manifestVersion":1,"runtimeId":"{runtime_id}","mode":"{mode}"}}"#),
        )
        .unwrap();
        std::fs::write(
            root.join("SHA256SUMS"),
            format!(
                "{}  config/defaults.json\n{}  dist/src/cli/main.js\n{}  package.json\n{}  runtime/current\n{}  runtime/versions/{runtime_id}/manifest.json\n",
                sha256_file(&defaults).unwrap(),
                sha256_file(&script).unwrap(),
                sha256_file(&package).unwrap(),
                sha256_file(&current).unwrap(),
                sha256_file(&manifest).unwrap(),
            ),
        )
        .unwrap();
    }

    // hello 帧编码后应能无损读回，协议版本与类型字段保持不变。
    #[test]
    fn protocol_frame_round_trips() {
        let mut encoded = Vec::new();
        let mut event = Event::new("hello");
        event.max_frame_bytes = Some(MAX_FRAME_BYTES);
        write_frame(&mut encoded, &event).unwrap();
        let decoded: serde_json::Value = read_frame(&mut encoded.as_slice()).unwrap();
        assert_eq!(decoded["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(decoded["type"], "hello");
    }

    // 运行时 ID 校验必须拒绝路径遍历（../）、分隔符（/）与空串。
    #[test]
    fn runtime_id_rejects_traversal() {
        assert!(valid_runtime_id("runtime-1.2.3"));
        assert!(!valid_runtime_id("../outside"));
        assert!(!valid_runtime_id("runtime/other"));
        assert!(!valid_runtime_id(""));
    }

    // 请求校验：零超时、含 '=' 的环境键、大小写重复的环境键都必须被拒绝。
    #[test]
    fn exec_request_rejects_zero_timeout_and_invalid_environment() {
        let mut request = ExecRequest {
            protocol_version: PROTOCOL_VERSION,
            kind: "exec".to_string(),
            program: "node".to_string(),
            args: Vec::new(),
            cwd: ".".to_string(),
            env: BTreeMap::new(),
            timeout_ms: 0,
            input_base64: None,
            tty: false,
            columns: None,
            rows: None,
        };
        assert!(validate_exec_request(&request).is_err());
        request.timeout_ms = 1;
        request
            .env
            .insert("BAD=KEY".to_string(), "value".to_string());
        assert!(validate_exec_request(&request).is_err());
        request.env.clear();
        request.env.insert("Path".to_string(), "first".to_string());
        request.env.insert("PATH".to_string(), "second".to_string());
        assert!(validate_exec_request(&request).is_err());

        request.env.clear();
        request.tty = true;
        assert!(validate_exec_request(&request).is_err());
        request.columns = Some(80);
        request.rows = Some(24);
        assert!(validate_exec_request(&request).is_ok());
        request.rows = Some(32768);
        assert!(validate_exec_request(&request).is_err());
    }

    // 存在 release 运行时而指针缺失时，正常路径必须失败（不允许 PATH 回退）。
    #[test]
    fn release_runtime_without_pointer_is_fail_closed() {
        let root = temp_root("launcher-no-pointer");
        let runtime = root
            .join("runtime")
            .join("versions")
            .join("runtime-release");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(
            runtime.join("manifest.json"),
            r#"{"runtimeId":"runtime-release","mode":"release"}"#,
        )
        .unwrap();
        assert_eq!(release_runtime_present(&root).unwrap(), true);
        assert!(select_launcher_node(root.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    // data 侧指针内容非法时正常路径失败，但恢复模式应能改用捆绑运行时的 node。
    #[test]
    fn recovery_uses_bundled_node_when_data_pointer_is_invalid() {
        let root = temp_root("launcher-recovery-pointer");
        let data_pointer = root.join("data").join("runtime").join("current");
        let bundled_pointer = root.join("runtime").join("current");
        let runtime = root.join("runtime").join("versions").join("runtime-dev");
        let node = runtime
            .join("node")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        std::fs::create_dir_all(data_pointer.parent().unwrap()).unwrap();
        std::fs::create_dir_all(node.parent().unwrap()).unwrap();
        std::fs::write(data_pointer, "../invalid").unwrap();
        std::fs::write(bundled_pointer, "runtime-dev").unwrap();
        std::fs::write(
            runtime.join("manifest.json"),
            r#"{"manifestVersion":1,"runtimeId":"runtime-dev","mode":"development"}"#,
        )
        .unwrap();
        std::fs::write(&node, b"recovery-node").unwrap();

        assert!(select_launcher_node(root.to_str().unwrap()).is_err());
        assert_eq!(
            select_recovery_launcher_node(&root).unwrap(),
            node.to_string_lossy()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    // 带 SHA256SUMS 的 development 包仍应在缺少捆绑 Node 时使用开发机 Node；
    // 这是开发包允许第三方组件回退的契约，也是打包 CI 的实际布局。
    #[test]
    fn recovery_allows_external_node_for_hashed_development_package() {
        let root = temp_root("launcher-development-node-fallback");
        write_hashed_application(&root, "runtime-dev", "development");

        let selected = select_recovery_launcher_node(&root).unwrap();
        assert!(selected == "node" || std::path::Path::new(&selected).is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    // 同样缺少 Node 时，release 包不得借开发回退绕过捆绑组件要求。
    #[test]
    fn recovery_rejects_external_node_for_hashed_release_package() {
        let root = temp_root("launcher-release-node-fallback");
        write_hashed_application(&root, "runtime-release", "release");

        assert!(select_recovery_launcher_node(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    // release 的 node 组件哈希匹配才放行；文件被篡改后必须报 SHA-256 mismatch。
    #[test]
    fn release_node_is_hashed_before_launch() {
        let root = temp_root("launcher-node-hash");
        let runtime_root = root.join("runtime-release");
        let entrypoint = if cfg!(windows) {
            "node/node.exe"
        } else {
            "node/node"
        };
        let node_path = runtime_root.join(entrypoint);
        std::fs::create_dir_all(node_path.parent().unwrap()).unwrap();
        std::fs::write(&node_path, b"trusted-node").unwrap();
        let manifest = LauncherManifest {
            manifest_version: Some(1),
            runtime_id: "runtime-release".to_string(),
            mode: Some("release".to_string()),
            components: vec![LauncherComponent {
                id: "node".to_string(),
                entrypoint: entrypoint.to_string(),
                sha256: Some(sha256_file(&node_path).unwrap()),
            }],
        };
        let runtime = SelectedRuntime {
            id: "runtime-release".to_string(),
            root: runtime_root,
            release: true,
            bundled: true,
        };
        assert_eq!(release_node(&runtime, &manifest).unwrap(), node_path);
        std::fs::write(&node_path, b"tampered-node").unwrap();
        assert!(release_node(&runtime, &manifest)
            .unwrap_err()
            .contains("SHA-256 mismatch"));
        std::fs::remove_dir_all(root).unwrap();
    }

    // release 位置的运行时不得用 development 模式清单伪装降级。
    #[test]
    fn installed_runtime_cannot_downgrade_to_development_mode() {
        let runtime = SelectedRuntime {
            id: "runtime-release".to_string(),
            root: std::path::PathBuf::from("runtime-release"),
            release: true,
            bundled: false,
        };
        let manifest = LauncherManifest {
            manifest_version: Some(1),
            runtime_id: "runtime-release".to_string(),
            mode: Some("development".to_string()),
            components: Vec::new(),
        };
        assert!(verify_launcher_mode(&runtime, &manifest).is_err());
    }

    // 清单精确覆盖 + 入口脚本哈希：清单未覆盖的新增文件、
    // 以及被篡改的 main.js 都必须使校验失败。
    #[test]
    fn package_entrypoint_checksum_is_enforced() {
        let root = temp_root("launcher-controller-hash");
        let script = root.join("dist").join("src").join("cli").join("main.js");
        let defaults = root.join("config").join("defaults.json");
        let package = root.join("package.json");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::create_dir_all(defaults.parent().unwrap()).unwrap();
        std::fs::write(&script, b"trusted-controller").unwrap();
        std::fs::write(&defaults, b"{}").unwrap();
        std::fs::write(&package, br#"{"type":"module"}"#).unwrap();
        std::fs::write(
            root.join("SHA256SUMS"),
            format!(
                "{}  config/defaults.json\n{}  dist/src/cli/main.js\n{}  package.json\n",
                sha256_file(&defaults).unwrap(),
                sha256_file(&script).unwrap(),
                sha256_file(&package).unwrap(),
            ),
        )
        .unwrap();
        verify_package_checksum(&root, "dist/src/cli/main.js").unwrap();
        verify_package_application(&root).unwrap();
        let uncovered = root.join("dist").join("uncovered.js");
        std::fs::write(&uncovered, b"uncovered").unwrap();
        assert!(verify_package_application(&root)
            .unwrap_err()
            .contains("does not exactly cover"));
        std::fs::remove_file(uncovered).unwrap();
        std::fs::write(&script, b"tampered-controller").unwrap();
        assert!(verify_package_checksum(&root, "dist/src/cli/main.js")
            .unwrap_err()
            .contains("SHA-256 mismatch"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
