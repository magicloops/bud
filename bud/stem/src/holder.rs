//! The holder process: PTY pump ⇄ ring ⇄ IPC server. Deliberately dumb — it
//! parses no terminal content and its op set is closed (design D2/D3).
//!
//! Lifecycle: `run()` daemonizes (double-fork + setsid, stdio → holder.log —
//! exact mechanics validated in `spikes/holder-survival/`), writes meta.json,
//! spawns the PTY child, then serves `holder.sock` until Kill/Shutdown, child
//! exit + post-exit TTL, or SIGTERM. Session dir layout (see [`crate::registry`]):
//! `<dir>/holder.sock`, `<dir>/meta.json`, `<dir>/ring.log`, `<dir>/holder.log`.
//!
//! meta.json: `{ "pid", "started_at_unix", "holder_version", "ipc_proto_version",
//! "shell", "cwd", "child_pid" }` — written once after daemonize; consumed by
//! [`crate::registry`] for discovery/GC.
//!
//! No tokio here: the holder uses blocking I/O + threads (spawned only AFTER
//! daemonization). Threads: PTY reader (pump → ring + fan-out to subscribers),
//! UDS acceptor, one per connection.

use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use nix::libc;
use nix::sys::signal::{kill, sigaction, SaFlags, SigAction, SigHandler, SigSet, Signal};
use nix::sys::wait::{waitpid, WaitStatus};
use nix::unistd::{fork, setsid, ForkResult, Pid};

use crate::error::{Result, StemError};
use crate::ipc::{self, ClientMsg, HolderMsg, OUTPUT_CHUNK, PROTO_VERSION};
use crate::pty::{self, SpawnSpec};
use crate::ring::{RingFile, RingRead, DEFAULT_RING_CAP};

/// Cap on bytes returned by one `RingRead` response (frames are ≤ MAX_FRAME;
/// clients re-request from `start + bytes.len()` for more).
const RING_READ_MAX: u64 = 128 * 1024;

const ACCEPT_POLL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone)]
pub struct HolderConfig {
    pub session_dir: PathBuf,
    pub spawn: SpawnSpec,
    pub ring_cap: u64,
    /// After the child exits, keep serving the ring this long, then exit.
    pub post_exit_ttl_secs: u64,
}

/// Entry point invoked by `bud term-hold` (hidden subcommand). Parses its args
/// from `args` (everything after `term-hold`), daemonizes, and never returns in
/// the parent-visible sense: the foreground invocation exits once the daemonized
/// holder has signaled readiness (so spawners can wait-for-socket afterwards).
pub fn main(args: &[String]) -> Result<()> {
    let cfg = parse_args(args)?;
    run_holder(cfg, true)
}

/// The daemonized holder body (post-fork). Exposed for integration tests that
/// run a holder in-process on a thread WITHOUT daemonizing.
pub fn run_holder(cfg: HolderConfig, daemonize: bool) -> Result<()> {
    fs::create_dir_all(&cfg.session_dir)?;
    let _ = fs::set_permissions(&cfg.session_dir, fs::Permissions::from_mode(0o700));
    if daemonize {
        match daemonize_in(&cfg.session_dir)? {
            Daemonized::Parent => return Ok(()),
            Daemonized::Grandchild => {
                install_sigterm_handler();
                let code = match holder_body(&cfg) {
                    Ok(()) => 0,
                    Err(e) => {
                        eprintln!("holder: fatal: {e}");
                        1
                    }
                };
                // The grandchild must never return into the caller's main.
                std::process::exit(code);
            }
        }
    }
    holder_body(&cfg)
}

// ---------------------------------------------------------------------------
// Arg parsing (`bud term-hold --dir … --shell … [--env K=V]…`)
// ---------------------------------------------------------------------------

fn parse_args(args: &[String]) -> Result<HolderConfig> {
    let mut dir: Option<PathBuf> = None;
    let mut shell: Option<String> = None;
    let mut cwd = "/".to_string();
    let mut cols: u16 = 80;
    let mut rows: u16 = 24;
    let mut ring_cap = DEFAULT_RING_CAP;
    let mut ttl: u64 = 86_400;
    let mut env: Vec<(String, String)> = Vec::new();
    let mut shell_args: Vec<String> = Vec::new();

    let bad = |m: String| StemError::Other(format!("holder args: {m}"));
    let mut i = 0;
    while i < args.len() {
        let key = args[i].as_str();
        let val = args
            .get(i + 1)
            .ok_or_else(|| bad(format!("{key} requires a value")))?
            .clone();
        match key {
            "--dir" => dir = Some(PathBuf::from(val)),
            "--shell" => shell = Some(val),
            "--cwd" => cwd = val,
            "--cols" => cols = val.parse().map_err(|_| bad(format!("bad --cols {val}")))?,
            "--rows" => rows = val.parse().map_err(|_| bad(format!("bad --rows {val}")))?,
            "--ring-cap" => {
                ring_cap = val
                    .parse()
                    .map_err(|_| bad(format!("bad --ring-cap {val}")))?
            }
            "--ttl" => ttl = val.parse().map_err(|_| bad(format!("bad --ttl {val}")))?,
            "--env" => {
                let (k, v) = val
                    .split_once('=')
                    .ok_or_else(|| bad(format!("--env wants K=V, got {val}")))?;
                env.push((k.to_string(), v.to_string()));
            }
            "--arg" => shell_args.push(val),
            other => return Err(bad(format!("unknown flag {other}"))),
        }
        i += 2;
    }

    Ok(HolderConfig {
        session_dir: dir.ok_or_else(|| bad("--dir is required".into()))?,
        spawn: SpawnSpec {
            shell: shell.ok_or_else(|| bad("--shell is required".into()))?,
            args: shell_args,
            cwd,
            env,
            cols,
            rows,
        },
        ring_cap,
        post_exit_ttl_secs: ttl,
    })
}

// ---------------------------------------------------------------------------
// Daemonization (double-fork + setsid; recipe from spikes/holder-survival)
// ---------------------------------------------------------------------------

enum Daemonized {
    Parent,
    Grandchild,
}

/// Classic double-fork. The original caller (`Parent`) blocks on a pipe until
/// the grandchild signals readiness (or dies), then returns so it can exit 0 —
/// spawners proceed to wait-for-socket. The grandchild returns with stdio
/// redirected to `<dir>/holder.log`.
fn daemonize_in(dir: &Path) -> Result<Daemonized> {
    let (read_fd, write_fd) = nix::unistd::pipe().map_err(std::io::Error::from)?;

    match unsafe { fork() }.map_err(std::io::Error::from)? {
        ForkResult::Parent { child } => {
            drop(write_fd);
            let mut pipe = File::from(read_fd);
            let mut byte = [0u8; 1];
            let _ = pipe.read(&mut byte); // byte written or EOF on grandchild death
            let _ = waitpid(child, None); // reap the intermediate
            return Ok(Daemonized::Parent);
        }
        ForkResult::Child => {}
    }
    drop(read_fd);

    setsid().map_err(std::io::Error::from)?;
    match unsafe { fork() }.map_err(std::io::Error::from)? {
        ForkResult::Parent { .. } => std::process::exit(0),
        ForkResult::Child => {}
    }

    // Grandchild: stdin ← /dev/null, stdout/stderr → holder.log.
    let devnull = File::open("/dev/null")?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("holder.log"))?;
    unsafe {
        libc::dup2(devnull.as_raw_fd(), 0);
        libc::dup2(log.as_raw_fd(), 1);
        libc::dup2(log.as_raw_fd(), 2);
    }
    // Signal the waiting parent, then close the pipe.
    {
        let mut pipe = File::from(write_fd);
        let _ = pipe.write_all(b"1");
    }
    Ok(Daemonized::Grandchild)
}

/// SIGTERM behaves like Shutdown. Installed only in the daemonized grandchild
/// (a process-global handler is wrong for in-process test holders).
static SIGTERM_RECEIVED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_sigterm(_: libc::c_int) {
    SIGTERM_RECEIVED.store(true, Ordering::SeqCst);
}

fn install_sigterm_handler() {
    let action = SigAction::new(
        SigHandler::Handler(on_sigterm),
        SaFlags::empty(),
        SigSet::empty(),
    );
    unsafe {
        let _ = sigaction(Signal::SIGTERM, &action);
    }
}

// ---------------------------------------------------------------------------
// meta.json (hand-rolled flat JSON; serde_json is not a stem dependency)
// ---------------------------------------------------------------------------

pub(crate) fn render_meta_json(
    pid: i32,
    started_at_unix: u64,
    holder_version: &str,
    ipc_proto_version: u16,
    shell: &str,
    cwd: &str,
    child_pid: i32,
) -> String {
    format!(
        concat!(
            "{{\"pid\":{},\"started_at_unix\":{},\"holder_version\":{},",
            "\"ipc_proto_version\":{},\"shell\":{},\"cwd\":{},\"child_pid\":{}}}\n"
        ),
        pid,
        started_at_unix,
        json_string(holder_version),
        ipc_proto_version,
        json_string(shell),
        json_string(cwd),
        child_pid,
    )
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn write_meta(cfg: &HolderConfig, child_pid: i32) -> Result<()> {
    let started_at_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let json = render_meta_json(
        std::process::id() as i32,
        started_at_unix,
        env!("CARGO_PKG_VERSION"),
        PROTO_VERSION,
        &cfg.spawn.shell,
        &cfg.spawn.cwd,
        child_pid,
    );
    fs::write(cfg.session_dir.join("meta.json"), json)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Holder body
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct ChildExit {
    exit_code: Option<i32>,
    signal: Option<i32>,
}

enum SubEvent {
    Output { offset: u64, bytes: Vec<u8> },
    Exited(ChildExit),
}

/// Everything ordered through one mutex: the pump appends + fans out under it,
/// and subscription registration snapshots the ring under it, so a subscriber
/// sees exactly replay-then-live with no gap or duplication.
struct Inner {
    ring: RingFile,
    subscribers: Vec<std_mpsc::Sender<SubEvent>>,
    exit: Option<ChildExit>,
    cols: u16,
    rows: u16,
}

struct Shared {
    inner: Mutex<Inner>,
    master: OwnedFd,
    /// Serializes Write ops onto the PTY master.
    write_lock: Mutex<()>,
    child_pid: i32,
    shutdown: AtomicBool,
    exited_at: Mutex<Option<Instant>>,
}

fn holder_body(cfg: &HolderConfig) -> Result<()> {
    let dir = &cfg.session_dir;
    let ring = RingFile::open(&dir.join("ring.log"), cfg.ring_cap)?;
    let child = pty::spawn(&cfg.spawn)?;
    write_meta(cfg, child.child_pid)?;

    let sock_path = dir.join("holder.sock");
    let _ = fs::remove_file(&sock_path); // unlink stale socket
    let listener = UnixListener::bind(&sock_path)?;
    listener.set_nonblocking(true)?;

    let shared = Arc::new(Shared {
        inner: Mutex::new(Inner {
            ring,
            subscribers: Vec::new(),
            exit: None,
            cols: cfg.spawn.cols,
            rows: cfg.spawn.rows,
        }),
        master: child.master,
        write_lock: Mutex::new(()),
        child_pid: child.child_pid,
        shutdown: AtomicBool::new(false),
        exited_at: Mutex::new(None),
    });
    println!(
        "holder: pid={} child={} dir={}",
        std::process::id(),
        shared.child_pid,
        dir.display()
    );

    let (pump_done_tx, pump_done_rx) = std_mpsc::channel::<()>();
    {
        let sh = Arc::clone(&shared);
        std::thread::spawn(move || {
            pty_pump(&sh);
            drop(pump_done_tx);
        });
    }
    {
        let sh = Arc::clone(&shared);
        std::thread::spawn(move || reap_child(&sh, pump_done_rx));
    }

    let ttl = Duration::from_secs(cfg.post_exit_ttl_secs);
    loop {
        if shared.shutdown.load(Ordering::SeqCst) || SIGTERM_RECEIVED.load(Ordering::SeqCst) {
            break;
        }
        if let Some(t) = *shared.exited_at.lock().unwrap() {
            if t.elapsed() >= ttl {
                break;
            }
        }
        match listener.accept() {
            Ok((conn, _)) => {
                // BSD/macOS accepted sockets inherit the listener's O_NONBLOCK;
                // handlers use blocking I/O, so clear it explicitly.
                if conn.set_nonblocking(false).is_err() {
                    continue;
                }
                let sh = Arc::clone(&shared);
                std::thread::spawn(move || handle_conn(conn, &sh));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(ACCEPT_POLL),
            Err(e) => {
                eprintln!("holder: accept error: {e}");
                std::thread::sleep(ACCEPT_POLL);
            }
        }
    }

    // Teardown: SIGKILL the child if still alive (the reaper thread reaps it),
    // best-effort remove the socket, return (daemonized path then exits).
    if shared.inner.lock().unwrap().exit.is_none() {
        let _ = kill(Pid::from_raw(shared.child_pid), Signal::SIGKILL);
    }
    let _ = fs::remove_file(&sock_path);
    println!("holder: exiting");
    Ok(())
}

/// PTY reader thread: master → ring + subscriber fan-out, all under the inner
/// lock so live offsets stay contiguous with subscription snapshots.
fn pty_pump(sh: &Shared) {
    let mut buf = [0u8; 8192];
    loop {
        match nix::unistd::read(sh.master.as_raw_fd(), &mut buf) {
            Ok(0) => break, // EOF: child side closed
            Ok(n) => {
                let mut inner = sh.inner.lock().unwrap();
                let offset = inner.ring.next_offset();
                if let Err(e) = inner.ring.append(&buf[..n]) {
                    eprintln!("holder: ring append failed: {e}");
                }
                let bytes = &buf[..n];
                inner.subscribers.retain(|tx| {
                    tx.send(SubEvent::Output {
                        offset,
                        bytes: bytes.to_vec(),
                    })
                    .is_ok()
                });
            }
            Err(nix::errno::Errno::EINTR) => continue,
            Err(_) => break, // EIO: child exited
        }
    }
}

/// Reaper thread: waitpid the child, let the pump drain trailing output
/// (bounded), record the status, notify subscribers, then arm the TTL clock.
fn reap_child(sh: &Shared, pump_done: std_mpsc::Receiver<()>) {
    let status = loop {
        match waitpid(Pid::from_raw(sh.child_pid), None) {
            Err(nix::errno::Errno::EINTR) => continue,
            other => break other,
        }
    };
    // Bounded wait for the pump to finish reading buffered output so
    // ChildExited follows the final Output pushes in the common case.
    let _ = pump_done.recv_timeout(Duration::from_secs(2));
    let exit = match status {
        Ok(WaitStatus::Exited(_, code)) => ChildExit {
            exit_code: Some(code),
            signal: None,
        },
        Ok(WaitStatus::Signaled(_, sig, _)) => ChildExit {
            exit_code: None,
            signal: Some(sig as i32),
        },
        _ => ChildExit {
            exit_code: None,
            signal: None,
        },
    };
    {
        let mut inner = sh.inner.lock().unwrap();
        inner.exit = Some(exit);
        inner
            .subscribers
            .retain(|tx| tx.send(SubEvent::Exited(exit)).is_ok());
    }
    // Set AFTER notification so a TTL of 0 still delivers ChildExited first.
    *sh.exited_at.lock().unwrap() = Some(Instant::now());
}

// ---------------------------------------------------------------------------
// Per-connection handler
// ---------------------------------------------------------------------------

fn handle_conn(mut conn: UnixStream, sh: &Shared) {
    // First frame must be Hello.
    let payload = match ipc::read_frame_sync(&mut conn) {
        Ok(p) => p,
        Err(_) => return,
    };
    match ipc::decode_payload::<ClientMsg>(&payload) {
        Ok(ClientMsg::Hello { .. }) => {}
        _ => {
            let _ = ipc::write_msg_sync(
                &mut conn,
                &HolderMsg::Err {
                    msg: "protocol error: expected Hello".into(),
                },
            );
            return;
        }
    }
    if ipc::write_msg_sync(
        &mut conn,
        &HolderMsg::HelloAck {
            proto_version: PROTO_VERSION,
            holder_version: env!("CARGO_PKG_VERSION").to_string(),
            child_pid: sh.child_pid,
        },
    )
    .is_err()
    {
        return;
    }

    loop {
        let payload = match ipc::read_frame_sync(&mut conn) {
            Ok(p) => p,
            Err(_) => return, // client hung up
        };
        let msg = match ipc::decode_payload::<ClientMsg>(&payload) {
            Ok(m) => m,
            Err(e) => {
                let _ = ipc::write_msg_sync(&mut conn, &HolderMsg::Err { msg: e.to_string() });
                return;
            }
        };
        let reply = match msg {
            ClientMsg::Hello { .. } => HolderMsg::Err {
                msg: "protocol error: duplicate Hello".into(),
            },
            ClientMsg::Write { bytes } => match write_master(sh, &bytes) {
                Ok(()) => HolderMsg::Ok,
                Err(e) => HolderMsg::Err { msg: e.to_string() },
            },
            ClientMsg::Resize { cols, rows } => {
                match pty::resize(&sh.master, sh.child_pid, cols, rows) {
                    Ok(()) => {
                        let mut inner = sh.inner.lock().unwrap();
                        inner.cols = cols;
                        inner.rows = rows;
                        HolderMsg::Ok
                    }
                    Err(e) => HolderMsg::Err { msg: e.to_string() },
                }
            }
            ClientMsg::Stat => {
                let inner = sh.inner.lock().unwrap();
                HolderMsg::StatAck {
                    ring_oldest_offset: inner.ring.oldest_offset(),
                    ring_next_offset: inner.ring.next_offset(),
                    child_pid: sh.child_pid,
                    child_alive: inner.exit.is_none(),
                    cols: inner.cols,
                    rows: inner.rows,
                }
            }
            ClientMsg::RingRead { start, end } => ring_read_reply(sh, start, end),
            ClientMsg::Subscribe { from_offset } => {
                let _ = serve_subscription(conn, sh, from_offset);
                return;
            }
            ClientMsg::Kill | ClientMsg::Shutdown => {
                let _ = ipc::write_msg_sync(&mut conn, &HolderMsg::Ok);
                if sh.inner.lock().unwrap().exit.is_none() {
                    let _ = kill(Pid::from_raw(sh.child_pid), Signal::SIGKILL);
                }
                sh.shutdown.store(true, Ordering::SeqCst);
                return;
            }
        };
        if ipc::write_msg_sync(&mut conn, &reply).is_err() {
            return;
        }
    }
}

fn write_master(sh: &Shared, bytes: &[u8]) -> Result<()> {
    let _guard = sh.write_lock.lock().unwrap();
    let mut rest = bytes;
    while !rest.is_empty() {
        match nix::unistd::write(&sh.master, rest) {
            Ok(n) => rest = &rest[n..],
            Err(nix::errno::Errno::EINTR) => continue,
            Err(e) => return Err(StemError::Pty(format!("pty write: {e}"))),
        }
    }
    Ok(())
}

fn ring_read_reply(sh: &Shared, start: u64, end: u64) -> HolderMsg {
    let inner = sh.inner.lock().unwrap();
    // Cap the response size; the effective start (post-clamp) bounds the window.
    let eff_start = start.max(inner.ring.oldest_offset());
    let end = end.min(eff_start.saturating_add(RING_READ_MAX));
    match inner.ring.read_range(start, end) {
        Ok(rr) => HolderMsg::RingData {
            start: rr.start,
            bytes: rr.bytes,
            truncated_from: rr.truncated_from,
        },
        Err(e) => HolderMsg::Err {
            msg: format!("ring read: {e}"),
        },
    }
}

/// Push mode: replay `[from_offset, next)` (Truncated first if clamped), then
/// stream live output until the client disconnects or the holder shuts down.
fn serve_subscription(mut conn: UnixStream, sh: &Shared, from_offset: u64) -> Result<()> {
    let (tx, rx) = std_mpsc::channel::<SubEvent>();
    let (replay, exited): (RingRead, Option<ChildExit>) = {
        let mut inner = sh.inner.lock().unwrap();
        let next = inner.ring.next_offset();
        let replay = inner.ring.read_range(from_offset.min(next), next)?;
        inner.subscribers.push(tx);
        (replay, inner.exit)
    };

    if replay.truncated_from.is_some() {
        ipc::write_msg_sync(
            &mut conn,
            &HolderMsg::Truncated {
                oldest_offset: replay.start,
            },
        )?;
    }
    write_output_chunks(&mut conn, replay.start, &replay.bytes)?;
    if let Some(exit) = exited {
        // Late subscriber: the child already exited before we registered.
        ipc::write_msg_sync(
            &mut conn,
            &HolderMsg::ChildExited {
                exit_code: exit.exit_code,
                signal: exit.signal,
            },
        )?;
    }

    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(SubEvent::Output { offset, bytes }) => {
                write_output_chunks(&mut conn, offset, &bytes)?
            }
            Ok(SubEvent::Exited(exit)) => ipc::write_msg_sync(
                &mut conn,
                &HolderMsg::ChildExited {
                    exit_code: exit.exit_code,
                    signal: exit.signal,
                },
            )?,
            Err(std_mpsc::RecvTimeoutError::Timeout) => {
                if sh.shutdown.load(Ordering::SeqCst) {
                    return Ok(());
                }
            }
            Err(std_mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

fn write_output_chunks(conn: &mut UnixStream, offset: u64, bytes: &[u8]) -> Result<()> {
    let mut off = offset;
    for chunk in bytes.chunks(OUTPUT_CHUNK) {
        ipc::write_msg_sync(
            conn,
            &HolderMsg::Output {
                offset: off,
                bytes: chunk.to_vec(),
            },
        )?;
        off += chunk.len() as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_full() {
        let args: Vec<String> = [
            "--dir",
            "/tmp/x",
            "--shell",
            "/bin/zsh",
            "--cwd",
            "/home/me",
            "--cols",
            "120",
            "--rows",
            "40",
            "--ring-cap",
            "1024",
            "--ttl",
            "0",
            "--env",
            "FOO=bar",
            "--env",
            "BAZ=qu=ux",
            "--arg",
            "-l",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let cfg = parse_args(&args).unwrap();
        assert_eq!(cfg.session_dir, PathBuf::from("/tmp/x"));
        assert_eq!(cfg.spawn.shell, "/bin/zsh");
        assert_eq!(cfg.spawn.cwd, "/home/me");
        assert_eq!((cfg.spawn.cols, cfg.spawn.rows), (120, 40));
        assert_eq!(cfg.ring_cap, 1024);
        assert_eq!(cfg.post_exit_ttl_secs, 0);
        assert_eq!(
            cfg.spawn.env,
            vec![("FOO".into(), "bar".into()), ("BAZ".into(), "qu=ux".into())]
        );
        assert_eq!(cfg.spawn.args, vec!["-l".to_string()]);
    }

    #[test]
    fn parse_args_requires_dir_and_shell() {
        assert!(parse_args(&["--shell".into(), "/bin/sh".into()]).is_err());
        assert!(parse_args(&["--dir".into(), "/tmp/x".into()]).is_err());
        assert!(parse_args(&["--dir".into()]).is_err()); // missing value
        assert!(parse_args(&["--bogus".into(), "1".into()]).is_err());
    }

    #[test]
    fn meta_json_escapes_strings() {
        let json = render_meta_json(1, 2, "0.1.0", 1, "/bin/\"weird\"\\sh", "/tmp\nx", 3);
        assert!(json.contains(r#""shell":"/bin/\"weird\"\\sh""#));
        assert!(json.contains(r#""cwd":"/tmp\nx""#));
        assert!(json.contains(r#""pid":1"#));
        assert!(json.contains(r#""child_pid":3"#));
    }
}
