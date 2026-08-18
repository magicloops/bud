//! holder-survival — Phase 0 spike harness.
//!
//! Subcommands:
//!   holder      --dir <session_dir>            detached child under test (daemonizes itself)
//!   fake-daemon --dir <session_dir> [--once]   daemon stand-in: spawn-or-reattach, verify, attach
//!   check       --dir <session_dir>            verification probe (exit 0 iff all criteria pass)
//!   stop        --dir <session_dir>            send KILL over the UDS and confirm cleanup
//!
//! This approximates the future holder mechanics from design D2/D3. It is NOT the real
//! implementation — the IPC here is a trivial line protocol, not the framed postcard protocol.

mod holder;

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use nix::sys::signal::kill;
use nix::unistd::Pid;

pub const VERSION: &str = "spike-1";

fn usage() -> ! {
    eprintln!(
        "usage: holder-survival <holder|fake-daemon|check|stop> --dir <session_dir> [--once]"
    );
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        usage();
    }
    let sub = args[1].clone();
    let mut dir: Option<PathBuf> = None;
    let mut once = false;
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--dir" => {
                i += 1;
                match args.get(i) {
                    Some(v) => dir = Some(PathBuf::from(v)),
                    None => usage(),
                }
            }
            "--once" => once = true,
            other => {
                eprintln!("unknown argument: {other}");
                usage();
            }
        }
        i += 1;
    }
    let dir = match dir {
        Some(d) => d,
        None => {
            eprintln!("--dir <session_dir> is required");
            usage();
        }
    };

    let code = match sub.as_str() {
        "holder" => holder::run(&dir),
        "fake-daemon" => cmd_fake_daemon(&dir, once),
        "check" => cmd_check(&dir),
        "stop" => cmd_stop(&dir),
        _ => usage(),
    };
    std::process::exit(code);
}

// ---------------------------------------------------------------------------
// meta.json
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct Meta {
    pub pid: i32,
    pub started_at: u64,
    pub version: String,
}

pub fn meta_path(dir: &Path) -> PathBuf {
    dir.join("meta.json")
}

fn read_meta(dir: &Path) -> Option<Meta> {
    let raw = fs::read(meta_path(dir)).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn pid_alive(pid: i32) -> bool {
    kill(Pid::from_raw(pid), None).is_ok()
}

// ---------------------------------------------------------------------------
// UDS client
// ---------------------------------------------------------------------------

struct Client {
    writer: UnixStream,
    reader: BufReader<UnixStream>,
}

impl Client {
    fn connect(dir: &Path) -> std::io::Result<Self> {
        let stream = UnixStream::connect(dir.join("holder.sock"))?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.set_write_timeout(Some(Duration::from_secs(3)))?;
        let reader = BufReader::new(stream.try_clone()?);
        Ok(Client { writer: stream, reader })
    }

    /// Send one command line, read one response line (trailing newline stripped).
    fn cmd(&mut self, line: &str) -> std::io::Result<String> {
        self.writer.write_all(line.as_bytes())?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()?;
        let mut resp = String::new();
        let n = self.reader.read_line(&mut resp)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "holder closed the connection",
            ));
        }
        Ok(resp.trim_end().to_string())
    }

    /// `TAIL <n>` → header `OK <len>` followed by `<len>` raw bytes.
    fn tail(&mut self, n: usize) -> std::io::Result<Vec<u8>> {
        let hdr = self.cmd(&format!("TAIL {n}"))?;
        let len: usize = hdr
            .strip_prefix("OK ")
            .and_then(|s| s.trim().parse().ok())
            .ok_or_else(|| {
                std::io::Error::other(format!("unexpected TAIL header: {hdr}"))
            })?;
        let mut buf = vec![0u8; len];
        self.reader.read_exact(&mut buf)?;
        Ok(buf)
    }

    /// `STAT` → `OK <ring_bytes> <child_pid>`.
    fn stat(&mut self) -> std::io::Result<(u64, i32)> {
        let resp = self.cmd("STAT")?;
        let mut parts = resp.split_whitespace();
        if parts.next() != Some("OK") {
            return Err(std::io::Error::other(format!("STAT failed: {resp}")));
        }
        let ring: u64 = parts
            .next()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| std::io::Error::other(format!("bad STAT: {resp}")))?;
        let child: i32 = parts
            .next()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| std::io::Error::other(format!("bad STAT: {resp}")))?;
        Ok((ring, child))
    }
}

/// True iff the socket exists, accepts a connection, and answers HELLO with `OK ...`.
fn probe_alive(dir: &Path) -> bool {
    if !dir.join("holder.sock").exists() {
        return false;
    }
    match Client::connect(dir) {
        Ok(mut c) => matches!(c.cmd("HELLO"), Ok(r) if r.starts_with("OK ")),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// fake-daemon
// ---------------------------------------------------------------------------

fn cmd_fake_daemon(dir: &Path, once: bool) -> i32 {
    if let Err(e) = fs::create_dir_all(dir) {
        eprintln!("[fake-daemon] cannot create {}: {e}", dir.display());
        return 1;
    }

    let mut spawned_fresh = false;
    if probe_alive(dir) {
        println!("[fake-daemon] live holder found at {} — reattaching", dir.display());
    } else {
        println!(
            "[fake-daemon] no live holder at {} — spawning detached holder",
            dir.display()
        );
        let _ = fs::remove_file(dir.join("holder.sock")); // clear stale socket, if any
        // Re-invoke our own executable with the `holder` subcommand — this mirrors the
        // production single-binary plan (design D1: `bud term-hold` hidden subcommand).
        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[fake-daemon] current_exe failed: {e}");
                return 1;
            }
        };
        let child = Command::new(&exe)
            .arg("holder")
            .arg("--dir")
            .arg(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match child {
            Ok(mut c) => {
                // The spawned process double-forks; this direct child exits immediately.
                let _ = c.wait();
            }
            Err(e) => {
                eprintln!("[fake-daemon] failed to spawn holder: {e}");
                return 1;
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if probe_alive(dir) {
                break;
            }
            if Instant::now() > deadline {
                eprintln!(
                    "[fake-daemon] holder did not come up within 5s (see {}/holder.log)",
                    dir.display()
                );
                return 1;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        spawned_fresh = true;
    }

    let mut client = match Client::connect(dir) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[fake-daemon] connect failed: {e}");
            return 1;
        }
    };
    match client.cmd("HELLO") {
        Ok(r) => println!("[fake-daemon] HELLO -> {r}"),
        Err(e) => {
            eprintln!("[fake-daemon] HELLO failed: {e}");
            return 1;
        }
    }
    match client.stat() {
        Ok((ring, child)) => {
            println!("[fake-daemon] STAT  -> ring_bytes={ring} child_pid={child}")
        }
        Err(e) => {
            eprintln!("[fake-daemon] STAT failed: {e}");
            return 1;
        }
    }
    match read_meta(dir) {
        Some(m) => println!(
            "[fake-daemon] meta.json -> pid={} started_at={} version={} ({})",
            m.pid,
            m.started_at,
            m.version,
            if spawned_fresh { "freshly spawned" } else { "pre-existing holder" }
        ),
        None => eprintln!("[fake-daemon] warning: meta.json missing or unreadable"),
    }

    if once {
        println!("[fake-daemon] --once: verified, exiting. Holder stays up.");
        return 0;
    }

    println!("[fake-daemon] attached; printing TAIL 256 every 2s. Ctrl-C to exit (holder keeps running).");
    loop {
        std::thread::sleep(Duration::from_secs(2));
        match client.tail(256) {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                let last = text.lines().rev().take(3).collect::<Vec<_>>();
                for line in last.iter().rev() {
                    println!("[tail] {line}");
                }
            }
            Err(e) => {
                eprintln!("[fake-daemon] lost holder connection: {e}");
                return 1;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

fn cmd_check(dir: &Path) -> i32 {
    let mut all_pass = true;

    // Criterion 1: holder pid (from meta.json) is alive.
    match read_meta(dir) {
        Some(m) if pid_alive(m.pid) => {
            println!("PASS holder_pid_alive pid={}", m.pid);
        }
        Some(m) => {
            println!("FAIL holder_pid_alive pid={} (not running)", m.pid);
            all_pass = false;
        }
        None => {
            println!("FAIL holder_pid_alive (meta.json missing/unreadable at {})", dir.display());
            all_pass = false;
        }
    }

    // Criterion 2: UDS HELLO round-trips.
    let client = match Client::connect(dir) {
        Ok(mut c) => match c.cmd("HELLO") {
            Ok(r) if r.starts_with("OK ") => {
                println!("PASS uds_hello response=\"{r}\"");
                Some(c)
            }
            Ok(r) => {
                println!("FAIL uds_hello unexpected response=\"{r}\"");
                all_pass = false;
                None
            }
            Err(e) => {
                println!("FAIL uds_hello io_error={e}");
                all_pass = false;
                None
            }
        },
        Err(e) => {
            println!("FAIL uds_hello connect_error={e}");
            all_pass = false;
            None
        }
    };

    // Criterion 3: ring_bytes strictly increasing across a 2.5s window (PTY child live).
    match client {
        Some(mut c) => {
            let first = c.stat();
            std::thread::sleep(Duration::from_millis(2500));
            let second = c.stat();
            match (first, second) {
                (Ok((r0, child0)), Ok((r1, _child1))) => {
                    if r1 > r0 {
                        println!(
                            "PASS ring_growing t0={r0} t1={r1} (+{} bytes over 2.5s, child_pid={child0})",
                            r1 - r0
                        );
                    } else {
                        println!("FAIL ring_growing t0={r0} t1={r1} (no growth over 2.5s)");
                        all_pass = false;
                    }
                }
                (a, b) => {
                    println!("FAIL ring_growing stat_errors t0={a:?} t1={b:?}");
                    all_pass = false;
                }
            }
        }
        None => {
            println!("FAIL ring_growing (skipped: no UDS connection)");
            all_pass = false;
        }
    }

    println!("RESULT {}", if all_pass { "PASS" } else { "FAIL" });
    if all_pass {
        0
    } else {
        1
    }
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

fn cmd_stop(dir: &Path) -> i32 {
    let meta = read_meta(dir);
    let mut client = match Client::connect(dir) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[stop] connect failed: {e} (holder already gone?)");
            return match meta {
                Some(m) if pid_alive(m.pid) => {
                    eprintln!("[stop] holder pid {} still alive but socket dead — kill it manually", m.pid);
                    1
                }
                _ => {
                    println!("[stop] nothing to stop");
                    0
                }
            };
        }
    };
    // The holder replies OK then exits; tolerate the reply racing the process exit.
    match client.cmd("KILL") {
        Ok(r) => println!("[stop] KILL -> {r}"),
        Err(e) => println!("[stop] KILL sent (reply lost to exit race: {e})"),
    }

    if let Some(m) = meta {
        let deadline = Instant::now() + Duration::from_secs(5);
        while pid_alive(m.pid) {
            if Instant::now() > deadline {
                eprintln!("[stop] holder pid {} still alive after 5s", m.pid);
                return 1;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        println!("[stop] holder pid {} exited", m.pid);
    }
    let sock = dir.join("holder.sock");
    if sock.exists() {
        eprintln!("[stop] warning: {} still present", sock.display());
        return 1;
    }
    println!("[stop] socket removed; cleanup confirmed");
    0
}
