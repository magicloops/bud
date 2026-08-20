# src

Source code for the Bud device daemon. The daemon is split into focused modules so the service-facing runtime contract, the stem-backed terminal runtime, device-auth bootstrap, and the legacy run executor can evolve independently.

## Files

### `main.rs`

Thin CLI entrypoint:

- prints build metadata for `--version` before entering normal CLI parsing
- parses `BudArgs` with `clap`
- initializes tracing
- runs the daemon inside a Tokio `LocalSet`
- delegates all real runtime behavior to `bud::run(...)`

### `lib.rs`

Crate root for the daemon runtime.

- declares the internal modules
- re-exports `BudArgs`, `BudCommand`, `ServiceCommand`, and `setup_tracing()`
- exposes `run(args)` as the single high-level entry used by `main.rs`, dispatching subcommands (`doctor`, `claim`, lifecycle verbs `start|stop|restart|status|logs`, `service install|uninstall`) before entering the long-running daemon loop; `run` or no subcommand = foreground daemon

### `config.rs`

CLI and environment configuration.

- defines `BudArgs`
- defines `BudCommand` (doctor, claim, run, start/stop/restart/status/logs, service install/uninstall, llm probe/enable/disable, upgrade), `ServiceCommand`, `LlmCommand`, `LogsArgs`, `DoctorArgs`, and `DoctorFormat`
- owns daemon defaults for server URL, optional gRPC control/data URLs, optional install claim id, base-dir/local mode, identity path overrides, terminal base dir overrides, terminal dimensions, reconnect timing, and debug mode
- owns optional Bud-local ds4 configuration through `BUD_LOCAL_LLM_DS4_URL`, `BUD_LOCAL_LLM_DS4_CONTEXT_TOKENS`, and `BUD_LOCAL_LLM_DS4_MAX_OUTPUT_TOKENS` (default 384000)
- resolves effective daemon paths so machine installs default to `~/.bud` plus `$HOME` while `--local` derives `.bud` and cwd from the launch directory

### `doctor.rs`

Local diagnostic command implementation.

- evaluates the effective config and path resolution used by the daemon runtime
- checks OS/architecture support, base-dir and terminal artifact writability, identity file permissions, service URL parsing, production TLS trust when applicable, shell availability, and user-service manager hints (terminal support is native via `stem`; no external multiplexer preflight remains)
- checks the stem terminal registry (`<terminal base dir>/term`): exists or is created via `stem::registry::Registry` (mode 0700), is a directory, is writable, and warns with a `chmod 700` remediation on permission drift
- runs a holder smoke check when terminal support is enabled: spawns a real detached holder via the daemon's own executable (`bud term-hold` through `stem::registry::Registry::ensure`, the production spawn path) against a short throwaway temp dir, verifies socket + Hello, kills it, and verifies registry GC; time-boxed (8s overall) with an error and remediation on failure
- probes installed supervision directives best-effort: warns when a `*bud*.plist` under `~/Library/LaunchAgents` lacks `AbandonProcessGroup=true` (macOS defense-in-depth) or a `*bud*.service` under the systemd user config dir lacks `KillMode=process` (load-bearing on Linux — sessions do not survive daemon restarts without it; see `spikes/holder-survival/findings.md`); "not service-managed" is informational, never a failure
- prints human-readable output by default and JSON when `bud doctor --format json` is requested
- `bud doctor --cleanup-tmux` is a one-shot best-effort kill of legacy tmux-era `s_*` sessions; it is a silent no-op when no tmux binary exists

### `lifecycle.rs`

Managed daemon lifecycle (design/managed-daemon-lifecycle.md Option A).

- `ServiceManager::detect()` → launchd (macOS) / systemd user (Linux with a
  reachable user manager) / none
- generates the launchd plist (`~/Library/LaunchAgents/dev.bud.daemon.plist`;
  sources `bud.env` via a `/bin/sh -c 'set -a; . bud.env; …'` wrapper since
  launchd has no EnvironmentFile; `RunAtLoad`, `KeepAlive.SuccessfulExit=false`,
  `AbandonProcessGroup=true`, stdout/err → `<base>/logs/daemon.log`) and the
  systemd user unit (`~/.config/systemd/user/bud.service`;
  `EnvironmentFile=-<base>/bud.env`, `Restart=on-failure`, **`KillMode=process`**,
  `StandardOutput/Error=append:` the same log file) — generated content is
  cross-validated against the doctor's supervision parsers in tests
- `service install` writes + loads the service (bootstrap/enable --now) and
  best-effort `loginctl enable-linger` on Linux; `service uninstall` unloads
  and removes it; identity is never touched
- verbs `start|stop|restart` dispatch to the platform manager when the service
  file exists, otherwise a pidfile fallback (`<base>/bud.pid`): detached
  `setsid` spawn with env parsed from `bud.env`, SIGTERM to the daemon pid
  only — never process groups, never holders
- `status` prints manager kind + service state, daemon pid, identity summary
  (or a `bud claim` hint), server URL from `bud.env`, holder count, log path;
  `logs [-n] [-f]` tails `<base>/logs/daemon.log`
- `parse_env_file` handles the installer's single-quoted `KEY='value'` format;
  `upsert_env_var`/`remove_env_var` edit `bud.env` surgically (single config
  home)
- `bud llm probe|enable|disable`: probes candidate URLs (configured →
  `127.0.0.1:8888/v1` → `127.0.0.1:8000/v1`) through the daemon's own ds4
  detection (`local_llm::probe_ds4_url` — one rule for installer, CLI, and
  connect-time capability), persists/removes `BUD_LOCAL_LLM_DS4_URL` in
  `bud.env`; `status` reports the llm state (serving id / unreachable / not
  configured)

### `upgrade.rs`

`bud upgrade [--check]` (design/managed-daemon-lifecycle.md phase 2):
fetches the get.bud.dev stable manifest (`BUD_UPGRADE_BASE_URL`
override), compares the baked release version (`BUD_BUILD_VERSION`,
dev fallback `v<crate>`), downloads the target's archive
(baked `BUD_BUILD_TARGET`, runtime os/arch fallback), verifies sha256,
extracts the binary, and installs via the ETXTBSY-safe staged rename.
Restarts the managed service (or pidfile daemon) so the new inode runs;
"different version" — including rollbacks — counts as an update, since
the manifest is the authority on stable. `bud status` gains a
best-effort version/update line (1.5s budget, silent on failure).

### `app.rs`

Top-level daemon orchestrator. `claim_only()` (backing `bud claim`) runs the device-claim flow and exits instead of connecting, enabling the installer's claim-then-service handoff.

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
- routing inbound server frames to the run or terminal subsystems; terminal frames are **spawned per request** (`task::spawn_local`), never awaited inline in the dispatch loop, so long `await: "command"` sends cannot block heartbeats/credits (review finding D-H1); per-session ordering lives inside the terminal manager
- transport shutdown cleanup that clears run/terminal senders, aborts stale
  WebSocket writer tasks, and cancels proxy/file stream work before reconnect
- routing Phase 4 `proxy_open` requests and same-stream request body data to
  the localhost proxy adapter
- routing Phase 5 `proxy_ws_open` / `proxy_ws_message` / `proxy_ws_close` / `proxy_ws_error` requests to the localhost WebSocket proxy adapter
- routing Phase 4.4 `file_open` requests to the workspace file adapter
- routing Phase 7 `file_resolve` requests to the workspace file adapter for metadata-only absolute POSIX preflight
- skips the fresh terminal-session cwd query for `file_open` frames that already carry a message-time `host_cwd` resolution hint
- resolved base-dir/local defaults for identity, installation id, terminal state, legacy run cwd, and file workspace root
- routing WebSocket-received `stream_data`, `stream_credit`, `stream_reset`,
  and `stream_close` frames to the file/proxy/local-LLM managers where supported
- routing `local_llm_open` requests to the Bud-local ds4 forwarding adapter when
  `BUD_LOCAL_LLM_DS4_URL` is configured and the startup probe is healthy
- capability advertisement in the `hello` frame, now including behavior-oriented terminal fields plus localhost proxy/workspace file-read support when the active transport mode can carry generic stream frames; WebSocket-mode daemons additionally advertise `proxy.localhost_websocket`; proxy target-host capabilities advertise exact `localhost`, `127.0.0.1`, and `::1` with `localhost` as the default target host
- optional `capabilities.llm` advertisement for a healthy local ds4 server using
  logical server id `ds4`, Responses-only compatibility, and no raw local URL

**Key types**:

- `BudApp` - process-wide runtime owner
- `SessionMeta` - server-issued session bookkeeping
- `HelloTransportMode` - active hello/capability shape selector for WebSocket vs gRPC attempts
- `HandshakeError` - separates `AUTH_FAILED` reauth from transport/protocol failures

### `protocol.rs`

Bud <-> service frame definitions and protocol validation.

- defines `Envelope`, handshake frames, `RunFrame`, and all `terminal_*` inbound frames per the proto `0.3` terminal contract (docs/proto.md §6.7)
- `TerminalEnsureFrame` carries optional `resume_from_offset` for offset-exact output backfill
- `TerminalSendFrame` is the single-gesture surface `{ text?, submit?, key?, await? }`; `await` is a typed enum (`command` | `settled`), and the retired `wait_for`/`timeout_ms`/plural-`keys` vocabulary no longer deserializes
- `TerminalObserveFrame` keeps `view: screen|delta|history` plus optional `lines`; wait vocabulary removed
- `TerminalInputFrame` is raw base64 keyboard bytes plus optional `input_seq` (predictive-echo sequencing, §6.8.3; BudEnvelope typed field 4 — field 3 stays reserved for the retired 0.2 `await_ready`)
- owns the outbound 0.3 frame builders used by the terminal runtime: `terminal_output_frame` (offset-addressed, no `seq`), `terminal_event_frame` (§6.7.3 vocabulary), `terminal_status_frame` (stem-backed info), `terminal_send_result_frame` (`dispatched`/`outcome`/`error`), `terminal_observe_result_frame` (grid-backed `TerminalObservation`), and `terminal_grid_frame` (§6.8.2 grid-sync deltas); parses `terminal_grid_watch` (§6.8.1)
- `FileOpenFrame` accepts an optional `resolution_hint` so service-created file sessions can prefer message-time cwd without a click-time terminal query
- `FileResolveFrame` carries metadata-only absolute POSIX file preflight requests before service-side file-session creation
- `ProxyWebSocketOpenFrame`, `ProxyWebSocketMessageFrame`, `ProxyWebSocketCloseFrame`, and `ProxyWebSocketErrorFrame` carry the Phase 5 message-oriented WebSocket proxy contract
- `ProxyOpenFrame` carries optional `request_body_bytes` for bounded
  service-to-daemon HTTP proxy uploads
- `LocalLlmOpenFrame` carries logical Bud-local LLM open requests for
  `local_llm_http` streams; the active ds4 path is limited to
  `POST /v1/responses`
- HTTP proxy open results may include out-of-band `set_cookies` arrays emitted
  by the local target and filtered by the service before browser delivery
- keeps `PROTO_VERSION = "0.1"` and `TERMINAL_PROTO_VERSION = "0.3"`
- exposes `validate_inbound_envelope_proto(...)` so the app layer rejects mismatched inbound protocol versions before dispatch

### `proto_wire.rs`

Minimal protobuf wire codec for `BudEnvelope v1` compatibility frames.

- proto `0.3` terminal frames are carried as `frame_json` inside their typed payload messages; field-level protobuf encoding for terminal frames retired with the `0.2` contract
- `terminal_event` has no oneof slot in `bud.proto` and travels via the self-describing `legacy_json` payload (field 100); `terminal_ready` (slot 130) is retired
- keeps inbound decode tolerance for field-level terminal payloads a service encoder may still emit: retired 0.2 wait/readiness fields are skipped, new 0.3 fields decode at the next free numbers (`terminal_ensure.resume_from_offset = 3`, `terminal_send.await = 9`)
- stamps `proto: "0.3"` when reconstructing terminal frames from field-level payloads
- encodes core stream lifecycle frames under typed payload tags with direct protobuf fields so WebSocket binary `BudEnvelope` can carry the file/proxy data plane
- maps the `local_llm_http` stream family in the protobuf/json stream-type
  vocabulary so local LLM bytes can use the same generic stream lifecycle frames
- maps Phase 5 `proxy_ws_*` frame types to typed protobuf payload tags with transitional `frame_json`
- keeps legacy `LegacyJsonPayload` encode/decode helpers for conformance fixtures
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
- negotiates `localhost_http_proxy`, `localhost_websocket_proxy`, `file_read`,
  and `local_llm_http` alongside `terminal_output` when the corresponding
  daemon capabilities are configured
- routes generic `stream_data`, `stream_credit`, and `stream_reset` frames into
  the localhost proxy and file managers where supported, rejecting unsupported
  stream families with typed `stream_reset`

### `proxy/` → [proxy/proxy.spec.md](./proxy/proxy.spec.md)

Daemon-side localhost HTTP and WebSocket proxy adapter.

- validates `proxy_open` requests against local loopback/method policy
- performs no-redirect `http://<loopback-host>:<port>` requests for
  `127.0.0.1`, `::1`, or exact `localhost`
- assembles bounded request bodies from same-stream `stream_data` before
  opening local mutation requests
- revalidates `localhost` resolution as loopback before opening a local request
- returns `proxy_open_result` accept/reject metadata on control
- returns local target `Set-Cookie` values as `proxy_open_result.set_cookies`
  for service-side endpoint-host filtering
- streams response bytes as generic `stream_data` frames over the active data-plane carrier
- waits for service `stream_credit` and stops on `stream_reset`
- cancels active HTTP and WebSocket proxy work when the active daemon transport
  disconnects
- dials local `ws://` loopback targets for `proxy_ws_open`
- bridges WebSocket text/binary messages with `proxy_ws_message`
- propagates WebSocket close/error state with `proxy_ws_close` and `proxy_ws_error`
- has focused local WebSocket echo coverage for `127.0.0.1`, text/binary
  forwarding, local close propagation, unsafe target rejection, `localhost`
  loopback resolution validation, and typed local connect failure reporting

### `files/` → [files/files.spec.md](./files/files.spec.md)

Daemon-side Phase 4.4 workspace file adapter.

- validates `file_open` and `file_resolve` requests against local workspace/root/path policy
- uses the thread terminal pane cwd as the first relative-path candidate when service provides terminal context
- uses a server-provided message-time cwd resolution hint before terminal cwd, and skips terminal cwd entirely for hinted requests whose cwd is invalid or outside the workspace
- rejects symlinks, non-regular files, root escapes, and over-limit reads
- supports stat, full read, and single byte-range read modes
- computes and checks file content identity
- returns `file_open_result` and `file_resolve_result` accept/reject metadata on control, including accepted-open/resolve resolution metadata
- streams file bytes as generic `stream_data` frames over the active data-plane carrier
- waits for service `stream_credit` and stops on `stream_reset`
- cancels active file streams when the active daemon transport disconnects

### `local_llm.rs`

DeepSeek v4 family detection accepts versioned served ids (`deepseek-v4-flash-0731`): the canonical `deepseek-v4-flash` id is spoken platform-wide, the probe captures the ACTUAL served id, and the daemon rewrites the request `model` field at the edge before forwarding to the local server (`rewrite_model_field`; content-length is recomputed since it is not on the forwarded-header allowlist). `probe_ds4_url`/`ds4_served_model` are shared with `bud llm` verbs. The capability now advertises every served
model: the ds4 server entry is preserved unchanged when the family is
present, and a generic `local` server (provider `bud_local`, request mode
`openai_chat_completions`, path `/v1/chat/completions`) lists all models
with `validated` flags and probe-derived context windows
(`list_served_models`/`build_capability`). `BUD_LOCAL_LLM_URL` is the generic env key (`bud llm enable` writes it and removes the legacy ds4-named key; the ds4 var wins as family alias when present); the config URL parser accepts the documented `/v1` form and reduces any path to the origin (probe/enable delegate to the SAME parser — two-parser drift once silently discarded persisted config at startup); the open-frame policy
allows server ids `ds4`/`local` and both generation paths.

Daemon-side Bud-local LLM adapter for ds4.

- reads optional `BUD_LOCAL_LLM_DS4_URL` config and accepts only loopback
  `http://` origins without path, query, or fragment; `127.0.0.0` is rejected
  because it does not reach a normal loopback listener
- probes `GET /v1/models` with a short timeout before advertising
  `capabilities.llm`
- advertises logical server metadata only: `id: "ds4"`, provider `ds4`,
  compatibility `openai_responses`, request mode `ds4_openai_responses`, and
  generation path `/v1/responses`
- handles service `local_llm_open` frames by forwarding only
  `POST /v1/responses` to the configured loopback origin
- strips request headers to `accept` and `content-type`, returns only safe
  response headers, enforces bounded request/response bodies, and streams bytes
  through generic `stream_data` / `stream_credit` / `stream_reset` /
  `stream_close`
- enforces one active stream per daemon plus explicit idle and total-TTL guards
  (one-hour idle timeout and two-hour total TTL) so slow local inference can run
  while abandoned streams fail instead of hanging forever
- aborts active local LLM streams when the active daemon transport disconnects

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
- has no QUIC implementation yet; future QUIC data adapters must reuse the same `BudEnvelope` stream lifecycle frames and keep WebSocket fallback behavior intact

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
- includes `BUD_CLAIM_ID` / `--claim-id` during bootstrap when present so authenticated install commands can redeem without QR approval
- renders human-readable terminal instructions
- prints a terminal QR code for headless setups
- derives the HTTP base URL from the configured WebSocket origin

### `version.rs`

Build metadata helpers for release artifacts.

- formats the `bud --version` output
- exposes package version, build commit, target triple, and Cargo profile from
  compile-time environment values emitted by `build.rs`
- detects `--version` / `-V` before normal daemon startup so release artifacts
  are inspectable without running service setup or tracing

### `run.rs`

Legacy queued command executor retained as reference functionality.

- preserves the old one-shot `run` frame path
- owns shell spawn, stdout/stderr chunking, and `run_finished`
- remains intentionally isolated from the terminal runtime so future non-terminal capabilities still have a reference path

### `terminal/` → [terminal/terminal.spec.md](./terminal/terminal.spec.md)

Terminal runtime rebuilt on `stem` (Phase 2 cutover). Implements the proto
`0.3` terminal contract end to end:

- `terminal/mod.rs` — module composition; re-exports `TerminalConfig` / `TerminalManager`
- `terminal/manager.rs` — session lifecycle over `stem::registry` (holders re-exec `bud term-hold`; base dir `<terminal-base-dir>/term`, 0700) and all `terminal_*` handlers: ensure with `resume_from_offset` backfill, single-gesture send with `await: command|settled` outcomes and the sentinel exit-code fallback (design D6c), grid-backed observe (`screen`/`delta`/`history`), raw input, resize, close, and grid-watch (§6.8: per-entry event-driven emit task — pump-notified via `SessionShared.grid_dirty`, ~8 ms coalescing, ~16 ms min inter-frame gap, ~100 ms idle poll — draining `Session::take_grid_frame` into `terminal_grid` frames stamped with `predict_ok` (cached-termios interactive-prompt gate, §6.8.3 — forced frame on gate flips) and `applied_input_seq`; immediate full on enable, dies with the entry); per-session mutex serializes gestures while awaits resolve off-lock (review finding D-H1)
- `terminal/grid.rs` — `stem::GridFrame` → `terminal_grid` payload serialization (run encoding: `t`/`fg`/`bg`/`a`, defaults omitted; palette index number or `[r,g,b]`)
- `terminal/session_task.rs` — event pump mapping `stem::Event`s onto `terminal_output` (≤16 KiB offset-addressed chunks, no `seq`), `terminal_event` (§6.7.3 vocabulary with daemon-minted `cmd_<ULID>` ids and measured `duration_ms`), and `terminal_status` frames; feeds the broadcast channel awaits correlate against
- `terminal/repl_registry.rs` — conservative REPL prompt registry (product policy) injected into stem's `ModeMachine`
- `terminal/shims.rs` — shell-integration shims (design D6b): zsh `ZDOTDIR`, bash `--rcfile`, fish/other passthrough, `BUD_NO_SHELL_INTEGRATION=1` opt-out

The former tmux adapter, `TerminalBackend` trait, capture/delta heuristics,
readiness detectors, and fake backend were deleted with the `0.2` contract.

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
  +--> local_llm.rs
  |
  +--> terminal/mod.rs
         |
         +--> terminal/manager.rs
         +--> terminal/session_task.rs
         +--> terminal/repl_registry.rs
         +--> terminal/shims.rs
         |
         v
       stem (workspace member crate: registry -> `bud term-hold` holders,
             Session events, emulator, key encoding)
```

## Terminal Runtime Responsibilities

- maintain per-session stem attachments (holder ensure, attach/replay,
  event pump, detection window) and interpret inbound `terminal_*` frames
- translate stem facts (OSC 133 lifecycle, modes, settling, output offsets)
  onto the proto `0.3` wire vocabulary — no readiness/confidence guessing
- own product policy layered above stem: REPL prompt registry, shell
  integration shims, sentinel exit-code fallback, history caps, grid-diff
  delta baselines

## Tests

High-value local tests now live next to the extracted abstractions:

- `config.rs`
  - effective base-dir/local/cwd path derivation and explicit override precedence
- `version.rs`
  - version output includes build metadata and version flags are detected
- `app.rs`
  - WebSocket session shutdown does not wait for stale cloned transport senders
- `protocol.rs`
  - inbound protocol validation (0.3 terminal frames; 0.2 refused)
  - deserialization coverage for every inbound 0.3 terminal frame (resume offset, await modes, retired-vocabulary rejection)
  - shape tests for every outbound 0.3 builder (output/event/status/send-result/observe-result, retired-field absence)
- `proto_wire.rs`
  - protobuf compatibility envelope fixture encode/decode
  - terminal frames round-trip as `frame_json` under typed payload slots; `terminal_event` via `legacy_json`
  - inbound field-level decode tolerance (`terminal_send.await`, `terminal_ensure.resume_from_offset`, `terminal_observe.lines`)
- `doctor.rs`
  - production TLS skip/probe behavior and command/path quoting helpers
  - terminal-registry check paths (create-with-0700, mode-drift warning, non-directory rejection) and the 0700 mode rule
  - holder-smoke skip when terminal support is disabled
  - supervision-directive parsing (launchd `AbandonProcessGroup`, systemd `KillMode`) and bud-named service-file discovery
- `proxy/mod.rs`
  - localhost proxy-open policy validation
  - transport-disconnect cleanup resets waiting HTTP proxy streams and closes active WebSocket proxy sessions
- `files/mod.rs`
  - workspace file-open policy and range selection
  - transport-disconnect cleanup resets waiting file streams
- `local_llm.rs`
  - loopback-only ds4 origin normalization
  - local LLM open-frame method/path/server policy
  - request-header allowlist behavior
  - request-body byte cap, idle timeout, response-credit idle timeout, and
    single-stream concurrency behavior
- `transport.rs`
  - gRPC data-channel terminal-output routing and control fallback
- `journal.rs`
  - journal round-trip and corrupt/missing tolerance
- `terminal/manager.rs`
  - grid-diff delta semantics, session env defaults/overrides, sentinel trailer shape
- `terminal/session_task.rs`
  - output chunking with preserved offsets, command ULID/duration minting, finish-without-start omission, child-exit → closed status, event vocabulary mapping
- `terminal/repl_registry.rs`
  - REPL prompt matches and conservative non-matches
- `terminal/shims.rs`
  - zsh/bash shim file generation; fish/unknown passthrough
- `tests/term_hold.rs` (integration, single-binary re-exec: daemonized `bud term-hold` spawn/reuse/kill through `stem::registry`)
- `tests/terminal_stem.rs` (integration, real `bud term-hold` holders)
  - ensure→ready status, sentinel exit codes 0/1 on `/bin/sh`, observe/resize, close-kills-holder, offset-exact reattach without duplicates or gaps, two-session non-blocking concurrency (D-H1), zsh/bash shim OSC 133 marker flows
- `tests/doctor.rs` (integration, real binary via `CARGO_BIN_EXE_bud`)
  - `bud doctor --format json` on a fresh base dir reports `terminal_registry`, `holder_smoke` (real `bud term-hold` spawn/probe/kill), and `supervision_directives` ok; registry created at `<base>/term` with mode 0700

## Dependencies

External crates (from `Cargo.toml`):

| Crate | Purpose |
|-------|---------|
| `stem` (workspace member) | Native terminal session manager: holder registry/spawn, `Session` attach/events, emulator, key encoding |
| `tokio` | Async runtime with process, fs, sync features |
| `tokio-tungstenite` | WebSocket client, configured with native Rustls roots so local mkcert CAs trusted by the OS work for HTTPS parity dev |
| `tonic` / `tonic-prost` / `prost` | gRPC control/data clients and generated protobuf message support |
| `tokio-stream` | Adapts control/data stream outbound channels for tonic |
| `clap` | CLI argument parsing |
| `serde` / `serde_json` | JSON serialization |
| `nix` | Unix utilities for the legacy run executor |
| `anyhow` | Error handling |
| `base64` | Data encoding for frames |
| `hmac` / `sha2` | Authentication |
| `reqwest` | Device-auth bootstrap HTTP client, no-redirect localhost proxy/local LLM requests, ds4 model probes, and bounded `bud doctor` production TLS trust checks; configured with native Rustls roots so local mkcert CAs trusted by the OS work for HTTPS parity dev |
| `qrcodegen` | Terminal QR rendering |
| `tracing` / `tracing-subscriber` | Logging |
| `ulid` | Message ID generation |
| `chrono` | Timestamp formatting |
| `shellexpand` | Path tilde expansion |

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- stem API gaps worked around in the terminal runtime (tracked for a stem follow-up): `Session` exposes neither `integration()` nor ring stats (the manager opens an extra `HolderClient` for `stat`), and `mark_no_integration()` / `mark_sentinel_integration()` swallow their resulting ModeChange (the daemon re-emits `mode_changed` itself).
- The legacy queued `run` path is intentionally retained as reference functionality, not as the primary runtime model, so ownership is deliberately light until a future capability expansion needs it.
- Device-auth bootstrap still depends on outbound HTTPS from the daemon; there is no offline/local fallback beyond presenting the claim URL and QR code.

---

*Referenced by: [bud.spec.md](../bud.spec.md)*
