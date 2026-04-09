# bud

Rust device daemon that runs on user machines and connects to the Bud service via WebSocket. Provides terminal access and command execution capabilities.

## Purpose

The bud daemon is the "agent" that runs on devices users want to control remotely. It:

1. **Bootstraps auth** through a browser claim flow (or a legacy enrollment token fallback) and stores long-lived device credentials locally
2. **Maintains** a persistent WebSocket connection with automatic reconnection
3. **Executes** shell commands and streams output back to the service
4. **Manages** tmux-based terminal sessions for interactive use
5. **Detects** terminal readiness to coordinate with the AI agent

## Files

### `README.md`

Contributor-facing usage guide for the daemon.

**Documents**:
- local build and run flow
- browser-mediated claim bootstrap
- per-instance local multi-account testing via `--identity-file` and `--terminal-base-dir`
- example helper scripts for copying the built binary into account-specific directories

### `.env.example`

Shell-export template for local daemon development.

**Important**:
- Bud does not auto-load `.env`
- developers should `source` the copied file before running `cargo run`
- defaults point at local service development (`ws://localhost:3000/ws`)
- includes both `BUD_IDENTITY_FILE` and `BUD_TERMINAL_BASE_DIR` so daemon state can be relocated away from `~/.bud`

### `Cargo.toml`

Rust package manifest defining:

- **Package**: `bud` v0.1.0 (Rust 2021 edition)
- **Dependencies**: See [src/src.spec.md](./src/src.spec.md) for full list

Key dependency categories:
- Async runtime: `tokio`, `futures`
- WebSocket: `tokio-tungstenite`, `rustls`
- Device-auth bootstrap: `reqwest`, `qrcodegen`
- CLI: `clap`
- Serialization: `serde`, `serde_json`
- PTY: `nix`, `libc`
- Security: `hmac`, `sha2`, `base64`

## Subfolders

### `src/` → [src.spec.md](./src/src.spec.md)

Contains the monolithic `main.rs` implementation (~2,900 lines) with all daemon functionality including WebSocket handling, authentication, command execution, and terminal management.

### `target/` (git-ignored)

Cargo build artifacts. Not tracked in version control.

## Usage

### First-Time Device Claim

```bash
cargo run -- --terminal-enabled
```

On first run without a stored device secret, the daemon:
1. Generates or loads a stable `installation_id`
2. Calls `/api/device-auth/start`
3. Prints a claim URL plus terminal QR code
4. Polls `/api/device-auth/poll` until the browser approves the claim
5. Persists the issued `bud_id` and `device_secret` to the configured identity path (default: `~/.bud/identity.json`)

### Legacy Manual Enrollment

```bash
cargo run -- --token <enrollment-token> --terminal-enabled
```

### Subsequent Connections

```bash
cargo run -- --terminal-enabled
```

The daemon:
1. Loads identity from the configured identity path (default: `~/.bud/identity.json`)
2. Loads `installation_id` from a sibling `installation-id` file next to the identity file
3. Sends `hello` frame with `bud_id`
4. Responds to HMAC challenge with proof
5. Receives `hello_ack` confirming session

If the stored identity file is missing, malformed, or has an empty device secret, the daemon treats it as unusable and immediately re-enters the device-claim flow instead of crashing.

Running Bud from another shell directory does not relocate daemon state on its own. For local multi-account testing, developers should point `--identity-file` and `--terminal-base-dir` at a per-instance directory, which also keeps the derived `installation-id` separate for each local Bud.

### CLI Options

| Option | Env Variable | Default | Description |
|--------|--------------|---------|-------------|
| `--server` | `BUD_SERVER_URL` | `wss://localhost:8443/ws` | Service endpoint |
| `--token` | `BUD_ENROLLMENT_TOKEN` | - | Enrollment token |
| `--name` | `BUD_DEVICE_NAME` | `bud-dev` | Device name |
| `--cwd` | `BUD_DEFAULT_CWD` | `~` | Working directory |
| `--identity-file` | `BUD_IDENTITY_FILE` | `~/.bud/identity.json` | Identity storage |
| `--terminal-base-dir` | `BUD_TERMINAL_BASE_DIR` | `~/.bud` | Base directory for terminal logs and session artifacts |
| `--terminal-enabled` | `BUD_TERMINAL_ENABLED` | `false` | Enable terminals |
| `--terminal-cols` | `BUD_TERMINAL_COLS` | `200` | Terminal width |
| `--terminal-rows` | `BUD_TERMINAL_ROWS` | `50` | Terminal height |
| `--debug` | `BUD_DEBUG` | `false` | Debug logging |

## Architecture

```
                    ┌─────────────────────────────────┐
                    │           BudApp                │
                    │                                 │
                    │  ┌─────────────────────────┐   │
                    │  │     WebSocket Layer     │   │
                    │  │  (connect, reconnect,   │   │
                    │  │   heartbeat, dispatch)  │   │
                    │  └───────────┬─────────────┘   │
                    │              │                  │
                    │  ┌───────────┴───────────┐     │
                    │  │                       │     │
                    │  ▼                       ▼     │
                    │ ┌────────────┐ ┌─────────────┐│
                    │ │RunExecutor │ │TerminalMgr ││
                    │ │ (one-shot  │ │  (tmux     ││
                    │ │  commands) │ │  sessions) ││
                    │ └────────────┘ └─────────────┘│
                    │                       │        │
                    │               ┌───────┴──────┐ │
                    │               │  Readiness   │ │
                    │               │  Detection   │ │
                    │               └──────────────┘ │
                    └─────────────────────────────────┘
                                    │
                             WebSocket (TLS)
                                    │
                                    ▼
                            ┌──────────────┐
                            │   Service    │
                            │  (Node.js)   │
                            └──────────────┘
```

## Terminal Session Lifecycle

```
Service Request              Daemon Action
────────────────              ─────────────
terminal_ensure    →    Check/create tmux session
                        Start pipe-pane logging
                        Send terminal_status(ready)

terminal_input     →    tmux send-keys (text + Enter)
                        Optional: spawn readiness detector

terminal_exec      →    tmux send-keys (command + Enter)
                        Wait for shell quiescence
                        Send terminal_exec_result

terminal_send      →    tmux send-keys (structured text/keys)
                        Fast post-send capture after 150ms by default
                        Optional: wait for shell_ready, changed, or settled
                        Send terminal_send_result

terminal_observe   →    tmux capture-pane
                        Optional: wait with the shared changed/settled engine before capture
                        Send terminal_observe_result

terminal_interrupt →    tmux send-keys C-c
                        Optional: spawn readiness detector

terminal_close     →    tmux kill-session
                        Send terminal_status(closed)
```

## Output Streaming

Terminal output flows through two mechanisms:

1. **pipe-pane logging**: `tmux pipe-pane` writes to `<terminal-base-dir>/sessions/{id}/terminal.log` (default base dir: `~/.bud`)
2. **File watcher**: Polls log file every 50ms for new bytes
3. **WebSocket frames**: Sends `terminal_output` with base64-encoded chunks

## Readiness Detection

Two strategies based on terminal context:

### Quiescence-Based (Shell Commands)

For traditional shell commands, monitors output file for silence:
- Waits for `quiescence_ms` (default 1500ms) of no new output
- Analyzes last line for prompt patterns
- Returns confidence score (0.0-1.0)

### Activity-Based (TUI/REPL Apps)

For interactive programs like Claude Code:
- Compares `capture-pane` hashes at intervals
- Waits for N consecutive identical screens
- Handles apps with natural processing pauses

For the Phase 6/7 agent-facing send/observe path specifically:
- Bud now captures an immediate post-send screen by default after `150ms`
- `terminal_send_result` includes both dispatch success and fast screen evidence
- explicit agent-facing waits now use `changed` / `settled`, which start sampling immediately instead of waiting through the old blind `screen_stable` loop
- the older activity-based detector remains for low-level `terminal_input` / `terminal_interrupt` readiness events

## Dependencies

### Runtime Requirements

- **tmux** - Required for terminal features (optional feature)
- **bash/sh** - For shell command execution

### Build Requirements

- Rust stable toolchain
- System libraries for TLS (via rustls-native-certs)

## Known Issues

<!-- SPEC:TODO -->
- Reconnection can leave orphaned tmux sessions if daemon crashes
- No graceful shutdown handling for terminal sessions
- Identity file permissions not verified on load (only set on create)
- The device claim flow assumes the service HTTP origin is derivable from the configured WebSocket URL

---

*Parent spec: [../bud.spec.md](../bud.spec.md)*
