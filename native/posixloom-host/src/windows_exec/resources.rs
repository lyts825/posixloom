//! Owned Win32 resources and shared Job lifecycle for pipe and ConPTY backends.
//! All raw handles originate from successful Win32 creation calls in this module or its siblings.
use super::*;
use windows_sys::Win32::Foundation::{SetLastError, ERROR_ALREADY_EXISTS};
use windows_sys::Win32::System::JobObjects::{
    JobObjectBasicAccountingInformation, QueryInformationJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
};

pub(super) struct OwnedHandle(pub(super) HANDLE);
impl OwnedHandle {
    pub(super) fn pipe(inheritable: bool) -> Result<(Self, Self), String> {
        let mut read = std::ptr::null_mut();
        let mut write = std::ptr::null_mut();
        // SAFETY: initialized security attributes and valid out-pointers for CreatePipe.
        let mut security: SECURITY_ATTRIBUTES = unsafe { zeroed() };
        security.nLength = size_of::<SECURITY_ATTRIBUTES>() as u32;
        security.bInheritHandle = i32::from(inheritable);
        if unsafe { CreatePipe(&mut read, &mut write, &security, 0) } == 0 {
            return Err(format!("CreatePipe failed: {}", unsafe { GetLastError() }));
        }
        Ok((Self(read), Self(write)))
    }
    pub(super) fn into_file(mut self) -> std::fs::File {
        let raw = std::mem::replace(&mut self.0, std::ptr::null_mut());
        // SAFETY: transfer sole ownership; Drop now sees null and cannot double-close.
        unsafe { std::fs::File::from_raw_handle(raw as _) }
    }
}
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this wrapper owns one valid handle exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }
}

pub(super) struct ChildProcess {
    pub(super) handle: OwnedHandle,
    pub(super) id: u32,
}
pub(super) struct Job(OwnedHandle);
impl Job {
    pub(super) fn new(
        namespace: Option<&str>,
        started: Instant,
        timeout_ms: u64,
        cancelled: &AtomicBool,
    ) -> Result<Option<Self>, String> {
        let name = namespace.map(|key| wide(&format!("Global\\PosixLoom.Shell.Job.{key}")));
        let recovery_started = Instant::now();
        let job = loop {
            if namespace_stopped(namespace.is_some(), started, timeout_ms, cancelled) {
                return Ok(None);
            }
            unsafe { SetLastError(0) };
            let handle = OwnedHandle(unsafe {
                CreateJobObjectW(
                    std::ptr::null(),
                    name.as_ref()
                        .map_or(std::ptr::null(), |value| value.as_ptr()),
                )
            });
            let create_error = unsafe { GetLastError() };
            if handle.0.is_null() {
                return Err(format!("CreateJobObjectW failed: {create_error}"));
            }
            let job = Self(handle);
            if namespace.is_none() || create_error != ERROR_ALREADY_EXISTS {
                break job;
            }
            // An abandoned owner's kill-on-close Job may still be terminating.
            // ActiveProcesses == 0 does not make that old object assignable again:
            // AssignProcessToJobObject rejects a terminating Job. Only use the
            // reopened object for cleanup, then close it and require a NEW object.
            if unsafe { TerminateJobObject(job.handle(), 1) } == 0 {
                return Err(format!(
                    "TerminateJobObject namespace recovery failed: {}",
                    unsafe { GetLastError() }
                ));
            }
            if !job
                .wait_empty_with_stop(|| namespace_stopped(true, started, timeout_ms, cancelled))?
            {
                return Ok(None);
            }
            drop(job);
            if recovery_started.elapsed() >= Duration::from_secs(5) {
                return Err("Previous namespace Job remained open after cleanup".to_string());
            }
            // Retry based on ERROR_ALREADY_EXISTS, never assume a fixed delay is
            // sufficient for kernel teardown or reuse the old object after a wait.
            std::thread::sleep(Duration::from_millis(5));
        };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.handle(),
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
        Ok(Some(job))
    }
    pub(super) fn handle(&self) -> HANDLE {
        self.0 .0
    }
    /// A newly created, suspended process cannot run until it is owned by this Job.
    pub(super) fn assign_and_resume(
        &self,
        info: PROCESS_INFORMATION,
    ) -> Result<ChildProcess, String> {
        let process = OwnedHandle(info.hProcess);
        let thread = OwnedHandle(info.hThread);
        if unsafe { AssignProcessToJobObject(self.handle(), process.0) } == 0 {
            let error = unsafe { GetLastError() };
            unsafe { TerminateProcess(process.0, 1) };
            return Err(format!("AssignProcessToJobObject failed: {error}"));
        }
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            let error = unsafe { GetLastError() };
            unsafe { TerminateProcess(process.0, 1) };
            return Err(format!("ResumeThread failed: {error}"));
        }
        Ok(ChildProcess {
            handle: process,
            id: info.dwProcessId,
        })
    }
    pub(super) fn poll(
        &self,
        process: HANDLE,
        started: Instant,
        timeout: u64,
        cancelled: &AtomicBool,
    ) -> Option<&'static str> {
        let wait = unsafe { WaitForSingleObject(process, 50) };
        if wait == 0 {
            return Some("exited");
        }
        let terminal = if cancelled.load(Ordering::SeqCst) {
            Some(("cancelled", 130))
        } else if started.elapsed() >= Duration::from_millis(timeout) {
            Some(("timed-out", 124))
        } else if wait == u32::MAX {
            Some(("crashed", 1))
        } else {
            None
        };
        terminal.map(|(outcome, code)| {
            unsafe { TerminateJobObject(self.handle(), code) };
            outcome
        })
    }
    pub(super) fn finish(&self, process: HANDLE, outcome: &str) -> Result<(), String> {
        // No detached descendants in protocol v1, including after normal parent exit.
        if outcome == "exited" {
            unsafe { TerminateJobObject(self.handle(), 0) };
        }
        unsafe { WaitForSingleObject(process, 5000) };
        self.wait_empty()
    }
    fn wait_empty(&self) -> Result<(), String> {
        self.wait_empty_with_stop(|| false).map(|_| ())
    }
    fn wait_empty_with_stop(&self, stopped: impl Fn() -> bool) -> Result<bool, String> {
        let started = Instant::now();
        loop {
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
            if unsafe {
                QueryInformationJobObject(
                    self.handle(),
                    JobObjectBasicAccountingInformation,
                    &mut accounting as *mut _ as *mut _,
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(format!("QueryInformationJobObject failed: {}", unsafe {
                    GetLastError()
                }));
            }
            if accounting.ActiveProcesses == 0 {
                return Ok(true);
            }
            if stopped() {
                return Ok(false);
            }
            if started.elapsed() >= Duration::from_secs(5) {
                return Err(
                    "Job process tree did not terminate within cleanup deadline".to_string()
                );
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    pub(super) fn exit_code(&self, process: HANDLE, outcome: &str) -> Result<i32, String> {
        let mut code = 1;
        if unsafe { GetExitCodeProcess(process, &mut code) } == 0 {
            return Err(format!("GetExitCodeProcess failed: {}", unsafe {
                GetLastError()
            }));
        }
        Ok(match outcome {
            "timed-out" => 124,
            "cancelled" => 130,
            _ => code as i32,
        })
    }
}

pub(super) struct PseudoConsole(pub(super) HPCON);
impl Drop for PseudoConsole {
    fn drop(&mut self) {
        // Output draining runs independently before the pseudoconsole is closed.
        if self.0 != 0 {
            unsafe { ClosePseudoConsole(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_recovery_never_reuses_an_existing_job() {
        let key = format!(
            "{:032x}{:032x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let name = wide(&format!("Global\\PosixLoom.Shell.Job.{key}"));
        let old = OwnedHandle(unsafe { CreateJobObjectW(std::ptr::null(), name.as_ptr()) });
        assert!(!old.0.is_null());
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (created_tx, created_rx) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            let result = Job::new(Some(&key), Instant::now(), 2000, &AtomicBool::new(false));
            created_tx.send(()).unwrap();
            result.map(|job| job.is_some())
        });
        ready_rx.recv().unwrap();
        // Even an empty old Job cannot be reused. Its name remains bound until
        // every old handle closes, which this test deliberately controls.
        let premature = created_rx.recv_timeout(Duration::from_millis(100));
        drop(old);
        let result = waiter.join().unwrap();
        assert!(matches!(
            premature,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert_eq!(result, Ok(true));
    }
}
