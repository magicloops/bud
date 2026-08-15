//! PTY spawn/resize primitives (holder-side).
//!
//! Uses `nix::pty::openpty` + fork/exec rather than `portable-pty` — the holder
//! must daemonize (double-fork + setsid) BEFORE any threads exist, so raw fds
//! keep that path sound. Mechanics proven in `spikes/holder-survival/`.
//! (Recorded as a D4 amendment in the design doc.)
//!
//! Fork discipline: everything that allocates (argv/envp CStrings, PATH
//! resolution) happens BEFORE `fork()`; the child branch performs only
//! async-signal-safe syscalls (`setsid`, `ioctl`, `dup2`, `close`, `chdir`,
//! `execve`, `_exit`), so spawning from an already-threaded test process is
//! safe too.

use std::collections::BTreeMap;
use std::ffi::CString;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use nix::libc;
use nix::pty::Winsize;
use nix::sys::signal::{kill, Signal};
use nix::sys::termios::Termios;
use nix::unistd::{execve, fork, ForkResult, Pid};

use crate::error::{Result, StemError};

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub shell: String,
    /// argv after the shell binary (e.g. `["-l"]`); empty for default.
    pub args: Vec<String>,
    pub cwd: String,
    /// Extra environment (TERM etc. get sane defaults if absent).
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

pub struct PtyChild {
    /// PTY master fd (holder reads output / writes input here).
    pub master: OwnedFd,
    pub child_pid: i32,
}

/// Open a PTY and fork/exec `spec` on the slave side (new session, TIOCSCTTY,
/// stdio on the slave). Returns the master and child pid.
pub fn spawn(spec: &SpawnSpec) -> Result<PtyChild> {
    let ws = Winsize {
        ws_row: spec.rows,
        ws_col: spec.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    // Everything allocating happens pre-fork (see module docs).
    let program = resolve_program(&spec.shell);
    let c_program =
        CString::new(program).map_err(|_| StemError::Pty("shell path contains NUL".into()))?;
    let mut argv = Vec::with_capacity(1 + spec.args.len());
    argv.push(
        CString::new(spec.shell.as_str())
            .map_err(|_| StemError::Pty("shell contains NUL".into()))?,
    );
    for a in &spec.args {
        argv.push(CString::new(a.as_str()).map_err(|_| StemError::Pty("arg contains NUL".into()))?);
    }
    let envp = build_envp(spec)?;
    let c_cwd =
        CString::new(spec.cwd.as_str()).map_err(|_| StemError::Pty("cwd contains NUL".into()))?;
    let c_root = CString::new("/").expect("static");

    let pty = nix::pty::openpty(Some(&ws), None::<&Termios>)
        .map_err(|e| StemError::Pty(format!("openpty: {e}")))?;

    match unsafe { fork() }.map_err(|e| StemError::Pty(format!("fork: {e}")))? {
        ForkResult::Child => {
            // Async-signal-safe territory only from here to execve/_exit.
            unsafe {
                libc::setsid();
                libc::ioctl(pty.slave.as_raw_fd(), libc::TIOCSCTTY as _, 0);
                libc::dup2(pty.slave.as_raw_fd(), 0);
                libc::dup2(pty.slave.as_raw_fd(), 1);
                libc::dup2(pty.slave.as_raw_fd(), 2);
                // Close everything else inherited from the holder (ring file,
                // sockets, the pty fds themselves — stdio keeps the slave alive).
                for fd in 3..1024 {
                    libc::close(fd);
                }
                if libc::chdir(c_cwd.as_ptr()) != 0 {
                    let _ = libc::chdir(c_root.as_ptr());
                }
            }
            let _ = execve(&c_program, &argv, &envp);
            unsafe { libc::_exit(127) };
        }
        ForkResult::Parent { child } => {
            drop(pty.slave); // holder keeps only the master
            Ok(PtyChild {
                master: pty.master,
                child_pid: child.as_raw(),
            })
        }
    }
}

/// TIOCSWINSZ on the master; then SIGWINCH the child.
pub fn resize(master: &OwnedFd, child_pid: i32, cols: u16, rows: u16) -> Result<()> {
    let ws = Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let rc = unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ as _, &ws) };
    if rc != 0 {
        return Err(StemError::Pty(format!(
            "TIOCSWINSZ: {}",
            std::io::Error::last_os_error()
        )));
    }
    // Positive pid: signal the child directly (the holder tracks it).
    let _ = kill(Pid::from_raw(child_pid), Signal::SIGWINCH);
    Ok(())
}

/// Resolve a bare program name against PATH (execve does no lookup). A name
/// containing `/` is used as-is; unresolvable names fall through unchanged and
/// exec fails in the child (exit 127).
fn resolve_program(shell: &str) -> String {
    if shell.contains('/') {
        return shell.to_string();
    }
    let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string());
    for dir in path.split(':').filter(|d| !d.is_empty()) {
        let candidate = Path::new(dir).join(shell);
        if let Ok(meta) = std::fs::metadata(&candidate) {
            if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    shell.to_string()
}

/// Inherited environment + TERM/COLORTERM defaults, with `spec.env` winning.
fn build_envp(spec: &SpawnSpec) -> Result<Vec<CString>> {
    let mut merged: BTreeMap<String, String> = std::env::vars().collect();
    merged.insert("TERM".to_string(), "xterm-256color".to_string());
    merged.insert("COLORTERM".to_string(), "truecolor".to_string());
    for (k, v) in &spec.env {
        merged.insert(k.clone(), v.clone());
    }
    let mut envp = Vec::with_capacity(merged.len());
    for (k, v) in merged {
        if k.contains('\0') || v.contains('\0') {
            continue;
        }
        envp.push(CString::new(format!("{k}={v}")).expect("NUL filtered above"));
    }
    Ok(envp)
}
