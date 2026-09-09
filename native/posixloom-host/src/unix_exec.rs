use crate::protocol::*;
use std::io::{Read, Write};
use std::process::Command;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 与 windows_exec::execute 同构的 Unix 实现：spawn 后轮询 try_wait，
/// 期间响应协作取消与超时；三路 IO 各占一个线程，最后 join 排水
/// 线程保证 exit 之前所有流式事件都已发出。
pub(crate) fn execute(
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
    if request.shell_namespace.is_some() {
        return Err("shellNamespace coordination is only supported on Windows".to_string());
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
