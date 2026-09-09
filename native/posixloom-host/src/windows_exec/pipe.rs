use super::*;

pub(super) fn execute_pipe(
    request: ExecRequest,
    cancelled: Arc<AtomicBool>,
    started: Instant,
) -> Result<(), String> {
    if request.kind != "exec" {
        return Err("unsupported request type".to_string());
    }
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(format!("protocol mismatch: {}", request.protocol_version));
    }
    let input = decode_input(request.input_base64)?;
    // 创建 Job Object：后续所有进程树级强杀（超时/取消/收尾）都通过它完成。
    let Some(job) = Job::new(
        request.shell_namespace.as_deref(),
        started,
        request.timeout_ms,
        &cancelled,
    )?
    else {
        return Ok(());
    };
    if namespace_stopped(
        request.shell_namespace.is_some(),
        started,
        request.timeout_ms,
        &cancelled,
    ) {
        return Ok(());
    }

    // RAII releases every endpoint on all early error paths.
    let (stdin_read, stdin_write) = OwnedHandle::pipe(true)?;
    let (stdout_read, stdout_write) = OwnedHandle::pipe(true)?;
    let (stderr_read, stderr_write) = OwnedHandle::pipe(true)?;
    for handle in [stdin_write.0, stdout_read.0, stderr_read.0] {
        if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err(format!("SetHandleInformation failed: {}", unsafe {
                GetLastError()
            }));
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
    startup.hStdInput = stdin_read.0;
    startup.hStdOutput = stdout_write.0;
    startup.hStdError = stderr_write.0;
    let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
    // CREATE_SUSPENDED：进程创建即挂起，等 AssignProcessToJobObject 成功后
    // 才 ResumeThread--保证子进程从第一条指令起就处于 Job 管辖内，
    // 不会出现“先跑起来、再入笼”的窗口。CREATE_NO_WINDOW 避免弹出
    // 额外控制台窗口；环境块按 UTF-16 传递（CREATE_UNICODE_ENVIRONMENT）。
    if namespace_stopped(
        request.shell_namespace.is_some(),
        started,
        request.timeout_ms,
        &cancelled,
    ) {
        return Ok(());
    }
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
    drop(stdin_read);
    drop(stdout_write);
    drop(stderr_write);
    if let Some(error) = create_error {
        return Err(format!("CreateProcessW failed: {error}"));
    }
    let child = job.assign_and_resume(process_info)?;
    send_started(child.id);
    // stdin 写入放在独立线程：子进程不读 stdin 时 write_all 可能永久阻塞，
    // 不能让它卡住主循环的取消/超时判定。
    let mut stream = stdin_write.into_file();
    let (stdin_finished_tx, stdin_finished_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = stream.write_all(&input);
        let _ = stdin_finished_tx.send(());
    });
    // stdout/stderr 各起一个排水线程，边读边转发为流式事件。
    let stdout_finished = emit_stream(stdout_read.into_file(), "stdout");
    let stderr_finished = emit_stream(stderr_read.into_file(), "stderr");
    // 主循环：50ms 轮询一次，兼顾取消/超时的响应速度与 CPU 占用。
    // 四种结局：正常退出（WAIT_OBJECT_0）、协作取消、超时、等待调用本身失败。
    // 取消/超时用 TerminateJobObject 强杀整棵进程树（对齐退出码 130/124）。
    let outcome = loop {
        if let Some(outcome) = job.poll(child.handle.0, started, request.timeout_ms, &cancelled) {
            break outcome;
        }
    };
    job.finish(child.handle.0, outcome)?;
    // A child may leave a descendant holding the inherited read handle or
    // never consume a large stdin payload. Never let that writer prevent
    // the host from reaching the terminal event and dropping its Job.
    let _ = stdin_finished_rx.recv_timeout(Duration::from_secs(2));
    // Some Windows console helpers keep inherited pipe handles open briefly. Do not let
    // output-drain bookkeeping outlive the CommandJob indefinitely.
    let _ = stdout_finished.recv_timeout(Duration::from_secs(2));
    let _ = stderr_finished.recv_timeout(Duration::from_secs(2));
    let exit_code = job.exit_code(child.handle.0, outcome)?;
    send_exit(exit_code, outcome);
    Ok(())
}
