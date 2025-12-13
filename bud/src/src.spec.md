# src

Source code for the Bud device daemon - a Rust CLI that connects remote machines to the Bud service via WebSocket.

## Files

### `main.rs`

Monolithic implementation (~2,900 lines) containing all daemon functionality. The code is organized into logical sections:

#### CLI & Configuration (Lines 1-120)

- **`BudArgs`** - CLI arguments parsed via `clap`:
  - `--server` / `BUD_SERVER_URL` - WebSocket endpoint (default: `wss://localhost:8443/ws`)
  - `--token` / `BUD_ENROLLMENT_TOKEN` - One-time enrollment token
  - `--name` / `BUD_DEVICE_NAME` - Device display name
  - `--cwd` / `BUD_DEFAULT_CWD` - Default working directory
  - `--identity-file` / `BUD_IDENTITY_FILE` - Path to identity JSON (default: `~/.bud/identity.json`)
  - `--terminal-enabled` / `BUD_TERMINAL_ENABLED` - Enable terminal features
  - `--terminal-cols/rows` - Terminal dimensions (default: 200x50)
  - `--debug` / `BUD_DEBUG` - Debug logging mode

- **`DeviceIdentity`** - Persisted identity containing `bud_id`, `device_secret`, server URL

#### Protocol Types (Lines 120-430)

WebSocket message frame types matching the service protocol:

| Type | Direction | Purpose |
|------|-----------|---------|
| `Envelope` | Both | Base frame with `type`, `proto`, `id`, `ts`, `ext` |
| `HelloAckFrame` | ← Service | Auth success with `session_id`, `bud_id`, optional `device_secret` |
| `HelloChallengeFrame` | ← Service | HMAC challenge with `nonce` |
| `ErrorFrame` | ← Service | Error with `code` and `message` |
| `RunFrame` | ← Service | Command execution request |
| `SessionOpenFrame` | ← Service | Legacy PTY session open |
| `SessionInputFrame` | ← Service | Legacy session input |
| `TerminalEnsureFrame` | ← Service | Create/verify tmux session |
| `TerminalInputFrame` | ← Service | Send input to terminal |
| `TerminalCaptureFrame` | ← Service | Request capture-pane output |
| `AwaitReady` | Config | Readiness detection options |

#### Run Executor (Lines 435-660)

**`RunExecutor`** - Queued command execution system:

- Maintains FIFO queue (max 10 commands)
- Executes shell commands via PTY
- Streams stdout/stderr back to service
- Tracks current working directory across commands
- Sends `run_finished` frame on completion

#### Session Manager (Lines 660-810)

**`SessionManager`** - Legacy PTY session management:

- Opens raw PTY sessions (non-tmux)
- Handles `session_open`, `session_input`, `session_resize`, `session_close`
- Streams output via `session_output` frames
- Used for direct PTY access (fallback when tmux unavailable)

#### Capture Deduplication (Lines 810-865)

Hash-based deduplication for `capture-pane` output:

- `simple_hash()` - Fast content hashing using `DefaultHasher`
- `deduplicate_capture()` - Returns empty if hash matches previous capture
- Prevents redundant data transfer for unchanged terminal screens

#### Terminal Manager (Lines 865-1615)

**`TerminalManager`** - tmux-based terminal session management:

- **`handle_ensure`** - Create or verify tmux session exists
- **`handle_input`** - Send input via `tmux send-keys`
  - Splits text and newlines for proper Enter key handling
  - Supports `await_ready` for readiness detection
- **`handle_resize`** - Resize via `tmux resize-window`
- **`handle_interrupt`** - Send Ctrl+C via `tmux send-keys C-c`
- **`handle_close`** - Kill session via `tmux kill-session`
- **`handle_capture`** - Execute `tmux capture-pane` with options

**Output Streaming**:
- Uses `tmux pipe-pane` to capture output to log file
- `spawn_output_watcher()` polls log file for new bytes
- Sends `terminal_output` frames with base64-encoded chunks

#### Readiness Detection (Lines 1618-1865)

**`ReadinessDetector`** - Quiescence-based detection for shell commands:

- Monitors log file for output quiescence
- Configurable `quiescence_ms` (default: 1500ms) and `max_wait_ms` (default: 30s)
- Analyzes output for prompt patterns
- Sends `terminal_ready` frame with confidence assessment

**`ReadinessDetector::detect_prompt()`** - Pattern matching for:
- Shell prompts (`$`, `#`, `%`, `:~$`)
- Python REPL (`>>>`, `...`, `In [`)
- Node REPL (`>`)
- Database prompts (`mysql>`, `postgres=#`, `sqlite>`)
- Confirmation prompts (`[y/n]`, `yes/no`)
- Password prompts
- Pager indicators (`:`, `(END)`, `--More--`)

#### Activity Detector (Lines 1866-2075)

**`ActivityDetector`** - Screen stability detection for TUI/REPL apps:

- Compares `capture-pane` hashes at intervals
- Declares ready when screen unchanged for N consecutive checks
- Designed for apps like Claude Code that have natural processing pauses
- Default: 5s intervals, 2 stable checks required, 60s max wait

#### Main Application (Lines 2365-2800)

**`BudApp`** - Main daemon orchestrator:

- **`connect_once()`** - Establish WebSocket connection
- **`perform_handshake()`** - Authentication flow:
  1. Send `hello` with identity or enrollment token
  2. If challenged, compute HMAC proof
  3. Receive `hello_ack` with session info
- **`run_session()`** - Main message loop:
  - Periodic heartbeat sending
  - Frame dispatch to appropriate manager
- **`handle_server_frame()`** - Route frames by type
- **`build_hello_frame()`** - Construct hello with capabilities

**Identity Management**:
- `load_identity()` - Read from identity file
- `persist_identity()` - Save with 0600 permissions

#### Utilities (Lines 2800-2866)

- `new_message_id()` - Generate ULID
- `now_millis()` - Current timestamp in milliseconds
- `default_shell()` - Detect user's shell (respects `$SHELL`)
- `expand_path()` - Tilde expansion
- `probe_tmux()` - Check tmux availability and version
- `compute_hmac()` - HMAC-SHA256 for authentication
- `setup_tracing()` - Initialize logging

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          BudApp                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ RunExecutor  │  │SessionManager│  │   TerminalManager    │  │
│  │  (commands)  │  │ (legacy PTY) │  │       (tmux)         │  │
│  └──────────────┘  └──────────────┘  └──────────┬───────────┘  │
│                                                  │              │
│                                      ┌───────────┴───────────┐ │
│                                      │  ReadinessDetector    │ │
│                                      │  ActivityDetector     │ │
│                                      └───────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            │
                     WebSocket (TLS)
                            │
                            ▼
                    ┌──────────────┐
                    │   Service    │
                    └──────────────┘
```

## Dependencies

External crates (from `Cargo.toml`):

| Crate | Purpose |
|-------|---------|
| `tokio` | Async runtime with process, fs, sync features |
| `tokio-tungstenite` | WebSocket client |
| `clap` | CLI argument parsing |
| `serde` / `serde_json` | JSON serialization |
| `nix` | PTY handling (`openpty`) |
| `anyhow` | Error handling |
| `base64` | Data encoding for frames |
| `hmac` / `sha2` | Authentication |
| `tracing` / `tracing-subscriber` | Logging |
| `ulid` | Message ID generation |
| `chrono` | Timestamp formatting |
| `shellexpand` | Path tilde expansion |

## Protocol Versions

- `PROTO_VERSION = "0.1"` - Base protocol
- `TERMINAL_PROTO_VERSION = "0.2"` - Terminal extensions

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Single-file architecture makes navigation difficult; consider splitting into modules
- `#[allow(dead_code)]` on several struct fields suggests unused protocol features
- Environment passthrough for `terminal_ensure` noted as "not yet implemented" (line 1416)
- Legacy `SessionManager` (non-tmux PTY) may be redundant now that tmux is preferred

---

*Referenced by: [bud.spec.md](../bud.spec.md)*
