//! MSYS mount tables belong to the installation and user, not to a Bash process.
//! The mutex coordinates only participating PosixLoom hosts; it is not a sandbox.
use super::*;
use windows_sys::Win32::Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex};

pub(super) struct ShellNamespaceGuard(OwnedHandle);
pub(super) enum NamespaceWait {
    Acquired(ShellNamespaceGuard),
    Stopped(&'static str),
}

impl ShellNamespaceGuard {
    pub(super) fn acquire(
        key: &str,
        started: Instant,
        timeout_ms: u64,
        cancelled: &AtomicBool,
    ) -> Result<NamespaceWait, String> {
        let name = wide(&format!("Global\\PosixLoom.Shell.{key}"));
        // Default user DACL, and deliberately non-inheritable. Mutex ownership is
        // released by Windows if this host thread/process terminates unexpectedly.
        let handle = OwnedHandle(unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) });
        if handle.0.is_null() {
            return Err(format!("CreateMutexW shell namespace failed: {}", unsafe {
                GetLastError()
            }));
        }
        loop {
            if cancelled.load(Ordering::SeqCst) {
                return Ok(NamespaceWait::Stopped("cancelled"));
            }
            if started.elapsed() >= Duration::from_millis(timeout_ms) {
                return Ok(NamespaceWait::Stopped("timed-out"));
            }
            let remaining = Duration::from_millis(timeout_ms).saturating_sub(started.elapsed());
            let wait_ms = remaining.as_millis().clamp(1, 50) as u32;
            match unsafe { WaitForSingleObject(handle.0, wait_ms) } {
                WAIT_OBJECT_0 | WAIT_ABANDONED => {
                    let guard = Self(handle);
                    // The timeout/cancel may have arrived during the kernel wait.
                    if cancelled.load(Ordering::SeqCst) {
                        drop(guard);
                        return Ok(NamespaceWait::Stopped("cancelled"));
                    }
                    if started.elapsed() >= Duration::from_millis(timeout_ms) {
                        drop(guard);
                        return Ok(NamespaceWait::Stopped("timed-out"));
                    }
                    return Ok(NamespaceWait::Acquired(guard));
                }
                WAIT_TIMEOUT => continue,
                _ => {
                    return Err(format!(
                        "WaitForSingleObject shell namespace failed: {}",
                        unsafe { GetLastError() }
                    ))
                }
            }
        }
    }
}

impl Drop for ShellNamespaceGuard {
    fn drop(&mut self) {
        // This guard is created and dropped on the execute thread which owns it.
        unsafe { ReleaseMutex(self.0 .0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn key() -> String {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        format!(
            "{:016x}{:032x}{:016x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn acquire(key: &str) -> ShellNamespaceGuard {
        match ShellNamespaceGuard::acquire(key, Instant::now(), 2000, &AtomicBool::new(false))
            .unwrap()
        {
            NamespaceWait::Acquired(guard) => guard,
            NamespaceWait::Stopped(outcome) => panic!("unexpected namespace outcome: {outcome}"),
        }
    }

    #[test]
    fn same_namespace_waits_and_timeout_includes_wait() {
        let key = key();
        let guard = acquire(&key);
        let other_key = key.clone();
        let outcome = std::thread::spawn(move || {
            match ShellNamespaceGuard::acquire(
                &other_key,
                Instant::now(),
                80,
                &AtomicBool::new(false),
            )
            .unwrap()
            {
                NamespaceWait::Acquired(_) => panic!("namespace was not exclusive"),
                NamespaceWait::Stopped(outcome) => outcome,
            }
        })
        .join()
        .unwrap();
        assert_eq!(outcome, "timed-out");
        drop(guard);
        drop(acquire(&key));
    }

    #[test]
    fn namespace_wait_is_cancellable_without_disturbing_owner() {
        let key = key();
        let owner = acquire(&key);
        let cancelled = Arc::new(AtomicBool::new(false));
        let waiter_flag = cancelled.clone();
        let other_key = key.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            match ShellNamespaceGuard::acquire(&other_key, Instant::now(), 2000, &waiter_flag)
                .unwrap()
            {
                NamespaceWait::Acquired(_) => panic!("namespace was not exclusive"),
                NamespaceWait::Stopped(outcome) => outcome,
            }
        });
        ready_rx.recv().unwrap();
        cancelled.store(true, Ordering::SeqCst);
        assert_eq!(waiter.join().unwrap(), "cancelled");
        // An unrelated namespace remains available while this owner holds its key.
        drop(acquire(&self::key()));
        drop(owner);
        drop(acquire(&key));
    }

    #[test]
    fn abandoned_namespace_owner_is_recovered_by_windows() {
        let key = key();
        let other_key = key.clone();
        let leaked_handle = std::thread::spawn(move || {
            let guard = acquire(&other_key);
            let handle = guard.0 .0 as usize;
            // Mimic a crashed owner thread: no ReleaseMutex, keep its handle alive
            // until the next thread observes the abandoned mutex.
            std::mem::forget(guard);
            handle
        })
        .join()
        .unwrap();
        let recovered = acquire(&key);
        unsafe { CloseHandle(leaked_handle as HANDLE) };
        drop(recovered);
    }
}
