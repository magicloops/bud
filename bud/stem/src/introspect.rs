//! Process introspection (design D11): cwd and foreground process for a
//! session's child, platform-specific (macOS libproc / Linux procfs). OSC 7 is
//! preferred when the shell reports it; these are the fallback.

use std::path::PathBuf;

/// Current working directory of `pid`. Linux: `readlink /proc/<pid>/cwd`.
/// macOS: `proc_pidinfo(PROC_PIDVNODEPATHINFO)`. `None` if unavailable/dead.
#[cfg(target_os = "linux")]
pub fn process_cwd(pid: i32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "macos")]
pub fn process_cwd(pid: i32) -> Option<PathBuf> {
    use nix::libc;
    // SAFETY: proc_vnodepathinfo is plain-old-data; libproc fills it or errors.
    unsafe {
        let mut info: libc::proc_vnodepathinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
        let ret = libc::proc_pidinfo(
            pid,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        );
        if ret <= 0 {
            return None;
        }
        let bytes: &[u8] = std::slice::from_raw_parts(
            info.pvi_cdir.vip_path.as_ptr() as *const u8,
            info.pvi_cdir.vip_path.len(),
        );
        let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
        if end == 0 {
            return None;
        }
        Some(PathBuf::from(
            String::from_utf8_lossy(&bytes[..end]).into_owned(),
        ))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn process_cwd(_pid: i32) -> Option<PathBuf> {
    None
}

/// Foreground process group on a PTY (`tcgetpgrp`). NOTE: requires the PTY
/// master fd, which lives in the HOLDER process — this is a holder-side
/// utility, unusable from the daemon today. Kept for the planned additive
/// `Stat` extension that would report the foreground pgid over IPC.
pub fn foreground_pgid(master_fd: i32) -> Option<i32> {
    use std::os::fd::BorrowedFd;
    // SAFETY: caller guarantees `master_fd` is a live fd for the call duration.
    let fd = unsafe { BorrowedFd::borrow_raw(master_fd) };
    nix::unistd::tcgetpgrp(fd).ok().map(|pgid| pgid.as_raw())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_cwd_resolves() {
        let pid = std::process::id() as i32;
        let cwd = process_cwd(pid).expect("own cwd should resolve");
        assert!(cwd.is_absolute());
        // Should match the process's actual cwd.
        assert_eq!(cwd, std::env::current_dir().unwrap());
    }

    #[test]
    fn dead_pid_does_not_panic() {
        // Whether a random high pid exists is racy; the assertion is no panic
        // and no garbage path.
        if let Some(p) = process_cwd(4_190_000) {
            assert!(p.is_absolute());
        }
    }
}
