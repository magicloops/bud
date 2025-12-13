# bud

Rust device daemon that runs on user machines and connects to the Bud service via WebSocket. Provides terminal access and command execution capabilities.

## Purpose

The bud daemon is the "agent" that runs on devices users want to control remotely. It:

1. **Registers** with the service using enrollment tokens or stored identity
2. **Maintains** a persistent WebSocket connection with automatic reconnection
3. **Executes** shell commands and streams output back to the service
4. **Manages** tmux-based terminal sessions for interactive use
5. **Detects** terminal readiness to coordinate with the AI agent

## Files

### `Cargo.toml`

Rust package manifest defining:

- **Package**: `bud` v0.1.0 (Rust 2021 edition)
- **Dependencies**: See [src/src.spec.md](./src/src.spec.md) for full list

Key dependency categories:
- Async runtime: `tokio`, `futures`
- WebSocket: `tokio-tungstenite`, `rustls`
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

### First-Time Enrollment

```bash
# With enrollment token
cargo run -- --token <enrollment-token> --terminal-enabled

# Or via environment
BUD_ENROLLMENT_TOKEN=<token> BUD_TERMINAL_ENABLED=true cargo run
```

On successful enrollment, the daemon:
1. Sends `hello` frame with token
2. Receives `hello_ack` with `bud_id` and `device_secret`
3. Persists identity to `~/.bud/identity.json`

### Subsequent Connections

```bash
cargo run -- --terminal-enabled
```

The daemon:
1. Loads identity from `~/.bud/identity.json`
2. Sends `hello` frame with `bud_id`
3. Responds to HMAC challenge with proof
4. Receives `hello_ack` confirming session

### CLI Options

| Option | Env Variable | Default | Description |
|--------|--------------|---------|-------------|
| `--server` | `BUD_SERVER_URL` | `wss://localhost:8443/ws` | Service endpoint |
| `--token` | `BUD_ENROLLMENT_TOKEN` | - | Enrollment token |
| `--name` | `BUD_DEVICE_NAME` | `bud-dev` | Device name |
| `--cwd` | `BUD_DEFAULT_CWD` | `~` | Working directory |
| `--identity-file` | `BUD_IDENTITY_FILE` | `~/.bud/identity.json` | Identity storage |
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

terminal_capture   →    tmux capture-pane
                        Apply deduplication
                        Send terminal_capture_response

terminal_interrupt →    tmux send-keys C-c
                        Optional: spawn readiness detector

terminal_close     →    tmux kill-session
                        Send terminal_status(closed)
```

## Output Streaming

Terminal output flows through two mechanisms:

1. **pipe-pane logging**: `tmux pipe-pane` writes to `~/.bud/sessions/{id}/terminal.log`
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

---

*Parent spec: [../bud.spec.md](../bud.spec.md)*
