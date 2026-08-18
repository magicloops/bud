//! Session discovery and holder spawning (daemon-side).
//!
//! Layout: `<base>/<session_id>/{holder.sock, meta.json, ring.log, holder.log}`
//! with `<base>` created 0700 (default `~/.bud/term`, but always injected — stem
//! never hardcodes home paths). Session ids are caller-owned strings (the
//! service's `sess_<ULID>`); they must be path-safe, enforced here.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use nix::sys::signal::kill;
use nix::unistd::Pid;

use crate::client::HolderClient;
use crate::error::{Result, StemError};
use crate::ipc::{self, ClientMsg, HolderMsg, PROTO_VERSION};
use crate::pty::SpawnSpec;

/// Probe timeout for "is this holder alive" checks.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1000);
/// How long `ensure` waits for a freshly spawned holder's socket.
const SPAWN_WAIT: Duration = Duration::from_secs(5);
/// Default post-exit TTL passed to spawned holders (design open q.3: 24h).
const DEFAULT_TTL_SECS: &str = "86400";

/// How to launch a holder: the program is re-exec'd with
/// `args_prefix ++ ["--dir", <session_dir>, ...spawn spec args...]`.
/// The Bud daemon passes its own exe + `["term-hold"]` (single-binary plan, D1).
#[derive(Debug, Clone)]
pub struct HolderLauncher {
    pub program: PathBuf,
    pub args_prefix: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMeta {
    pub holder_pid: i32,
    pub child_pid: i32,
    pub started_at_unix: u64,
    pub holder_version: String,
    pub ipc_proto_version: u16,
}

pub struct Registry {
    base: PathBuf,
}

impl Registry {
    /// `base` is created (0700) if missing.
    pub fn new(base: PathBuf) -> Result<Self> {
        fs::create_dir_all(&base)?;
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700))?;
        Ok(Registry { base })
    }

    pub fn session_dir(&self, session_id: &str) -> Result<PathBuf> {
        if !valid_session_id(session_id) {
            return Err(StemError::Other(format!(
                "invalid session id: {session_id:?}"
            )));
        }
        Ok(self.base.join(session_id))
    }

    /// Is there a live holder (socket connects + Hello round-trips)?
    pub async fn session_alive(&self, session_id: &str) -> bool {
        let Ok(dir) = self.session_dir(session_id) else {
            return false;
        };
        matches!(
            tokio::time::timeout(PROBE_TIMEOUT, HolderClient::connect(&dir)).await,
            Ok(Ok(_))
        )
    }

    /// Ensure a holder exists: reuse a live one, or spawn via `launcher` with
    /// `spec` and wait (bounded) for its socket. Returns the session dir.
    pub async fn ensure(
        &self,
        session_id: &str,
        launcher: &HolderLauncher,
        spec: &SpawnSpec,
        ring_cap: u64,
    ) -> Result<PathBuf> {
        let dir = self.session_dir(session_id)?;
        if self.session_alive(session_id).await {
            return Ok(dir);
        }

        fs::create_dir_all(&dir)?;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        let _ = fs::remove_file(dir.join("holder.sock")); // clean stale socket

        let mut cmd = std::process::Command::new(&launcher.program);
        cmd.args(&launcher.args_prefix)
            .arg("--dir")
            .arg(&dir)
            .args(["--shell", &spec.shell])
            .args(["--cwd", &spec.cwd])
            .args(["--cols", &spec.cols.to_string()])
            .args(["--rows", &spec.rows.to_string()])
            .args(["--ring-cap", &ring_cap.to_string()])
            .args(["--ttl", DEFAULT_TTL_SECS])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        for a in &spec.args {
            cmd.args(["--arg", a]);
        }
        for (k, v) in &spec.env {
            cmd.args(["--env", &format!("{k}={v}")]);
        }
        // The holder daemonizes itself; the immediate child exits once the
        // daemonized grandchild has signaled readiness. Just spawn and reap.
        let mut child = cmd.spawn()?;
        let _ = child.wait();

        let deadline = Instant::now() + SPAWN_WAIT;
        loop {
            if let Ok(Ok(_)) =
                tokio::time::timeout(PROBE_TIMEOUT, HolderClient::connect(&dir)).await
            {
                return Ok(dir);
            }
            if Instant::now() >= deadline {
                return Err(StemError::Other(format!(
                    "holder for {session_id} did not come up within {SPAWN_WAIT:?} (see {}/holder.log)",
                    dir.display()
                )));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Read meta.json (holder may still be dead — pair with `session_alive`).
    pub fn meta(&self, session_id: &str) -> Result<SessionMeta> {
        let dir = self.session_dir(session_id)?;
        let raw = fs::read_to_string(dir.join("meta.json"))?;
        parse_meta_json(&raw)
            .ok_or_else(|| StemError::Other(format!("unparseable meta.json for {session_id}")))
    }

    pub fn list(&self) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(&self.base)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                if valid_session_id(name) {
                    ids.push(name.to_string());
                }
            }
        }
        ids.sort();
        Ok(ids)
    }

    /// Remove session dirs whose holder pid is dead (stale reboot litter etc.).
    /// Returns removed session ids. Never touches dirs with live holders.
    pub fn gc_stale(&self) -> Result<Vec<String>> {
        let mut removed = Vec::new();
        for id in self.list()? {
            let dir = self.base.join(&id);
            let pid_dead = match self.meta(&id) {
                Ok(meta) => kill(Pid::from_raw(meta.holder_pid), None).is_err(),
                Err(_) => true, // missing/corrupt meta counts as a dead holder
            };
            if pid_dead && !probe_sync(&dir) {
                fs::remove_dir_all(&dir)?;
                removed.push(id);
            }
        }
        Ok(removed)
    }
}

/// Blocking Hello probe (used by GC, which is sync).
fn probe_sync(dir: &Path) -> bool {
    let Ok(stream) = std::os::unix::net::UnixStream::connect(dir.join("holder.sock")) else {
        return false;
    };
    if stream.set_read_timeout(Some(PROBE_TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(PROBE_TIMEOUT)).is_err()
    {
        return false;
    }
    let mut stream = stream;
    if ipc::write_msg_sync(
        &mut stream,
        &ClientMsg::Hello {
            proto_version: PROTO_VERSION,
        },
    )
    .is_err()
    {
        return false;
    }
    match ipc::read_frame_sync(&mut stream) {
        Ok(payload) => matches!(
            ipc::decode_payload::<HolderMsg>(&payload),
            Ok(HolderMsg::HelloAck { .. })
        ),
        Err(_) => false,
    }
}

/// Path-safety check for caller-supplied session ids (single path component,
/// `[A-Za-z0-9._-]+`, no leading dot).
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

// ---------------------------------------------------------------------------
// meta.json parsing (hand-rolled: serde_json is not a stem dependency; the
// writer is crate::holder::render_meta_json, so the shape is under our control,
// but the parser tolerates arbitrary key order and whitespace).
// ---------------------------------------------------------------------------

fn parse_meta_json(raw: &str) -> Option<SessionMeta> {
    Some(SessionMeta {
        holder_pid: json_number(raw, "pid")? as i32,
        child_pid: json_number(raw, "child_pid")? as i32,
        started_at_unix: json_number(raw, "started_at_unix")? as u64,
        holder_version: json_string(raw, "holder_version")?,
        ipc_proto_version: json_number(raw, "ipc_proto_version")? as u16,
    })
}

/// Position just after `"key"` and its colon, or None.
fn after_key<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let idx = raw.find(&needle)?;
    let rest = raw[idx + needle.len()..].trim_start();
    rest.strip_prefix(':').map(str::trim_start)
}

fn json_number(raw: &str, key: &str) -> Option<i64> {
    let rest = after_key(raw, key)?;
    let end = rest
        .char_indices()
        .find(|(_, c)| !c.is_ascii_digit() && *c != '-')
        .map(|(i, _)| i)
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

fn json_string(raw: &str, key: &str) -> Option<String> {
    let rest = after_key(raw, key)?.strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    loop {
        match chars.next()? {
            '"' => return Some(out),
            '\\' => match chars.next()? {
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                'u' => {
                    let hex: String = chars.by_ref().take(4).collect();
                    out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                }
                c => out.push(c),
            },
            c => out.push(c),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_validation() {
        assert!(valid_session_id("sess_01J8ZY"));
        assert!(valid_session_id("a"));
        assert!(valid_session_id("A-b.c_9"));
        assert!(valid_session_id(&"x".repeat(128)));

        assert!(!valid_session_id(""));
        assert!(!valid_session_id(&"x".repeat(129)));
        assert!(!valid_session_id(".hidden"));
        assert!(!valid_session_id(".."));
        assert!(!valid_session_id("a/b"));
        assert!(!valid_session_id("a b"));
        assert!(!valid_session_id("a\0b"));
        assert!(!valid_session_id("ü"));
    }

    #[test]
    fn meta_roundtrip_via_holder_writer() {
        let json = crate::holder::render_meta_json(
            1234,
            1_700_000_000,
            "0.1.0",
            PROTO_VERSION,
            "/bin/\"odd\"\\zsh",
            "/home/user",
            5678,
        );
        let meta = parse_meta_json(&json).unwrap();
        assert_eq!(
            meta,
            SessionMeta {
                holder_pid: 1234,
                child_pid: 5678,
                started_at_unix: 1_700_000_000,
                holder_version: "0.1.0".into(),
                ipc_proto_version: PROTO_VERSION,
            }
        );
    }

    #[test]
    fn meta_parse_tolerates_whitespace_and_order() {
        let json = r#"{
            "child_pid": 2,
            "holder_version" : "9.9.9",
            "ipc_proto_version": 1,
            "started_at_unix": 42,
            "pid": 1
        }"#;
        let meta = parse_meta_json(json).unwrap();
        assert_eq!(meta.holder_pid, 1);
        assert_eq!(meta.child_pid, 2);
        assert_eq!(meta.holder_version, "9.9.9");
    }

    #[test]
    fn meta_parse_rejects_garbage() {
        assert!(parse_meta_json("").is_none());
        assert!(parse_meta_json("{\"pid\": \"nope\"}").is_none());
    }

    #[test]
    fn registry_new_creates_base_0700() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("term");
        let reg = Registry::new(base.clone()).unwrap();
        let mode = fs::metadata(&base).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        assert!(reg.list().unwrap().is_empty());
        assert!(reg.session_dir("../evil").is_err());
        assert_eq!(reg.session_dir("ok").unwrap(), base.join("ok"));
    }
}
