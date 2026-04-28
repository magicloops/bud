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
- owns daemon defaults for server URL, optional gRPC control/data URLs, identity path, terminal base dir, terminal dimensions, reconnect timing, and debug mode

### `app.rs`

Top-level daemon orchestrator.

**`BudApp`** coordinates:

- identity loading and device-claim bootstrap
- WebSocket connect / reconnect behavior
- WebSocket bootstrap now sends `hello` as a binary `BudEnvelope` instead of JSON text
- opt-in tonic gRPC control connect / reconnect behavior when `BUD_GRPC_CONTROL_URL` is set
- falls back to the WebSocket baseline when the opt-in gRPC control carrier is unavailable, while preserving auth failures instead of looping through fallback
- opt-in tonic gRPC data attachment after control authentication when `BUD_GRPC_DATA_URL` is set
- handshake and challenge-response auth
- live reconnect report emission after handshake using the local journal
- heartbeat scheduling
- routing inbound server frames to the run or terminal subsystems
- routing Phase 4.2 `proxy_open` requests to the localhost proxy adapter
- routing Phase 4.4 `file_open` requests to the workspace file adapter
- routing WebSocket-received `stream_credit`, `stream_reset`, and `stream_close` frames to the file/proxy managers
- capability advertisement in the `hello` frame, now including behavior-oriented terminal fields plus localhost proxy/workspace file-read support when the active transport mode can carry generic stream frames

**Key types**:

- `BudApp` - process-wide runtime owner
- `SessionMeta` - server-issued session bookkeeping
- `HelloTransportMode` - active hello/capability shape selector for WebSocket vs gRPC attempts
- `HandshakeError` - separates `AUTH_FAILED` reauth from transport/protocol failures

### `protocol.rs`

Bud <-> service frame definitions and protocol validation.

- defines `Envelope`, handshake frames, `RunFrame`, and all `terminal_*` inbound frames
- `TerminalSendFrame` now treats `key` as the canonical single-gesture non-text input field while still deserializing the old plural `keys` alias for rollout compatibility
- keeps `PROTO_VERSION = "0.1"` and `TERMINAL_PROTO_VERSION = "0.2"`
- exposes `validate_inbound_envelope_proto(...)` so the app layer rejects mismatched inbound protocol versions before dispatch

### `proto_wire.rs`

Minimal protobuf wire codec for `BudEnvelope v1` compatibility frames.

- encodes active terminal/control frame bodies under typed protobuf oneof payload tags with direct protobuf fields
- encodes core stream lifecycle frames under typed payload tags with direct protobuf fields so WebSocket binary `BudEnvelope` can carry the file/proxy data plane
- keeps legacy `LegacyJsonPayload` encode/decode helpers for conformance fixtures and pre-cutover fixture coverage
- decodes protobuf envelopes back to JSON text before handing off to existing frame handlers
- shares conformance fixture coverage with the service through `proto/fixtures/legacy-terminal-ensure.json`
- tolerates unknown protobuf fields while validating the envelope version and required compatibility payload

### `grpc_control.rs`

tonic/prost adapter for the Phase 2 daemon control client.

- includes generated `bud.v1` protobuf bindings from [../../proto/bud/v1/bud.proto](../../proto/bud/v1/bud.proto)
- opens `BudControl.Connect` bidirectional streams
- converts outbound JSON frames into generated `BudEnvelope` messages with `transport_kind = H2_GRPC`
- exposes a shared transport-kind-aware JSON-to-envelope helper used by the data client
- converts inbound generated `BudEnvelope` messages back to JSON text for the existing frame dispatcher
- keeps generated protobuf details out of terminal/run modules

### `grpc_data.rs`

tonic/prost adapter for the Phase 3 daemon data client.

- opens `BudData.Attach` bidirectional streams after gRPC control authentication
- converts outbound JSON frames into generated `BudEnvelope` messages with `transport_kind = H2_DATA`
- currently supports the terminal-output data stream while control, heartbeat, terminal requests, and request-scoped terminal results stay on the control stream
- negotiates `localhost_http_proxy` and `file_read` alongside `terminal_output` when data is configured
- rejects unsupported inbound generic `stream_data` frames with typed `stream_reset`
- routes generic `stream_credit` and `stream_reset` frames into the localhost proxy and file managers

### `proxy/` → [proxy/proxy.spec.md](./proxy/proxy.spec.md)

Daemon-side Phase 4.2 localhost HTTP proxy adapter.

- validates `proxy_open` requests against local loopback/method policy
- performs no-redirect `http://127.0.0.1:<port>` requests
- returns `proxy_open_result` accept/reject metadata on control
- streams response bytes as generic `stream_data` frames over the active data-plane carrier
- waits for service `stream_credit` and stops on `stream_reset`

### `files/` → [files/files.spec.md](./files/files.spec.md)

Daemon-side Phase 4.4 workspace file adapter.

- validates `file_open` requests against local workspace/root/path policy
- rejects symlinks, non-regular files, root escapes, and over-limit reads
- supports stat, full read, and single byte-range read modes
- computes and checks file content identity
- returns `file_open_result` accept/reject metadata on control
- streams file bytes as generic `stream_data` frames over the active data-plane carrier
- waits for service `stream_credit` and stops on `stream_reset`

### `transport.rs`

Daemon-side transport sender boundary.

- defines `TransportSender` and `TransportKind`
- wraps the active WebSocket writer or gRPC control frame sender
- optionally wraps a bounded gRPC data frame sender for data-plane-capable sessions
- sends protobuf envelope binary frames when the service negotiated `bud_envelope.websocket_binary`; active terminal/control binary frames use direct typed payload fields
- exposes `send_transport_frame(...)` and `send_transport_message(...)`
- lets terminal and legacy run modules emit daemon payloads without depending directly on raw WebSocket sender types
- routes `terminal_output` over the gRPC data channel when attached and falls back to the control channel if the data channel is unavailable
- routes generic `stream_data`, `stream_credit`, `stream_reset`, and `stream_close` over the WebSocket carrier when connected by WebSocket, or over the gRPC data channel when connected by gRPC with data attached

### `journal.rs`

Local daemon reconciliation journal foundation for network-upgrade Phase 1.

- stores accepted operation summaries
- stores active stream checkpoints
- stores known terminal session ids and local policy version
- loads missing/corrupt journals as empty state so daemon startup is not blocked

`BudApp` now reads this journal after handshake and sends a live `reconnect_report`; service replies with `reconciliation_decision`, which the daemon currently logs while later stream-specific resume/reset behavior is built.

### `util.rs`

Small shared helpers used across modules.

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

Terminal runtime composition root.

- defines shared terminal runtime types (`TerminalConfig`, `TerminalManager`, session/capture state)
- makes `TerminalManager` generic over a `TerminalBackend`, with `TmuxBackend` as the default concrete backend
- owns terminal-wide constants and the public `probe_tmux()` helper

### `terminal/backend.rs`

Backend abstraction for the terminal runtime.

- defines `TerminalBackend`
- describes the backend facts/operations the runtime needs:
  - session naming and log paths
  - session lifecycle control
  - low-level text/key dispatch
  - pane capture
  - output watcher spawning

This is the main seam that lets the runtime stay backend-neutral above tmux.

### `terminal/registry.rs`

Session registry and lifecycle ownership.

- terminal session registry and sender lifecycle
- `terminal_ensure`, `terminal_resize`, and `terminal_close`
- delivered-capture storage
- status payload assembly
- terminal session env defaults (`COLORTERM=truecolor`, `COLORFGBG=15;0`)
- session creation/reattach orchestration over the backend trait

### `terminal/interaction.rs`

Interactive send/input runtime.

- `terminal_input`
- `terminal_send`
- low-level CRLF-aware input splitting
- single-gesture structured submission: either `text` with optional `submit`, or one semantic `key`
- compatibility normalization for legacy one-entry `keys`
- send error payload assembly

### `terminal/observe.rs`

Explicit observation runtime.

- `terminal_observe`
- delta/screen/history view handling
- delivered-capture baseline reuse
- observe error payload assembly

### `terminal/readiness.rs`

Readiness and wait-policy ownership above the backend layer.

- `ReadinessDetector`
- `ActivityDetector`
- output-quiescence waits
- screen wait loops
- readiness assessment generation
- capture helpers shared by send/observe

### `terminal/delta.rs`

Additive delta ownership.

- capture hashing/summarization
- additive delta extraction
- low-signal separator stripping
- JSON delta payload assembly

### `terminal/tmux.rs`

tmux backend adapter and current concrete backend implementation.

- implements `TerminalBackend` for `TmuxBackend`
- creates/reattaches sessions
- configures `pipe-pane`
- captures panes
- resizes / kills sessions
- sends literal text and tmux key names
- owns the output watcher implementation that emits `terminal_output`
- probes tmux availability

The backend still intentionally accepts tmux-style key aliases for compatibility, but the normal service-facing contract above it is now backend-neutral.

### `terminal/test_support.rs`

Test-only terminal harness compiled under `#[cfg(test)]`.

- provides a fake backend that implements `TerminalBackend`
- exposes helpers for installing test sessions and receiving emitted WebSocket frames
- supports abstraction-level tests for send/observe logic without requiring real tmux

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
  +--> proxy/
  |
  +--> files/
  |
  +--> terminal/mod.rs
         |
         +--> terminal/backend.rs
         +--> terminal/registry.rs
         +--> terminal/interaction.rs
         +--> terminal/observe.rs
         +--> terminal/readiness.rs
         +--> terminal/delta.rs
         +--> terminal/tmux.rs
```

## Terminal Runtime Responsibilities

### Above the backend boundary

- maintain session handles and delivered-capture state
- interpret inbound `terminal_*` frames
- decide wait strategy (`none`, `changed`, `settled`, `shell_ready`)
- build readiness assessments and additive delta payloads
- expose the current backend-neutral service contract while keeping compatibility shims localized

### tmux-specific backend adapter

- translate terminal actions into tmux commands
- manage `pipe-pane` log capture
- capture pane contents
- report tmux availability

## Tests

High-value local tests now live next to the extracted abstractions:

- `protocol.rs`
  - inbound protocol validation
- `proto_wire.rs`
  - protobuf compatibility envelope fixture encode/decode
- `proxy/mod.rs`
  - localhost proxy-open policy validation
- `files/mod.rs`
  - workspace file-open policy and range selection
- `transport.rs`
  - gRPC data-channel terminal-output routing and control fallback
- `journal.rs`
  - journal round-trip and corrupt/missing tolerance
- `terminal/registry.rs`
  - env defaults/overrides
  - terminal-status info merge behavior
- `terminal/interaction.rs`
  - ctrl-key normalization
  - CRLF low-level input splitting
  - fake-backend `terminal_send` flow
- `terminal/observe.rs`
  - fake-backend `terminal_observe` delta flow
- `terminal/readiness.rs`
  - wait-mode parsing
  - readiness assessment overrides
- `terminal/delta.rs`
  - additive delta behavior
- `terminal/tmux.rs`
  - shell-safe `pipe-pane` command quoting

## Dependencies

External crates (from `Cargo.toml`):

| Crate | Purpose |
|-------|---------|
| `tokio` | Async runtime with process, fs, sync features |
| `tokio-tungstenite` | WebSocket client |
| `tonic` / `tonic-prost` / `prost` | gRPC control/data clients and generated protobuf message support |
| `tokio-stream` | Adapts control/data stream outbound channels for tonic |
| `clap` | CLI argument parsing |
| `serde` / `serde_json` | JSON serialization |
| `nix` | Unix utilities for the legacy run executor |
| `anyhow` | Error handling |
| `base64` | Data encoding for frames |
| `hmac` / `sha2` | Authentication |
| `reqwest` | Device-auth bootstrap HTTP client and no-redirect localhost proxy requests |
| `qrcodegen` | Terminal QR rendering |
| `tracing` / `tracing-subscriber` | Logging |
| `ulid` | Message ID generation |
| `chrono` | Timestamp formatting |
| `shellexpand` | Path tilde expansion |

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Readiness and status are now centralized above the backend layer, but the terminal runtime still contains multiple internal assessment paths (`shell_ready`, `changed`, `settled`, legacy activity-based waits) that should continue converging on shared readiness primitives as more backends arrive.
- Key translation still retains tmux-oriented notation compatibility in the interaction layer; once the rollout shim is no longer needed, that normalization should move fully behind the backend boundary.
- The legacy queued `run` path is intentionally retained as reference functionality, not as the primary runtime model, so ownership is deliberately light until a future capability expansion needs it.
- Device-auth bootstrap still depends on outbound HTTPS from the daemon; there is no offline/local fallback beyond presenting the claim URL and QR code.

---

*Referenced by: [bud.spec.md](../bud.spec.md)*
