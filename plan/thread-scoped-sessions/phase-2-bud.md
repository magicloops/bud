# Phase 2: Bud Multi-Session Support

_Status: Complete_

## Overview

Transform Bud from single-session to multi-session terminal management. Each thread gets its own tmux session, identified by `session_id`.

**File:** `bud/src/main.rs`

---

## Current State

### Single Session Design

```rust
// Current: One optional handle
struct TerminalState {
    sender: Option<OutboundSender>,
    handle: Option<Arc<TerminalHandle>>,  // Single session
    capture_state: Option<CaptureState>,
}

// Single tmux session name (hardcoded)
const SESSION_NAME: &str = "bud_terminal";
```

### Current Frame Types (no session_id)

```rust
struct TerminalInputFrame {
    envelope: Envelope,
    data: String,  // base64
    await_ready: Option<AwaitReady>,
    // Missing: session_id
}
```

---

## Target State

### Multi-Session Design

```rust
struct TerminalState {
    sender: Option<OutboundSender>,
    sessions: HashMap<String, Arc<TerminalHandle>>,  // session_id -> handle
    capture_states: HashMap<String, CaptureState>,   // per-session capture state
}

struct TerminalHandle {
    session_id: String,           // NEW: e.g., "sess_01HXYZ..."
    session_name: String,         // tmux session name: "s_01HXYZ"
    log_path: PathBuf,            // ~/.bud/sessions/{session_id}/terminal.log
    watcher: tokio::task::JoinHandle<()>,
    seq: Arc<AtomicU64>,
    offset: Arc<AtomicU64>,
    cols: u16,
    rows: u16,
}
```

### Frame Types with session_id

```rust
#[derive(Debug, Deserialize, Clone)]
struct TerminalEnsureFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,  // REQUIRED
    config: Option<TerminalEnsureConfig>,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalInputFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,  // REQUIRED
    data: String,
    await_ready: Option<AwaitReady>,
}

// Similarly for: TerminalResizeFrame, TerminalInterruptFrame, TerminalCloseFrame, TerminalCaptureFrame
```

---

## Changes

### 1. Update Frame Structs

Add `session_id: String` to all terminal frames:

| Frame | Current | After |
|-------|---------|-------|
| `TerminalEnsureFrame` | No session_id | `session_id: String` (required) |
| `TerminalInputFrame` | No session_id | `session_id: String` (required) |
| `TerminalResizeFrame` | No session_id | `session_id: String` (required) |
| `TerminalInterruptFrame` | No session_id | `session_id: String` (required) |
| `TerminalCloseFrame` | No session_id | `session_id: String` (required) |
| `TerminalCaptureFrame` | No session_id | `session_id: String` (required) |

### 2. Update TerminalState

```rust
struct TerminalState {
    sender: Option<OutboundSender>,
    sessions: HashMap<String, Arc<TerminalHandle>>,
    capture_states: HashMap<String, CaptureState>,
}

impl TerminalState {
    fn new() -> Self {
        Self {
            sender: None,
            sessions: HashMap::new(),
            capture_states: HashMap::new(),
        }
    }
}
```

### 3. Update TerminalHandle

```rust
struct TerminalHandle {
    session_id: String,      // NEW
    session_name: String,    // tmux name: derived from session_id
    log_path: PathBuf,
    watcher: tokio::task::JoinHandle<()>,
    seq: Arc<AtomicU64>,
    offset: Arc<AtomicU64>,
    cols: u16,
    rows: u16,
}
```

### 4. Dynamic Session Naming

```rust
/// Derive tmux session name from session_id
/// e.g., "sess_01HXYZ..." -> "s_01HXYZ"
fn tmux_session_name(session_id: &str) -> String {
    let suffix = session_id.strip_prefix("sess_").unwrap_or(session_id);
    let name = format!("s_{}", suffix);
    // tmux limits session names to 256 chars, but keep short for readability
    if name.len() > 32 {
        name[..32].to_string()
    } else {
        name
    }
}

/// Get log path for a session
/// ~/.bud/sessions/{session_id}/terminal.log
fn session_log_path(base_dir: &Path, session_id: &str) -> PathBuf {
    base_dir.join("sessions").join(session_id).join("terminal.log")
}
```

### 5. Update handle_ensure

```rust
async fn handle_ensure(&self, frame: TerminalEnsureFrame) -> Result<()> {
    if !self.config.enabled {
        info!("terminal support disabled; ignoring terminal_ensure");
        return Ok(());
    }

    let session_id = &frame.session_id;
    let mut inner = self.inner.lock().await;

    // Check if session already exists
    if let Some(handle) = inner.sessions.get(session_id) {
        if let Some(sender) = inner.sender.clone() {
            self.send_status(&sender, session_id, "ready", None).await?;
        }
        return Ok(());
    }

    let sender = inner.sender.clone()
        .ok_or_else(|| anyhow!("no websocket writer available"))?;
    drop(inner);

    if !self.config.tmux_available {
        warn!("tmux not available; cannot create terminal");
        self.send_status(&sender, session_id, "none", Some(json!({ "error": "tmux_unavailable" }))).await?;
        return Ok(());
    }

    // Create or attach to tmux session
    let handle = self.ensure_tmux_session(session_id, frame.config).await?;
    if let Some(handle) = handle {
        let mut inner = self.inner.lock().await;
        inner.sessions.insert(session_id.clone(), handle.clone());
        drop(inner);
        self.send_status(&sender, session_id, "ready", None).await?;
    } else {
        self.send_status(&sender, session_id, "none", Some(json!({ "error": "terminal_create_failed" }))).await?;
    }
    Ok(())
}
```

### 6. Update ensure_tmux_session

```rust
async fn ensure_tmux_session(
    &self,
    session_id: &str,
    cfg: Option<TerminalEnsureConfig>,
) -> Result<Option<Arc<TerminalHandle>>> {
    if !self.config.tmux_available {
        return Ok(None);
    }

    let tmux_name = tmux_session_name(session_id);
    let log_path = session_log_path(&self.config.log_dir, session_id);

    // Ensure log directory exists
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    // Check if tmux session already exists
    let session_exists = check_tmux_session(&tmux_name).await;

    if !session_exists {
        // Create new tmux session
        let shell = cfg.as_ref()
            .and_then(|c| c.shell.clone())
            .unwrap_or_else(|| self.config.default_shell.clone());
        let cwd = cfg.as_ref().and_then(|c| c.cwd.clone());

        create_tmux_session(&tmux_name, &shell, cwd.as_deref()).await?;
    }

    // Set up pipe-pane for output capture
    setup_pipe_pane(&tmux_name, &log_path).await?;

    // Resize if specified
    let cols = cfg.as_ref().and_then(|c| c.cols).unwrap_or(200);
    let rows = cfg.as_ref().and_then(|c| c.rows).unwrap_or(50);
    resize_tmux_session(&tmux_name, cols, rows).await?;

    // Start output watcher
    let seq = Arc::new(AtomicU64::new(0));
    let offset = Arc::new(AtomicU64::new(0));
    let watcher = self.spawn_output_watcher(
        session_id.to_string(),
        log_path.clone(),
        seq.clone(),
        offset.clone(),
    );

    let handle = Arc::new(TerminalHandle {
        session_id: session_id.to_string(),
        session_name: tmux_name,
        log_path,
        watcher,
        seq,
        offset,
        cols,
        rows,
    });

    Ok(Some(handle))
}
```

### 7. Update handle_input

```rust
async fn handle_input(&self, frame: TerminalInputFrame) -> Result<()> {
    if !self.config.enabled {
        return Ok(());
    }

    let session_id = &frame.session_id;
    let data = BASE64_STANDARD
        .decode(frame.data.as_bytes())
        .map_err(|err| anyhow!("invalid terminal input data: {}", err))?;

    // Get handle for this session (auto-create if needed)
    let handle = self.ensure_handle_for_session(session_id, None).await?;
    let Some(handle) = handle else {
        warn!(
            message_id = %frame.envelope.id,
            session_id = session_id,
            "terminal_input dropped; no session"
        );
        return Ok(());
    };

    // ... rest of input handling (unchanged, but uses handle.session_name)
}

/// Get or create handle for a specific session
async fn ensure_handle_for_session(
    &self,
    session_id: &str,
    cfg: Option<TerminalEnsureConfig>,
) -> Result<Option<Arc<TerminalHandle>>> {
    {
        let inner = self.inner.lock().await;
        if let Some(handle) = inner.sessions.get(session_id) {
            return Ok(Some(handle.clone()));
        }
    }
    // Create session if not exists
    self.ensure_tmux_session(session_id, cfg).await
}
```

### 8. Update handle_close

```rust
async fn handle_close(&self, frame: TerminalCloseFrame) -> Result<()> {
    let session_id = &frame.session_id;

    let mut inner = self.inner.lock().await;
    if let Some(handle) = inner.sessions.remove(session_id) {
        // Stop output watcher
        handle.watcher.abort();

        // Kill tmux session
        let _ = Command::new("tmux")
            .args(["kill-session", "-t", &handle.session_name])
            .status()
            .await;

        info!(session_id = session_id, "terminal session closed");
    }

    // Remove capture state
    inner.capture_states.remove(session_id);

    if let Some(sender) = inner.sender.clone() {
        drop(inner);
        self.send_status(&sender, session_id, "closed", None).await?;
    }

    Ok(())
}
```

### 9. Update send_status

```rust
async fn send_status(
    &self,
    sender: &OutboundSender,
    session_id: &str,
    state: &str,
    extra: Option<serde_json::Value>,
) -> Result<()> {
    let mut payload = json!({
        "proto": TERMINAL_PROTO_VERSION,
        "type": "terminal_status",
        "id": new_message_id(),
        "ts": now_millis(),
        "ext": {},
        "session_id": session_id,  // NEW
        "state": state
    });

    if let Some(extra) = extra {
        if let Some(obj) = payload.as_object_mut() {
            if let Some(extra_obj) = extra.as_object() {
                for (k, v) in extra_obj {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
    }

    // Add session info if we have a handle
    let inner = self.inner.lock().await;
    if let Some(handle) = inner.sessions.get(session_id) {
        payload["info"] = json!({
            "tmux_session": handle.session_name,
            "cols": handle.cols,
            "rows": handle.rows,
        });
    }

    send_ws_frame(sender, payload)?;
    Ok(())
}
```

### 10. Update Output Frames

```rust
// In spawn_output_watcher, include session_id in output frames:
fn spawn_output_watcher(
    &self,
    session_id: String,  // NEW parameter
    log_path: PathBuf,
    seq: Arc<AtomicU64>,
    offset: Arc<AtomicU64>,
) -> tokio::task::JoinHandle<()> {
    let inner = self.inner.clone();
    tokio::spawn(async move {
        // ... file watching logic ...

        // When emitting output:
        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_output",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": session_id,  // NEW
            "seq": current_seq,
            "data": base64_data,
            "byte_offset": current_offset
        });
    })
}
```

### 11. Update ReadinessDetector and ActivityDetector

```rust
struct ReadinessDetector {
    session_id: String,  // NEW
    handle: Arc<TerminalHandle>,
    sender: OutboundSender,
    start_offset: u64,
    await_ready: Option<AwaitReady>,
}

impl ReadinessDetector {
    async fn send_ready(&self, ...) -> Result<()> {
        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_ready",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": self.session_id,  // NEW
            "assessment": { ... }
        });
        // ...
    }
}
```

---

## Implementation Checklist

- [ ] Add `session_id: String` to all terminal frame structs
  - [ ] `TerminalEnsureFrame`
  - [ ] `TerminalInputFrame`
  - [ ] `TerminalResizeFrame`
  - [ ] `TerminalInterruptFrame`
  - [ ] `TerminalCloseFrame`
  - [ ] `TerminalCaptureFrame`
- [ ] Update `TerminalState` to use `HashMap<String, Arc<TerminalHandle>>`
- [ ] Update `TerminalHandle` to include `session_id`
- [ ] Add `tmux_session_name()` helper function
- [ ] Add `session_log_path()` helper function
- [ ] Update `handle_ensure()` to route by session_id
- [ ] Update `ensure_tmux_session()` to use dynamic naming
- [ ] Update `handle_input()` to route by session_id
- [ ] Update `handle_resize()` to route by session_id
- [ ] Update `handle_interrupt()` to route by session_id
- [ ] Update `handle_close()` to route by session_id
- [ ] Update `handle_capture()` to route by session_id
- [ ] Update `send_status()` to include session_id
- [ ] Update `spawn_output_watcher()` to include session_id in frames
- [ ] Update `ReadinessDetector` to include session_id
- [ ] Update `ActivityDetector` to include session_id
- [ ] Update `clear_sender()` to abort all session watchers
- [ ] Test with multiple concurrent sessions

---

## Testing

### Manual Tests

1. **Single session**: Verify existing behavior still works
2. **Multiple sessions**: Create two sessions, verify isolation
3. **Session naming**: Verify tmux sessions named correctly (`s_01ABC...`)
4. **Log paths**: Verify logs in `~/.bud/sessions/{session_id}/`
5. **Reconnection**: Verify sessions persist across Bud restart
6. **Close session**: Verify tmux session killed, handle removed

### Verification Commands

```bash
# List all tmux sessions
tmux list-sessions

# Check session directories
ls -la ~/.bud/sessions/

# Watch Bud logs for session routing
tail -f /tmp/bud.log | grep session_id
```

---

## Notes

- Session naming uses prefix `s_` to keep tmux names short
- Log paths use full session_id for uniqueness
- `ensure_handle_for_session()` auto-creates on first input (lazy creation)
- Existing tmux sessions are reattached (supports Bud restarts)
