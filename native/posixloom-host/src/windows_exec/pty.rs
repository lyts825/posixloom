use super::*;

pub(super) fn execute_pty(
    request: ExecRequest,
    cancelled: Arc<AtomicBool>,
    controls: std::sync::mpsc::Receiver<RuntimeControl>,
    started: Instant,
) -> Result<(), String> {
    let initial_input = decode_input(request.input_base64.clone())?;
    let columns = request.columns.ok_or("tty columns are missing")?;
    let rows = request.rows.ok_or("tty rows are missing")?;

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

    // ConPTY 需要两条同步管道：输入 read 端和输出 write 端交给 HPCON，
    // 对端由本宿主的独立线程持续写/读，避免同步 IO 互相阻塞。
    let (input_read, input_write) = OwnedHandle::pipe(false)?;
    let (output_read, output_write) = OwnedHandle::pipe(false)?;

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
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attribute_bytes) };
    if attribute_bytes == 0 {
        return Err("InitializeProcThreadAttributeList did not report a size".to_string());
    }
    let words = attribute_bytes.div_ceil(size_of::<usize>());
    let mut attribute_storage = vec![0usize; words];
    let attribute_list = attribute_storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_bytes) } == 0
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
    if namespace_stopped(
        request.shell_namespace.is_some(),
        started,
        request.timeout_ms,
        &cancelled,
    ) {
        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        return Ok(());
    }
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

    let child = job.assign_and_resume(process_info)?;
    send_started(child.id);

    let output_finished = emit_stream(output_read.into_file(), "stdout");
    let (input_tx, input_rx) =
        std::sync::mpsc::sync_channel::<Vec<u8>>(MAX_PENDING_INTERACTIVE_EVENTS);
    let (input_finished_tx, input_finished_rx) = std::sync::mpsc::channel();
    let mut stream = input_write.into_file();
    std::thread::spawn(move || {
        while let Ok(bytes) = input_rx.recv() {
            if stream.write_all(&bytes).is_err() || stream.flush().is_err() {
                break;
            }
        }
        let _ = input_finished_tx.send(());
    });
    let mut input_sender = Some(input_tx);
    if !initial_input.is_empty() {
        input_sender
            .as_ref()
            .unwrap()
            .try_send(initial_input)
            .map_err(|_| "ConPTY initial input channel closed".to_string())?;
    }

    let mut control_error: Option<String> = None;
    let outcome = loop {
        while let Ok(control) = controls.try_recv() {
            match control {
                RuntimeControl::Input(bytes) => {
                    if let Some(sender) = input_sender.as_ref() {
                        match sender.try_send(bytes) {
                            Ok(()) => {}
                            Err(std::sync::mpsc::TrySendError::Full(_)) => {
                                control_error = Some(
                                    "ConPTY pending input exceeded the bounded queue".to_string(),
                                );
                                break;
                            }
                            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                                control_error = Some("ConPTY input channel closed".to_string());
                                break;
                            }
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
                        match sender.try_send(vec![0x1a]) {
                            Ok(()) => {}
                            Err(std::sync::mpsc::TrySendError::Full(_)) => {
                                control_error = Some(
                                    "ConPTY pending input exceeded the bounded queue".to_string(),
                                );
                                break;
                            }
                            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                                control_error = Some("ConPTY input channel closed".to_string());
                                break;
                            }
                        }
                    }
                }
            }
        }
        if control_error.is_some() {
            unsafe { TerminateJobObject(job.handle(), 1) };
            break "crashed";
        }
        if let Some(outcome) = job.poll(child.handle.0, started, request.timeout_ms, &cancelled) {
            break outcome;
        }
    };
    job.finish(child.handle.0, outcome)?;
    drop(input_sender.take());

    let exit_code = job.exit_code(child.handle.0, outcome);
    // 输出线程已在独立线程持续排水，此时关闭 HPCON 以便它收到最终 EOF。
    drop(pseudo);
    let _ = input_finished_rx.recv_timeout(Duration::from_secs(2));
    let _ = output_finished.recv_timeout(Duration::from_secs(2));
    if let Some(error) = control_error {
        return Err(error);
    }
    send_exit(exit_code?, outcome);
    Ok(())
}
