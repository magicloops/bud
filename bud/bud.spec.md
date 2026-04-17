# bud

Rust device daemon that runs on user machines and connects to the Bud service via WebSocket. It bootstraps device auth, maintains the on-device runtime for cloud-hosted agents, and currently provides a tmux-backed terminal implementation behind a more modular internal runtime split.

## Purpose

The Bud daemon:

1. bootstraps auth through a browser claim flow, with a legacy enrollment-token fallback
2. maintains a persistent WebSocket connection with automatic reconnect and heartbeats
3. executes the retained legacy queued `run` path for one-shot command work
4. manages thread-scoped interactive terminal sessions
5. detects readiness and screen stability so the service can drive terminal interactions safely

## Files

### `README.md`

Contributor-facing usage guide for the daemon.

### `.env.example`

Shell-export template for local daemon development.

### `Cargo.toml`

Rust package manifest for the daemon crate and its runtime dependencies.

## Subfolders

### `src/` -> [src.spec.md](./src/src.spec.md)

Modular daemon implementation split across:

- `main.rs` for the thin entrypoint
- `lib.rs` for crate wiring
- `app.rs` for top-level runtime orchestration
- `config.rs`, `protocol.rs`, `util.rs` for shared types/helpers
- `identity.rs` and `claim.rs` for device-auth bootstrap and persistence
- `run.rs` for the retained reference run path
- `terminal/mod.rs` for the service-facing terminal runtime
- `terminal/tmux.rs` for the tmux backend adapter

### `target/` (git-ignored)

Cargo build artifacts. Not tracked in version control.

## Architecture

```text
                     BudApp
                        |
        +---------------+---------------+
        |                               |
   identity / claim                 run executor
        |
        +-------------------+
                            |
                      terminal runtime
                            |
                     tmux backend adapter
```

Key boundary decisions:

- `app.rs` owns connection lifecycle and frame dispatch.
- `terminal/mod.rs` owns the service-facing terminal contract, session registry, readiness, and delta logic.
- `terminal/tmux.rs` owns tmux command execution and log capture details.
- `run.rs` stays isolated as legacy/reference functionality rather than shaping the main terminal runtime.

## Terminal Session Lifecycle

```text
terminal_ensure  -> create or reattach session, wire log capture, send ready status
terminal_input   -> low-level text/Enter dispatch, optional readiness wait
terminal_send    -> structured interaction path with default settled wait and additive delta
terminal_observe -> explicit delta/screen/history observation
terminal_resize  -> backend resize
terminal_close   -> backend close and status update
```

## Output Streaming

Terminal output still uses the tmux-compatible path:

1. `pipe-pane` writes to `<terminal-base-dir>/sessions/{id}/terminal.log`
2. a watcher tails new bytes from that log
3. Bud emits `terminal_output` frames with base64-encoded chunks

The internal split keeps this behavior intact while isolating tmux-specific command construction in the backend adapter.

## Readiness

The terminal runtime currently supports several wait/assessment paths:

- output quiescence for the common settled shell path
- screen-change / screen-settled waits for explicit observe/send flows
- legacy activity-based readiness for low-level `terminal_input`

These waits are owned above the backend layer so future PTY/mosh-like backends can reuse the same readiness and delta contract.

## Usage

### First-Time Device Claim

```bash
cargo run -- --terminal-enabled
```

On first run without a stored device secret, the daemon:

1. generates or loads a stable `installation_id`
2. calls `/api/device-auth/start`
3. prints a claim URL plus terminal QR code
4. polls `/api/device-auth/poll` until approval
5. persists `bud_id` and `device_secret` to the configured identity path

### Legacy Manual Enrollment

```bash
cargo run -- --token <enrollment-token> --terminal-enabled
```

### Subsequent Connections

```bash
cargo run -- --terminal-enabled
```

The daemon loads the stored identity plus sibling `installation-id`, sends `hello`, answers the HMAC challenge, and resumes the normal runtime loop.

## CLI Options

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

## Dependencies

### Runtime requirements

- `tmux` for the current terminal backend
- `bash` or `sh` for shell execution

### Build requirements

- Rust stable toolchain
- system trust store support for TLS

## Known Issues

<!-- SPEC:TODO -->
- The service contract still carries tmux-shaped surface area (`tmux_session`, tmux backend capability names) for compatibility during the refactor; a follow-up should remove that leakage once the new module split is proven correct.
- Readiness/state handling is more centralized than before, but the runtime still contains multiple wait strategies that should continue converging as additional backends are introduced.
- The daemon still assumes the claim-flow HTTP origin can be derived from the configured WebSocket URL.
- The legacy queued `run` path remains by design with limited ownership; it is retained as reference functionality for future capability work rather than as a first-class runtime direction.

---

*Parent spec: [../bud.spec.md](../bud.spec.md)*
