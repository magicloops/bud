# src

Source code for the Bud device daemon. The daemon is now split into focused modules so the service-facing runtime contract, terminal orchestration, tmux adapter, device-auth bootstrap, and legacy run executor can evolve independently.

## Files

### `main.rs`

Thin CLI entrypoint:

- parses `BudArgs` with `clap`
- initializes tracing
- runs the daemon inside a Tokio `LocalSet`
- delegates all real runtime behavior to `bud::run(...)`

### `lib.rs`

Crate root for the daemon runtime.

- declares the internal modules
- re-exports `BudArgs` and `setup_tracing()`
- exposes `run(args)` as the single high-level entry used by `main.rs`

### `config.rs`

CLI and environment configuration.

- defines `BudArgs`
- owns daemon defaults for server URL, identity path, terminal base dir, terminal dimensions, reconnect timing, and debug mode

### `app.rs`

Top-level daemon orchestrator.

**`BudApp`** coordinates:

- identity loading and device-claim bootstrap
- WebSocket connect / reconnect behavior
- handshake and challenge-response auth
- heartbeat scheduling
- routing inbound server frames to the run or terminal subsystems
- capability advertisement in the `hello` frame

**Key types**:

- `BudApp` - process-wide runtime owner
- `SessionMeta` - server-issued session bookkeeping
- `HandshakeError` - separates `AUTH_FAILED` reauth from transport/protocol failures

### `protocol.rs`

Bud <-> service frame definitions and protocol validation.

- defines `Envelope`, handshake frames, `RunFrame`, and all `terminal_*` inbound frames
- keeps `PROTO_VERSION = "0.1"` and `TERMINAL_PROTO_VERSION = "0.2"`
- exposes `validate_inbound_envelope_proto(...)` so the app layer rejects mismatched inbound protocol versions before dispatch

### `util.rs`

Small shared helpers used across modules.

- WebSocket frame sending helpers
- HMAC proof generation
- ULID message ids and millisecond timestamps
- shell/path helpers
- tracing initialization

### `identity.rs`

Local device identity persistence.

- loads/stores `DeviceIdentity`
- keeps the stable sibling `installation-id` file separate from the secret-bearing identity file
- clears invalid identity state when the backend rejects stored credentials
- writes private files with `0600` permissions

### `claim.rs`

Browser-mediated device-claim bootstrap.

- starts and polls `/api/device-auth/*`
- renders human-readable terminal instructions
- prints a terminal QR code for headless setups
- derives the HTTP base URL from the configured WebSocket origin

### `run.rs`

Legacy queued command executor retained as reference functionality.

- preserves the old one-shot `run` frame path
- owns shell spawn, stdout/stderr chunking, and `run_finished`
- remains intentionally isolated from the terminal runtime so future non-terminal capabilities still have a reference path

### `terminal/mod.rs`

Service-facing terminal runtime and readiness layer.

This module owns the terminal contract above the backend boundary. It is responsible for:

- terminal session registry and sender lifecycle
- `terminal_ensure`, `terminal_input`, `terminal_resize`, `terminal_close`, `terminal_send`, and `terminal_observe`
- additive delta construction for `terminal.send` / default `terminal.observe`
- output-quiescence waits, screen-stability waits, and readiness assessment
- delivered-capture tracking and explicit observation semantics
- terminal status payload construction
- terminal session env defaults (`COLORTERM=truecolor`, `COLORFGBG=15;0`)

**Important boundary**:

- `TerminalManager` owns the service-facing contract
- `ReadinessDetector` and related helpers keep readiness logic above the backend layer
- tmux remains the only backend today, but tmux command details are pushed down into `terminal/tmux.rs`

### `terminal/tmux.rs`

tmux backend adapter.

- creates/reattaches sessions
- configures `pipe-pane`
- captures panes
- resizes / kills sessions
- sends literal text and tmux key names
- spawns the log-file watcher that emits `terminal_output`
- probes tmux availability/version

The backend still intentionally supports the current tmux-shaped wire behavior for compatibility, but the service-facing orchestration now lives outside this adapter.

## Architecture

```text
main.rs
  |
  v
lib.rs::run(...)
  |
  v
app.rs::BudApp
  |
  +--> identity.rs / claim.rs
  |
  +--> run.rs
  |
  +--> terminal/mod.rs
         |
         +--> readiness + delta + session registry
         |
         +--> terminal/tmux.rs
```

## Terminal Runtime Responsibilities

### Above the backend boundary

- maintain session handles and delivered-capture state
- interpret inbound `terminal_*` frames
- decide wait strategy (`none`, `changed`, `settled`, `shell_ready`)
- build readiness assessments and additive delta payloads
- preserve the existing service contract

### tmux-specific backend adapter

- translate terminal actions into tmux commands
- manage `pipe-pane` log capture
- capture pane contents
- report tmux availability/version

## Tests

High-value local tests now live next to the extracted abstractions:

- `protocol.rs`
  - inbound protocol validation
- `terminal/mod.rs`
  - wait-mode parsing
  - ctrl-key normalization
  - additive delta behavior
  - env defaults/overrides
  - CRLF low-level input splitting
  - terminal-status info merge behavior
- `terminal/tmux.rs`
  - shell-safe `pipe-pane` command quoting

## Dependencies

External crates (from `Cargo.toml`):

| Crate | Purpose |
|-------|---------|
| `tokio` | Async runtime with process, fs, sync features |
| `tokio-tungstenite` | WebSocket client |
| `clap` | CLI argument parsing |
| `serde` / `serde_json` | JSON serialization |
| `nix` | Unix utilities for the legacy run executor |
| `anyhow` | Error handling |
| `base64` | Data encoding for frames |
| `hmac` / `sha2` | Authentication |
| `reqwest` | Device-auth bootstrap HTTP client |
| `qrcodegen` | Terminal QR rendering |
| `tracing` / `tracing-subscriber` | Logging |
| `ulid` | Message ID generation |
| `chrono` | Timestamp formatting |
| `shellexpand` | Path tilde expansion |

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- The wire contract still exposes tmux-shaped fields such as `tmux_session` and tmux backend capability names; this is intentionally preserved for now and should be cleaned up in a follow-up once the internal split is proven correct.
- Readiness and status are now centralized above the backend layer, but the terminal runtime still contains multiple internal assessment paths (`shell_ready`, `changed`, `settled`, legacy activity-based waits) that should continue converging on shared readiness primitives as more backends arrive.
- The legacy queued `run` path is intentionally retained as reference functionality, not as the primary runtime model, so ownership is deliberately light until a future capability expansion needs it.
- Device-auth bootstrap still depends on outbound HTTPS from the daemon; there is no offline/local fallback beyond presenting the claim URL and QR code.

---

*Referenced by: [bud.spec.md](../bud.spec.md)*
