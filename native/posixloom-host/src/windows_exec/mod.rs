mod resources;
use resources::{Job, OwnedHandle, PseudoConsole};
mod namespace;
use namespace::{NamespaceWait, ShellNamespaceGuard};
mod pipe;
mod pty;
use crate::protocol::*;
use pipe::execute_pipe;
use pty::execute_pty;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
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
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
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
///
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

/// Resource recovery/setup may take time after acquiring the namespace. Check
/// again immediately before process creation so an expired waiter never runs.
fn namespace_stopped(
    has_namespace: bool,
    started: Instant,
    timeout_ms: u64,
    cancelled: &AtomicBool,
) -> bool {
    if !has_namespace {
        return false;
    }
    let terminal = if cancelled.load(Ordering::SeqCst) {
        Some((130, "cancelled"))
    } else if started.elapsed() >= Duration::from_millis(timeout_ms) {
        Some((124, "timed-out"))
    } else {
        None
    };
    if let Some((code, outcome)) = terminal {
        send_exit(code, outcome);
        return true;
    }
    false
}

/// Windows ConPTY 执行路径：终端输出是一条包含 VT/ANSI 序列的合并字节流，
/// 统一以 stdout 事件转发。运行期 input/resize/eof 通过 controls 通道进入。
/// 按 exec 请求选择普通管道或 ConPTY 后端。
pub(crate) fn execute(
    request: ExecRequest,
    cancelled: Arc<AtomicBool>,
    controls: std::sync::mpsc::Receiver<RuntimeControl>,
) -> Result<(), String> {
    let started = Instant::now();
    let _namespace = if let Some(key) = &request.shell_namespace {
        match ShellNamespaceGuard::acquire(key, started, request.timeout_ms, &cancelled)? {
            NamespaceWait::Acquired(guard) => Some(guard),
            NamespaceWait::Stopped(outcome) => {
                send_exit(if outcome == "cancelled" { 130 } else { 124 }, outcome);
                return Ok(());
            }
        }
    } else {
        None
    };
    if request.tty {
        execute_pty(request, cancelled, controls, started)
    } else {
        drop(controls);
        execute_pipe(request, cancelled, started)
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
