//! The detached child under test.
//!
//! Lifecycle:
//!   1. double-fork daemonize (fork → setsid → fork), stdio redirected to <dir>/holder.log
//!   2. write <dir>/meta.json {pid, started_at, version}
//!   3. open a real PTY (nix openpty + fork/exec) running a 1s tick loop under /bin/sh
//!   4. append all PTY output to <dir>/ring.log
//!   5. serve <dir>/holder.sock with a trivial line protocol:
//!      `HELLO` -> `OK spike-1 <holder_pid>`;
//!      `STAT` -> `OK <ring_bytes> <child_pid>`;
//!      `TAIL <n>` -> `OK <len>` + newline followed by the last `<len>` (<= n) raw bytes of ring.log;
//!      `WRITE <base64>` -> `OK` (bytes written to the PTY master);
//!      `KILL` -> `OK` (SIGKILLs the PTY child, removes the socket, exits)
//!
//! PTY choice: `nix::pty::openpty` + manual fork/exec (not `portable-pty`). Rationale: the
//! holder must daemonize before any threads exist, so everything here is raw fds and std
//! threads; openpty keeps the dependency surface identical to the daemonize code. The
//! production holder is expected to use `portable-pty` (design D4) — that difference does
//! not affect what this spike measures (process survival, not PTY ergonomics).

use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use nix::sys::signal::{kill, Signal};
use nix::sys::wait::waitpid;
use nix::unistd::{execvp, fork, setsid, ForkResult, Pid};

use crate::VERSION;

const TICK_SCRIPT: &str =
    r#"i=0; while true; do echo "tick $i $(date +%s)"; i=$((i+1)); sleep 1; done"#;

pub fn run(dir: &Path) -> i32 {
    if let Err(e) = fs::create_dir_all(dir) {
        eprintln!("holder: cannot create {}: {e}", dir.display());
        return 1;
    }
    // Registry dir is 0700 per design D3b.
    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));

    daemonize(&dir.join("holder.log"));
    // From here on we are the daemonized grandchild; stdout/stderr go to holder.log.

    let _ = std::env::set_current_dir(dir);

    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let meta = crate::Meta {
        pid: std::process::id() as i32,
        started_at,
        version: VERSION.to_string(),
    };
    match serde_json::to_vec_pretty(&meta) {
        Ok(json) => {
            if let Err(e) = fs::write(crate::meta_path(dir), json) {
                eprintln!("holder: cannot write meta.json: {e}");
                return 1;
            }
        }
        Err(e) => {
            eprintln!("holder: cannot serialize meta.json: {e}");
            return 1;
        }
    }

    let (master, child_pid) = match spawn_pty_shell() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("holder: PTY setup failed: {e}");
            return 1;
        }
    };
    println!(
        "holder: pid={} pty_child={} version={}",
        std::process::id(),
        child_pid,
        VERSION
    );

    let master = Arc::new(master);
    let ring_path = dir.join("ring.log");

    // PTY reader thread: append everything the PTY produces to ring.log.
    {
        let master = Arc::clone(&master);
        let ring_path = ring_path.clone();
        std::thread::spawn(move || pty_pump(master, ring_path, child_pid));
    }

    serve_uds(dir, master, child_pid, ring_path)
}

/// Classic double-fork daemonization. Both intermediate parents exit(0); the surviving
/// grandchild is a session leader's child (cannot reacquire a controlling terminal),
/// with stdin from /dev/null and stdout/stderr appended to `log_path`.
fn daemonize(log_path: &Path) {
    match unsafe { fork() }.expect("holder: first fork failed") {
        ForkResult::Parent { .. } => std::process::exit(0),
        ForkResult::Child => {}
    }
    setsid().expect("holder: setsid failed");
    match unsafe { fork() }.expect("holder: second fork failed") {
        ForkResult::Parent { .. } => std::process::exit(0),
        ForkResult::Child => {}
    }

    let devnull = File::open("/dev/null").expect("holder: open /dev/null");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .expect("holder: open holder.log");
    unsafe {
        libc::dup2(devnull.as_raw_fd(), 0);
        libc::dup2(log.as_raw_fd(), 1);
        libc::dup2(log.as_raw_fd(), 2);
    }
    // devnull/log drop here; fds 0/1/2 keep the descriptions alive.
}

/// Open a PTY and fork /bin/sh -c TICK_SCRIPT onto the slave side.
fn spawn_pty_shell() -> Result<(OwnedFd, Pid), String> {
    let pty = nix::pty::openpty(None, None).map_err(|e| format!("openpty: {e}"))?;

    match unsafe { fork() }.map_err(|e| format!("fork: {e}"))? {
        ForkResult::Child => {
            // New session so the slave can become our controlling terminal.
            let _ = setsid();
            unsafe {
                libc::ioctl(pty.slave.as_raw_fd(), libc::TIOCSCTTY as _, 0);
                libc::dup2(pty.slave.as_raw_fd(), 0);
                libc::dup2(pty.slave.as_raw_fd(), 1);
                libc::dup2(pty.slave.as_raw_fd(), 2);
            }
            drop(pty); // close the original master/slave fds; 0/1/2 remain

            let sh = CString::new("/bin/sh").unwrap();
            let args = [
                CString::new("sh").unwrap(),
                CString::new("-c").unwrap(),
                CString::new(TICK_SCRIPT).unwrap(),
            ];
            let _ = execvp(&sh, &args);
            unsafe { libc::_exit(127) };
        }
        ForkResult::Parent { child } => {
            drop(pty.slave); // holder keeps only the master
            Ok((pty.master, child))
        }
    }
}

/// Read PTY master → append to ring.log until EOF/EIO (child exited).
fn pty_pump(master: Arc<OwnedFd>, ring_path: PathBuf, child: Pid) {
    let mut ring = match OpenOptions::new().create(true).append(true).open(&ring_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("holder: cannot open ring.log: {e}");
            return;
        }
    };
    let mut buf = [0u8; 8192];
    loop {
        match nix::unistd::read(master.as_raw_fd(), &mut buf) {
            Ok(0) => {
                eprintln!("holder: PTY EOF; child exited");
                break;
            }
            Ok(n) => {
                let _ = ring.write_all(&buf[..n]);
                let _ = ring.flush();
            }
            Err(nix::errno::Errno::EINTR) => continue,
            Err(nix::errno::Errno::EIO) => {
                eprintln!("holder: PTY EIO; child exited");
                break;
            }
            Err(e) => {
                eprintln!("holder: PTY read error: {e}");
                break;
            }
        }
    }
    let _ = waitpid(child, None); // reap; STAT liveness then reports the pid as dead
}

fn serve_uds(dir: &Path, master: Arc<OwnedFd>, child: Pid, ring_path: PathBuf) -> i32 {
    let sock_path = dir.join("holder.sock");
    let _ = fs::remove_file(&sock_path);
    let listener = match UnixListener::bind(&sock_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("holder: cannot bind {}: {e}", sock_path.display());
            return 1;
        }
    };
    println!("holder: serving {}", sock_path.display());

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let master = Arc::clone(&master);
                let ring_path = ring_path.clone();
                let sock_path = sock_path.clone();
                std::thread::spawn(move || handle_conn(s, master, child, ring_path, sock_path));
            }
            Err(e) => eprintln!("holder: accept error: {e}"),
        }
    }
    0
}

fn handle_conn(
    stream: UnixStream,
    master: Arc<OwnedFd>,
    child: Pid,
    ring_path: PathBuf,
    sock_path: PathBuf,
) {
    let mut reader = match stream.try_clone() {
        Ok(s) => BufReader::new(s),
        Err(_) => return,
    };
    let mut writer = stream;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return, // client hung up
            Ok(_) => {}
        }
        let cmd_line = line.trim_end();
        let mut parts = cmd_line.splitn(2, ' ');
        let verb = parts.next().unwrap_or("");
        let arg = parts.next().unwrap_or("");

        let result = match verb {
            "HELLO" => writeln!(writer, "OK {} {}", VERSION, std::process::id()),
            "STAT" => {
                let ring_bytes = fs::metadata(&ring_path).map(|m| m.len()).unwrap_or(0);
                writeln!(writer, "OK {} {}", ring_bytes, child.as_raw())
            }
            "TAIL" => match arg.trim().parse::<u64>() {
                Ok(n) => match tail_bytes(&ring_path, n) {
                    Ok(bytes) => writeln!(writer, "OK {}", bytes.len())
                        .and_then(|_| writer.write_all(&bytes)),
                    Err(e) => writeln!(writer, "ERR tail: {e}"),
                },
                Err(_) => writeln!(writer, "ERR TAIL wants a byte count"),
            },
            "WRITE" => match B64.decode(arg.trim()) {
                Ok(bytes) => match nix::unistd::write(master.as_ref(), &bytes) {
                    Ok(_) => writeln!(writer, "OK"),
                    Err(e) => writeln!(writer, "ERR pty write: {e}"),
                },
                Err(e) => writeln!(writer, "ERR base64: {e}"),
            },
            "KILL" => {
                let _ = writeln!(writer, "OK");
                let _ = writer.flush();
                println!("holder: KILL received; terminating child {child} and exiting");
                let _ = kill(child, Signal::SIGKILL);
                let _ = waitpid(child, None);
                let _ = fs::remove_file(&sock_path);
                std::process::exit(0);
            }
            "" => writeln!(writer, "ERR empty command"),
            other => writeln!(writer, "ERR unknown command: {other}"),
        };
        if result.is_err() {
            return; // client write failed; drop the connection
        }
        let _ = writer.flush();
    }
}

/// Last `n` bytes of ring.log (fewer if the file is shorter).
fn tail_bytes(ring_path: &Path, n: u64) -> std::io::Result<Vec<u8>> {
    let mut f = File::open(ring_path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(n);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf)?;
    Ok(buf)
}
