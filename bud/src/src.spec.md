# src

Source code for the Bud device daemon - a Rust CLI that connects remote machines to the Bud service via WebSocket and, when needed, bootstraps device auth through a browser claim flow.

## Files

### `main.rs`

Monolithic implementation (~2,900 lines) containing all daemon functionality. The code is organized into logical sections:

#### CLI & Configuration (Lines 1-140)

- **`BudArgs`** - CLI arguments parsed via `clap`:
  - `--server` / `BUD_SERVER_URL` - WebSocket endpoint (default: `wss://localhost:8443/ws`)
  - `--token` / `BUD_ENROLLMENT_TOKEN` - Legacy/manual enrollment token fallback
  - `--name` / `BUD_DEVICE_NAME` - Device display name
  - `--cwd` / `BUD_DEFAULT_CWD` - Default working directory
  - `--identity-file` / `BUD_IDENTITY_FILE` - Path to identity JSON (default: `~/.bud/identity.json`)
  - `--terminal-base-dir` / `BUD_TERMINAL_BASE_DIR` - Base directory for terminal logs and session artifacts (default: `~/.bud`)
  - `--terminal-enabled` / `BUD_TERMINAL_ENABLED` - Enable terminal features
  - `--terminal-cols/rows` - Terminal dimensions (default: 200x50)
  - `--debug` / `BUD_DEBUG` - Debug logging mode

- **`DeviceIdentity`** - Persisted identity containing `bud_id`, `device_secret`, server URL; malformed or empty stored credentials are treated as missing at load time so reauth can proceed
- **Installation identity** - Stable non-secret `installation_id` persisted in a sibling `installation-id` file next to the configured identity file
- **Device auth bootstrap types** - HTTP start/poll payloads for `/api/device-auth/*`
- **`HandshakeError`** - Distinguishes `AUTH_FAILED` reauth from other handshake failures

#### Protocol Types (Lines 120-430)

WebSocket message frame types matching the service protocol:

| Type | Direction | Purpose |
|------|-----------|---------|
| `Envelope` | Both | Base frame with `type`, `proto`, `id`, `ts`, `ext` |
| `HelloAckFrame` | ← Service | Auth success with `session_id`, `bud_id`, optional `device_secret` |
| `HelloChallengeFrame` | ← Service | HMAC challenge with `nonce` |
| `ErrorFrame` | ← Service | Error with `code` and `message` |
| `DeviceAuthStartResponse` | ← Service | Claim URL + poll secret for browser-mediated bootstrap |
| `DeviceAuthPollResponse` | ← Service | Pending/approved/rejected claim polling result |
| `RunFrame` | ← Service | Command execution request |
| `TerminalEnsureFrame` | ← Service | Create/verify tmux session |
| `TerminalInputFrame` | ← Service | Send input to terminal |
| `TerminalExecFrame` | ← Service | Request-response shell execution |
| `TerminalSendFrame` | ← Service | Structured interactive input with optional fast post-send observation |
| `TerminalObserveFrame` | ← Service | Explicit screen inspection |
| `AwaitReady` | Config | Readiness detection options |

#### Run Executor (Lines 435-660)

**`RunExecutor`** - Queued command execution system:

- Maintains FIFO queue (max 10 commands)
- Executes shell commands via PTY
- Streams stdout/stderr back to service
- Tracks current working directory across commands
- Sends `run_finished` frame on completion

#### Capture Deduplication (Lines 660-715)

Hash-based deduplication for `capture-pane` output:

- `simple_hash()` - Fast content hashing using `DefaultHasher`
- `deduplicate_capture()` - Returns empty if hash matches previous capture
- Prevents redundant data transfer for unchanged terminal screens

#### Terminal Manager (Lines 715-1465)

**`TerminalManager`** - tmux-based terminal session management:

- **`handle_ensure`** - Create or verify tmux session exists
- **`handle_input`** - Send input via `tmux send-keys`
  - Splits text and newlines for proper Enter key handling
  - Supports `await_ready` for readiness detection
- **`handle_resize`** - Resize via `tmux resize-window`
- **`handle_interrupt`** - Send Ctrl+C via `tmux send-keys C-c`
- **`handle_close`** - Kill session via `tmux kill-session`
- **`handle_exec`** - Request-response pattern for agent `terminal.exec`:
  - Sends a shell command plus Enter to tmux
  - Waits for quiescence using the pipe-pane log
  - Returns output directly in `terminal_exec_result`
- **`handle_send`** - Structured interactive input path for agent `terminal.send`:
  - Sends literal text, optional submit, and special keys
  - Captures a fast post-send screen observation after `observe_after_ms` (default `150ms`)
  - Defaults to `wait_for: "none"` and `timeout_ms: 5000`
  - Can explicitly wait for `shell_ready`, `changed`, or `settled`
  - Reuses a pre-send baseline capture so waits can detect immediate redraws and echoed input
  - Returns dispatch status plus `observation` and readiness in `terminal_send_result`
- **`handle_observe`** - Explicit screen observation for agent `terminal.observe`:
  - Optionally waits with the same immediate-start screen engine used by `terminal.send`
  - Reuses the wait capture instead of always performing a second `capture-pane`
  - Returns `terminal_observe_result`

**Output Streaming**:
- Uses `tmux pipe-pane` to capture output to a session log under `BUD_TERMINAL_BASE_DIR/sessions/{session_id}/terminal.log`
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

**Phase 6 Note**:
- The agent-facing `terminal.send` path no longer relies on activity stability by default; it now uses an immediate fast capture after send and reserves `screen_stable` for explicit wait requests.

**Phase 7 Note**:
- Agent-facing `terminal.send` / `terminal.observe` now share an immediate-start screen wait helper that:
  - supports `changed` and `settled`
  - polls every `100ms`
  - treats `settled` as a short quiet window (`300ms`) instead of the older blind delay loop
  - returns timeout assessments that stay conservative instead of treating a missed wait as positive readiness
- The older `ActivityDetector` remains in place for low-level `terminal_input` / `terminal_interrupt` readiness events.

#### Main Application (Lines 2365-2875)

**`BudApp`** - Main daemon orchestrator:

- **`new()`** - Expands CLI/env paths, derives `installation-id` from the identity file parent directory, and applies `BUD_TERMINAL_BASE_DIR` to terminal logging
- **`connect_once()`** - Establish WebSocket connection
- **`bootstrap_device_auth()`** - Start claim flow, print link + QR, poll for approval
- **`perform_handshake()`** - Authentication flow:
  1. Send `hello` with identity or enrollment token plus `installation_id`
  2. If challenged, compute HMAC proof
  3. Receive `hello_ack` with session info
- **`run_session()`** - Main message loop:
  - Periodic heartbeat sending
  - Frame dispatch to appropriate manager
- **`handle_server_frame()`** - Route frames by type
- **`build_hello_frame()`** - Construct hello with capabilities

**Identity Management**:
- `load_identity()` - Read from identity file, treating malformed or incomplete stored credentials as missing so the daemon can fall back into browser-mediated reauth
- `persist_identity()` - Save with 0600 permissions
- `load_or_create_installation_id()` - Keep stable device install identity separate from the secret
- `clear_identity()` - Remove invalid local device secret before re-claim
- `start_device_auth_flow()` / `poll_device_auth_flow()` - HTTP bootstrap against `/api/device-auth/*`
- `print_device_claim_instructions()` - Show claim URL and terminal QR code for headless setups

#### Utilities (Lines 2800-2866)

- `new_message_id()` - Generate ULID
- `now_millis()` - Current timestamp in milliseconds
- `default_shell()` - Detect user's shell (respects `$SHELL`)
- `expand_path()` - Tilde expansion
- `installation_id_path()` - Derive sidecar installation-id file path from identity path
- `api_base_url_from_ws_url()` - Convert daemon WS URL to service HTTP base for device-auth routes
- `probe_tmux()` - Check tmux availability and version
- `compute_hmac()` - HMAC-SHA256 for authentication
- `print_terminal_qr()` - Render Unicode block QR in terminal
- `write_private_file()` - Shared 0600 write helper for device identity files
- `setup_tracing()` - Initialize logging

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          BudApp                                  │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐ │
│  │ RunExecutor  │  │           TerminalManager                │ │
│  │  (commands)  │  │              (tmux)                      │ │
│  └──────────────┘  └──────────────────┬───────────────────────┘ │
│                                       │                         │
│                           ┌───────────┴───────────┐             │
│                           │  ReadinessDetector    │             │
│                           │  ActivityDetector     │             │
│                           └───────────────────────┘             │
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
| `nix` | Unix utilities |
| `anyhow` | Error handling |
| `base64` | Data encoding for frames |
| `hmac` / `sha2` | Authentication |
| `reqwest` | Device auth bootstrap HTTP client |
| `qrcodegen` | ASCII/Unicode QR rendering in terminal |
| `tracing` / `tracing-subscriber` | Logging |
| `ulid` | Message ID generation |
| `chrono` | Timestamp formatting |
| `shellexpand` | Path tilde expansion |

## Protocol Versions

- `PROTO_VERSION = "0.1"` - Base protocol
- `TERMINAL_PROTO_VERSION = "0.2"` - Terminal extensions

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Single-file architecture makes navigation difficult; consider splitting bootstrap/auth, terminal, and run execution into modules
- `#[allow(dead_code)]` on several struct fields suggests unused protocol features
- Device-auth bootstrap currently depends on outbound HTTPS from the daemon; no offline/local fallback exists beyond the claim URL itself

---

*Referenced by: [bud.spec.md](../bud.spec.md)*
