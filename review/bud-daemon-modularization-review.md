# Review: Bud Daemon Modularization And Backend Decoupling

**Reviewed:** 2026-04-16
**Scope:** `bud/` daemon architecture, with emphasis on terminal/runtime modularization, contract stability, and reducing direct tmux coupling

## Executive Summary

The main problem is not just that `bud/src/main.rs` is large. The deeper issue is that the daemon currently has no durable internal boundary between:

- Bud's wire-level contract with the service
- terminal/session orchestration
- tmux-specific transport details
- readiness and observation policy
- device auth / identity bootstrap

That makes every new terminal feature expensive because nearly every change crosses multiple concerns at once.

The good news is that the current behavior is already coherent enough to refactor in place. Bud already has a service-facing terminal contract centered on:

- session lifecycle (`terminal_ensure`, `terminal_close`, resize)
- interaction (`terminal_input`, `terminal_send`)
- explicit observation (`terminal_observe`)
- streamed output (`terminal_output`)
- readiness assessment (`terminal_ready`, readiness in send/observe results)

Those are the right long-lived primitives. The thing that should become swappable is the implementation underneath them.

## Highest-Value Findings

### 1. `TerminalManager` is simultaneously protocol handler, session registry, tmux adapter, output tailer, observe engine, and readiness engine

This is the primary refactorability problem.

Evidence in `bud/src/main.rs`:

- protocol handlers: `handle_ensure`, `handle_input`, `handle_resize`, `handle_close`, `handle_send`, `handle_observe` (`1025-1918`)
- tmux input/capture helpers: `send_literal_text`, `send_tmux_key`, `send_interaction_key`, `run_capture_pane_with_lines` (`2043-2135`, `2493-2522`)
- wait/readiness engines: `wait_for_output_quiescence`, `wait_for_screen_state`, `build_quiescence_assessment` (`2314-2769`)
- session creation and pipe-pane wiring: `ensure_tmux_session`, `spawn_output_watcher` (`2839-3058`)

Impact:

- every feature ends up editing one giant type
- behavior-preserving refactors are risky because orchestration and transport are mixed
- adding non-tmux backends would currently require rewriting the manager, not just swapping an implementation

### 2. The service-facing terminal contract already leaks tmux details

Bud's external behavior is not yet backend-neutral.

Concrete tmux leakage in the daemon:

- `terminal_status.info.tmux_session` is emitted from `send_status` (`2773-2812`)
- hello capabilities advertise `terminal_backends` and `tmux_version` directly (`4115-4128`)
- key handling accepts tmux-native chord notation such as `C-c` (`939-967`, `2075-2135`)
- session creation, dispatch, capture, resize, and close are all expressed directly as tmux CLI operations (`1147-1168`, `1249-1263`, `1283-1285`, `2048-2069`, `2510-2518`, `2864-2926`)

Implication:

- the current protocol is not just "terminal-like"; it is partially "tmux-shaped"
- if you later add a home-built PTY or mosh-like backend, you either preserve tmux-isms forever or do a protocol cleanup at the same time

Recommendation:

- keep the current wire contract stable in the first refactor pass
- define a backend-neutral internal API immediately
- treat tmux-specific fields as legacy compatibility surfaces and isolate them behind a translation layer

### 3. Bud currently has multiple competing "truths" about terminal state

The daemon reasons about a terminal through at least three different mechanisms:

- streamed byte output from `pipe-pane` + log file tailing (`2993-3058`)
- rendered screen snapshots from `capture-pane` (`2493-2539`)
- prompt/readiness heuristics built from log tails or captures (`3067-3556`)

This is directionally fine, but the implementation is fragmented:

- `ReadinessDetector` tails log output (`3067-3330`)
- `ActivityDetector` polls `capture-pane` hashes (`3365-3556`)
- `wait_for_output_quiescence` uses watcher-maintained offsets and timestamps (`2314-2416`)
- `wait_for_screen_state` re-runs capture loops with separate timing semantics (`2543-2769`)
- `handle_send` and `handle_observe` each assemble their own baseline / wait / capture / delta flow (`1305-1548`, `1551-1840`)

Impact:

- "settled" does not live in one place
- readiness semantics are hard to reason about globally
- adding another backend means re-deriving how byte activity and screen state are produced

Recommendation:

- make "output activity", "screen snapshot", and "input dispatch" explicit backend capabilities
- keep delta computation and readiness heuristics above the backend layer

### 4. The legacy run path is structurally separate from the terminal model, but not clearly owned

`RunExecutor` is a standalone subsystem with different semantics from the terminal session path:

- queued shell commands over stdout/stderr pipes (`389-610`)
- no actual PTY despite `supports_pty: true` capability and `use_pty` request field (`188-207`, `4115-4128`)
- `timeout_ms`, cancellation state, and `use_pty` are present but not implemented (`188-231`)

Impact:

- Bud exposes two execution mental models:
  - queued one-shot shell runs
  - persistent interactive terminal sessions
- only one of them is getting active design attention
- the abandoned pieces increase cognitive load and capability ambiguity

Recommendation:

- isolate `run` as a clearly separate module immediately
- decide explicitly whether it is:
  - a legacy compatibility subsystem to keep stable but contained, or
  - a path to retire in favor of terminal-only interaction

### 5. Connection lifecycle, auth bootstrap, and runtime dispatch are overly coupled in `BudApp`

`BudApp` currently owns:

- config/materialized paths (`3655-3685`)
- device identity loading/persistence (`4035-4069`)
- browser-mediated device claim (`4166-4285`)
- handshake and HMAC proof (`3753-3869`, `4289-4294`)
- websocket writer lifecycle, heartbeat, and dispatch loop (`3872-3968`)

This is all valid product behavior, but it means the top-level app type is orchestrating both transport and business workflows.

Recommendation:

- split into `identity`, `claim`, `ws::handshake`, and `ws::session` modules
- keep `BudApp` as a thin composition root

### 6. Test coverage is almost entirely on pure helpers, not on daemon behavior

Current tests cover helper functions and delta utilities (`4484-4674`), but there are no daemon-level tests for:

- terminal session lifecycle
- tmux command mapping
- output watcher behavior
- handshake/auth flows
- send/observe orchestration
- reconnect/session reattachment behavior

Impact:

- refactoring safely will be much harder than it needs to be
- the first module split will still feel risky until the daemon has seam-level tests

Recommendation:

- introduce backend fakes and protocol tests before or during the split
- do not wait until after a tmux abstraction exists to start testing

## Concrete Bugs And Existing Gaps

### 1. `terminal_status.info` gets overwritten and drops richer metadata

`ensure_tmux_session()` builds a rich `info` payload including `pid`, `cwd`, and `output_log_bytes` before calling `send_status()` (`2967-2989`).

But `send_status()` unconditionally replaces any existing `info` with a smaller object when a session handle exists (`2789-2808`).

Current effect:

- Bud appears to intend to send rich session metadata
- the emitted frame keeps only `tmux_session`, `cols`, and `rows`
- service-side consumers will silently lose `pid`, `cwd`, and `output_log_bytes`

This is a real correctness bug, not just debt.

### 2. `tmux pipe-pane` command construction is not shell-safe for arbitrary paths

Bud constructs the pipe command as:

```rust
let pipe_cmd = format!("cat >> {}", log_path.display());
```

and passes it to `tmux pipe-pane` (`2918-2924`).

If `BUD_TERMINAL_BASE_DIR` or an ancestor path contains spaces or shell-sensitive characters, the command can break or append to the wrong path. This should be treated as a real path-handling bug.

### 3. `terminal_input` can turn one CRLF submit into two Enter presses

`handle_input()` trims both `\r` and `\n`, then calculates `newline_count` using byte length difference (`1142-1143`).

For a trailing `\r\n`, that yields `2`, so Bud will press `Enter` twice (`1161-1169`).

The newer `terminal_send` path normalizes line endings more carefully. The older low-level input path should be brought into line or explicitly deprecated.

### 4. Incoming protocol version is parsed but never validated

`Envelope` has a `proto` field (`123-129`), but incoming frames are dispatched purely by `kind` in both the handshake path and the steady-state path (`3777-3850`, `3968-3998`).

Effect:

- Bud is version-tagged on paper
- Bud is effectively unversioned in practice for inbound traffic

That is a contract risk if the service evolves frame semantics.

### 5. `handle_close()` awaits tmux process termination while holding the terminal mutex

`handle_close()` acquires `self.inner.lock().await`, removes the session, then awaits `tmux kill-session` before releasing the lock (`1280-1294`).

This is not the end of the world, but it is an avoidable async locking hazard in a component that is already doing too much.

### 6. Session lifecycle is blurred because non-ensure paths auto-create sessions

`handle_input`, `handle_send`, and `handle_observe` all call `ensure_handle_for_session()` (`1116-1118`, `1335-1337`, `1569-1571`), and `ensure_handle_for_session()` will create a tmux session if the handle is missing (`2815-2836`).

That means "send", "observe", and even low-level input can implicitly create a session with default config.

Impact:

- lifecycle ownership is less explicit than the protocol suggests
- future non-tmux backends will inherit an already-fuzzy creation policy

### 7. Capability reporting is ahead of implementation reality

Bud currently advertises:

- `supports_pty: true`
- `sessions_backends: ["pty"]` or `["pty", "tmux"]`
- `shell_default: "/bin/bash"`

from `device_capabilities()` (`4115-4128`).

But the daemon does not currently have a general terminal PTY backend, `RunFrame.use_pty` is unused, and the actual default shell is resolved elsewhere (`3658-3671`, `4360-4374`).

This is more of a contract-honesty issue than an immediate user-visible bug, but it will matter if the service starts branching on these capabilities more aggressively.

## Recommended Internal Abstractions

The refactor should make the existing service contract the stable boundary and move tmux behind a backend-neutral runtime API.

### 1. `TerminalBackend`

Purpose:

- own backend-specific session lifecycle and I/O primitives

Suggested responsibilities:

- `ensure_session(spec) -> BackendSession`
- `close_session(session_id)`
- `resize_session(session_id, size)`
- `send(session_id, interaction)`
- `capture(session_id, snapshot_request) -> ScreenSnapshot`
- `session_metadata(session_id) -> BackendSessionMetadata`
- `subscribe_output(session_id) -> OutputSubscription`

Tmux-specific details such as session names, `pipe-pane`, and key encoding belong here.

### 2. `BackendSession` / `SessionRegistry`

Purpose:

- hold runtime-local handles and reconnect-safe state

Suggested responsibilities:

- map service `session_id` to active backend session handle
- cache output offsets / last activity / subscription tokens
- expose connection-local state such as last delivered delta baseline

This lets the higher layers stop knowing how tmux sessions are discovered or reattached.

### 3. `InteractionEngine`

Purpose:

- implement service-facing `terminal_send` semantics above the backend

Suggested responsibilities:

- baseline capture
- dispatch input
- wait according to `none` / `changed` / `settled` / `shell_ready`
- final capture
- delta construction
- result payload assembly

Today that logic is spread across `handle_send()` plus a large helper cluster. It should become its own module.

### 4. `ObservationEngine`

Purpose:

- implement `terminal_observe` behavior

Suggested responsibilities:

- view parsing (`delta` / `screen` / `history`)
- observe wait policy
- baseline lookup and delivered-capture storage
- final output encoding

This should share wait and capture abstractions with `InteractionEngine`, not duplicate them.

### 5. `ReadinessEngine`

Purpose:

- own readiness heuristics independent of tmux

Suggested inputs:

- `OutputActivitySnapshot`
- `ScreenSnapshot`
- tail text or last visible line

Suggested outputs:

- canonical readiness assessment used by:
  - low-level `terminal_ready`
  - `terminal_send_result`
  - `terminal_observe_result`

The current `ReadinessDetector`, `ActivityDetector`, quiescence wait, and screen wait code should collapse into this layer plus backend capability adapters.

### 6. `TerminalProtocolAdapter`

Purpose:

- keep service wire types separate from internal terminal APIs

Suggested responsibilities:

- parse inbound terminal frames into internal requests
- convert internal results to outbound JSON payloads
- keep tmux compatibility fields isolated

This is the right place to keep temporary legacy fields such as `tmux_session` until the protocol is cleaned up.

### 7. `IdentityStore` and `DeviceClaimClient`

Purpose:

- move device auth/bootstrap out of `BudApp`

Suggested responsibilities:

- identity load/save/clear
- installation-id lifecycle
- HTTP start/poll claim flow
- user-facing claim instructions / QR rendering

That leaves `BudApp` responsible for wiring, not policy.

## Backend-Neutral Terminal Types

These are the kinds of internal types worth standardizing before any major split:

- `TerminalSessionSpec`
  - `session_id`
  - `shell`
  - `cwd`
  - `env`
  - `size`
- `TerminalInteraction`
  - `text`
  - `submit`
  - `keys`
- `TerminalKey`
  - canonical values such as `enter`, `escape`, `tab`, `ctrl+c`, arrows, paging keys
  - tmux aliases accepted only in the tmux adapter layer
- `WaitCondition`
  - `none`
  - `changed`
  - `settled`
  - `shell_ready`
- `ScreenSnapshot`
  - `text`
  - `captured_after_ms`
  - `summary`
- `OutputActivitySnapshot`
  - `latest_offset`
  - `last_output_at`
  - `last_output_seq`
  - `output_seen`
- `TerminalReadiness`
  - current readiness payload, but internal and typed
- `TerminalDelta`
  - `changed`
  - `text`
  - `truncated`
  - internal strategy/debug metadata

These abstractions are backend-neutral enough to support:

- current tmux
- a future direct PTY backend
- a future mosh-like backend, as long as it can provide session lifecycle, input dispatch, output activity, and screen snapshots

## Suggested Module Layout

One reasonable first-pass layout:

```text
bud/src/
  main.rs
  app.rs
  config.rs
  identity.rs
  claim.rs
  ws/
    mod.rs
    protocol.rs
    handshake.rs
    session.rs
  run/
    mod.rs
    executor.rs
  terminal/
    mod.rs
    types.rs
    protocol.rs
    registry.rs
    interaction.rs
    observe.rs
    readiness.rs
    delta.rs
    output.rs
  backends/
    mod.rs
    tmux/
      mod.rs
      session.rs
      commands.rs
      keys.rs
      output.rs
```

Target end-state for `main.rs`:

- tracing setup
- CLI parse
- config load
- app bootstrap

Nothing else.

## Recommended Refactor Sequence

### Phase 1. Extract pure modules without changing behavior

- move protocol structs/envelopes out of `main.rs`
- move delta helpers and readiness helpers into `terminal/`
- move identity + installation-id helpers into `identity.rs`
- keep tmux calls where they are for now

Goal:

- reduce file size immediately
- create compile-time boundaries before changing behavior

### Phase 2. Introduce a tmux backend behind an internal trait

- create `TerminalBackend` and `TmuxBackend`
- move all `Command::new("tmux")` logic into the tmux backend
- keep `TerminalManager` as the orchestration layer temporarily

Goal:

- make tmux swappable without changing the service contract

### Phase 3. Split orchestration into interaction / observe / readiness services

- move `handle_send` flow into `InteractionEngine`
- move `handle_observe` flow into `ObservationEngine`
- move readiness heuristics into `ReadinessEngine`
- reduce `TerminalManager` to coordination + state registry

Goal:

- stop letting one type own every terminal concern

### Phase 4. Clean up protocol leakage

- define canonical internal key types
- treat tmux key notation as a compatibility alias
- decide whether `tmux_session` becomes:
  - deprecated but still emitted, or
  - replaced with a generic backend metadata field
- make capability reporting accurately reflect implemented backends

Goal:

- future PTY/mosh work no longer depends on tmux-shaped service semantics

### Phase 5. Decide the fate of the run subsystem

- either keep `run` as a clearly isolated legacy path
- or align product direction around terminal primitives and retire unused run complexity

Goal:

- remove the current ambiguous middle ground

## Testing Strategy That Should Accompany The Refactor

Before or during the split, add tests at the new seams:

- protocol parsing and result assembly
- interaction orchestration against a fake backend
- observe delta behavior against canned snapshots
- readiness assessment against canned tails/screens
- session registry behavior across reconnect/reset
- tmux backend command mapping tests

The key idea is to stop requiring real tmux for most daemon behavior tests.

## Final Recommendation

Refactor Bud around this rule:

> The service contract should describe terminal behavior. Tmux should only describe one implementation of that behavior.

Concretely:

- keep the current `terminal_*` protocol stable first
- define a backend-neutral internal runtime immediately
- isolate tmux in its own adapter layer
- split orchestration from transport
- fix the existing correctness bugs while you do the extraction

If you do that in stages, you can preserve current behavior, shrink `main.rs` quickly, and make later PTY or mosh-like exploration a contained backend exercise instead of another full-daemon rewrite.
