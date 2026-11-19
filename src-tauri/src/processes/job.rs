//! Windows Job Object that owns every process Pult spawns.
//!
//! `kill_on_drop` only runs when a `Child` is dropped, and Tauri's exit path
//! ends in `process::exit`: destructors never run there, so agents warmed or
//! running at close time used to survive as orphans (98 of them, 1.7 GB).
//! The job's `KILL_ON_JOB_CLOSE` limit makes the OS tear the whole tree down
//! when the last handle closes — including a crash, a Task Manager kill, or
//! the recovery restart's `process::exit`.

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    struct Job(HANDLE);

    // A kernel handle is just a number: sharing the value across threads is
    // sound, and the job outlives every caller (OnceLock holds it forever).
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Drop for Job {
        fn drop(&mut self) {
            // Never runs in practice (OnceLock is never dropped); kept so a
            // future owner of the handle still closes it.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn job() -> Option<&'static Job> {
        static JOB: OnceLock<Option<Job>> = OnceLock::new();
        JOB.get_or_init(|| unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if configured == 0 {
                CloseHandle(handle);
                return None;
            }
            Some(Job(handle))
        })
        .as_ref()
    }

    /// Put `pid` into the app-wide job. Best effort: a failure never blocks a
    /// spawn, it only loses the crash-proof guarantee for that child.
    pub fn adopt(pid: u32) {
        let Some(job) = job() else {
            return;
        };
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return;
            }
            AssignProcessToJobObject(job.0, process);
            CloseHandle(process);
        }
    }

    /// Test seam: is `pid` a member of the app-wide job?
    pub fn is_member(pid: u32) -> bool {
        let Some(job) = job() else {
            return false;
        };
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut member: i32 = 0;
            let asked = IsProcessInJob(process, job.0, &mut member);
            CloseHandle(process);
            asked != 0 && member != 0
        }
    }
}

#[cfg(windows)]
pub use imp::{adopt, is_member};

/// Off Windows the posix path kills the process group instead; nothing to do.
#[cfg(not(windows))]
pub fn adopt(_pid: u32) {}

#[cfg(not(windows))]
pub fn is_member(_pid: u32) -> bool {
    false
}
