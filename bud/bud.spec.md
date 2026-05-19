# bud

Rust device daemon that runs on user machines and connects to the Bud service via WebSocket or the Phase 2 opt-in gRPC control stream. It bootstraps device auth, maintains the on-device runtime for cloud-hosted agents, and currently provides a tmux-backed terminal implementation behind a more modular internal runtime split.

## Purpose

The Bud daemon:

1. bootstraps auth through a browser claim flow, with a dev-only token bypass for local automation
2. maintains a persistent WebSocket connection, or attempts an opt-in tonic gRPC control stream before falling back to WebSocket on non-auth transport failures, with automatic reconnect and heartbeats
3. executes the retained legacy queued `run` path for one-shot command work
4. manages thread-scoped interactive terminal sessions
5. reports local journal state after reconnect so the service can reconcile operation/stream outcomes
6. detects readiness and screen stability so the service can drive terminal interactions safely
7. tears down transport-bound proxy/file work on disconnect so stale stream tasks cannot block reconnect

## Files

### `README.md`

Contributor-facing usage guide for the daemon.

### `.env.example`

Shell-export template for local daemon development.

### `.env.https.example`

Optional shell-export template for routing the daemon through the local
mkcert+Caddy HTTPS parity profile at
`wss://localhost:3443/ws`.

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
- `proto_wire.rs` for protobuf `BudEnvelope` typed-payload compatibility encode/decode
- `grpc_control.rs` for tonic/prost `BudControl.Connect` client bindings and envelope conversion
- `transport.rs` for the daemon-side transport sender boundary that wraps WebSocket writes or gRPC control-stream frame writes
- `journal.rs` for the local reconnect/reconciliation journal foundation
- `terminal/mod.rs` for shared terminal runtime types and composition
- `terminal/backend.rs` for the backend trait
- `terminal/registry.rs`, `interaction.rs`, `observe.rs`, `readiness.rs`, and `delta.rs` for the split terminal runtime ownership
- `terminal/tmux.rs` for the tmux backend adapter
- `terminal/test_support.rs` for fake-backend terminal tests

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

- `app.rs` owns connection lifecycle and frame dispatch for both WebSocket and opt-in gRPC control.
- `app.rs` owns transport shutdown cleanup, including aborting the WebSocket writer task and canceling proxy/file stream work before reconnect.
- `proto_wire.rs` owns the compatibility envelope carrier codec used by both WebSocket binary frames and the tonic gRPC adapter.
- `grpc_control.rs` owns generated tonic/prost bindings and converts generated `BudEnvelope` messages to/from JSON-frame text for the existing handlers.
- `transport.rs` owns the transport-neutral sender seam; it carries JSON payloads directly for legacy peers, wraps them in typed-payload protobuf `BudEnvelope` binary frames after WebSocket capability negotiation, or forwards JSON payloads to the gRPC control writer.
- `journal.rs` stores the local Phase 1 reconciliation foundation without blocking startup on missing/corrupt journal files; `app.rs` sends a live `reconnect_report` after handshake and logs `reconciliation_decision` replies.
- `terminal/mod.rs` owns shared terminal runtime types while the split terminal modules own session registry, interaction, observation, readiness, and delta behavior.
- `terminal/backend.rs` defines the backend-neutral seam the runtime works against.
- `terminal/tmux.rs` owns tmux command execution and log capture details behind that seam.
- `run.rs` stays isolated as legacy/reference functionality rather than shaping the main terminal runtime.

## Terminal Session Lifecycle

```text
terminal_ensure  -> create or reattach session, wire log capture, send ready status
terminal_input   -> low-level text/Enter dispatch, optional readiness wait
terminal_send    -> single-gesture interaction path (`text`+optional `submit` or one semantic `key`) with default settled wait, post-dispatch quiescence guard, and additive delta
terminal_observe -> explicit delta/screen/history observation
terminal_resize  -> backend resize
terminal_close   -> backend close and status update
```

## Output Streaming

Terminal output still uses the tmux-compatible path:

1. `pipe-pane` writes to `<terminal-base-dir>/sessions/{id}/terminal.log`
2. a watcher tails new bytes from that log
3. Bud emits `terminal_output` frames with base64-encoded chunks capped at 16 KiB

The internal split keeps this behavior intact while isolating tmux-specific command construction in the backend adapter.

## Readiness

The terminal runtime currently supports several wait/assessment paths:

- output quiescence for the common settled shell path, with `terminal_send` starting quiescence sampling after dispatch plus a short guard delay while preserving the pre-send delta baseline
- screen-change / screen-settled waits for explicit observe/send flows
- legacy activity-based readiness for low-level `terminal_input`

Settled quiescence no longer implies high-confidence readiness on its own. Prompt, confirmation, password, and pager evidence can still produce high-confidence ready results, while weak settled captures such as echoed TUI launch commands remain conservative with `may_still_be_processing`.

These waits are owned above the backend layer so future PTY/mosh-like backends can reuse the same readiness and delta contract.

The runtime is now validated with unit tests that exercise send/observe behavior through a fake backend, so most terminal logic can evolve without requiring real tmux in the test loop.

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

### Dev Token Bypass

```bash
cargo run -- --token <enrollment-token> --terminal-enabled
```

The token path is for local automation only and must match the service `DEV_BUD_TOKEN_BYPASS`; production onboarding uses the browser-mediated claim flow.

### Subsequent Connections

```bash
cargo run -- --terminal-enabled
```

The daemon loads the stored identity plus sibling `installation-id`, sends `hello`, answers the HMAC challenge, and resumes the normal runtime loop.

## CLI Options

| Option | Env Variable | Default | Description |
|--------|--------------|---------|-------------|
| `--server` | `BUD_SERVER_URL` | `wss://localhost:8443/ws` | Service endpoint used for WebSocket control and device-claim HTTP origin derivation |
| `--grpc-control-url` | `BUD_GRPC_CONTROL_URL` | - | Optional tonic gRPC control endpoint such as `http://127.0.0.1:50051`; non-auth connection failures fall back to the WebSocket baseline |
| `--token` | `BUD_ENROLLMENT_TOKEN` | - | Dev-only token-bypass credential for local automation |
| `--name` | `BUD_DEVICE_NAME` | `bud-dev` | Device name |
| `--cwd` | `BUD_DEFAULT_CWD` | `~` | Working directory |
| `--identity-file` | `BUD_IDENTITY_FILE` | `~/.bud/identity.json` | Identity storage |
| `--terminal-base-dir` | `BUD_TERMINAL_BASE_DIR` | `~/.bud` | Base directory for terminal logs and session artifacts |
| `--terminal-enabled` | `BUD_TERMINAL_ENABLED` | `false` | Enable terminals |
| `--terminal-cols` | `BUD_TERMINAL_COLS` | `200` | Terminal width |
| `--terminal-rows` | `BUD_TERMINAL_ROWS` | `50` | Terminal height |
| `--debug` | `BUD_DEBUG` | `false` | Debug logging |

The default local env template targets `ws://localhost:3000/ws`. The optional
HTTPS parity template targets `wss://localhost:3443/ws` through the repo-root
Caddy profile.

## Dependencies

### Runtime requirements

- `tmux` for the current terminal backend
- `bash` or `sh` for shell execution

### Build requirements

- Rust stable toolchain
- system trust store support for TLS
- `protoc` available on `PATH` for tonic/prost code generation

The daemon's Rustls-backed HTTP and WebSocket clients use native OS root
certificates, so the optional local HTTPS profile trusts mkcert certificates
after `mkcert -install`.

## Known Issues

<!-- SPEC:TODO -->
- The daemon still accepts the legacy plural `keys` field as a one-entry compatibility alias during rollout; once all first-party callers have moved to canonical `key`, that shim can be removed.
- Readiness/state handling is more centralized than before, but the runtime still contains multiple wait strategies that should continue converging as additional backends are introduced.
- The daemon still assumes the claim-flow HTTP origin can be derived from the configured `--server` URL; gRPC control users should point `BUD_SERVER_URL` at the service HTTP origin when not using WebSocket.
- The legacy queued `run` path remains by design with limited ownership; it is retained as reference functionality for future capability work rather than as a first-class runtime direction.
- Optional HTTP/2 gRPC still keeps a bounded `frame_json` compatibility bridge in the adapter, while WebSocket terminal/control and core stream lifecycle frames use typed protobuf fields. Future QUIC work must reuse the typed payload contract instead of copying the bridge.

---

*Parent spec: [../bud.spec.md](../bud.spec.md)*
