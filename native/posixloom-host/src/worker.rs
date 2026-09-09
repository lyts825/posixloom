use crate::protocol::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub(crate) fn run() {
    // 握手第一步：hello 事件声明协议版本与本端单帧上限。
    let mut hello = Event::new("hello");
    hello.max_frame_bytes = Some(MAX_FRAME_BYTES);
    #[cfg(windows)]
    {
        hello.capabilities = Some(vec!["shell-namespace-v1".to_string()]);
    }
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
    let (control_tx, control_rx) =
        std::sync::mpsc::sync_channel::<RuntimeControl>(MAX_PENDING_INTERACTIVE_EVENTS);
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
                            // A full pre-start queue must not block this listener and
                            // hide a later cancellation while the namespace is waiting.
                            if control_tx.try_send(RuntimeControl::Input(bytes)).is_err() {
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
                                .try_send(RuntimeControl::Resize(columns, rows))
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
                    if control_tx.try_send(RuntimeControl::Eof).is_err() {
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
    let result = crate::windows_exec::execute(request, cancelled, control_rx);
    #[cfg(not(windows))]
    let result = crate::unix_exec::execute(request, cancelled, control_rx);
    if let Err(error) = result {
        send_error(error);
        std::process::exit(1);
    }
}
