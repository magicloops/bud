# Plan: `terminal.wait` — event-driven waiting instead of observe polling

## Context
- Debug note: [debug/terminal-agent-observe-polling-loop.md](../debug/terminal-agent-observe-polling-loop.md)
- Related spec files: `bud/stem/stem.spec.md`, `bud/src/terminal/terminal.spec.md`,
  `service/src/agent/agent.spec.md`, `service/src/runtime/runtime.spec.md`,
  `service/src/runtime/terminal/terminal.spec.md`, `web/src/routes/$budId/budId.spec.md`,
  `web/src/components/workbench/workbench.spec.md`, `web/src/components/message-renderers/tools/tools.spec.md`
- Precedent: `ask_user_questions` already parks a turn on an in-process waiter,
  exposes `phase: waiting_for_user`, and is superseded by a follow-up message.
  This plan reuses that shape with the terminal as the wake source.

## Objective
The agent must be able to wait for a busy terminal (Codex/TUI, REPL, long
script) with **one tool call per wake**, not a `terminal.observe` spin loop.
Acceptance:
1. `terminal.wait` blocks (service-owned budget, long) until the daemon reports
   the requested fact — `settled` / `command_finished` / `prompt_ready` /
   child exit — or the user supersedes/cancels; returns the delta observed
   since the model last looked.
2. A wait on an already-quiet terminal returns immediately (no hang).
3. `/agent/state.phase` is `waiting_for_terminal` while parked; a follow-up
   user message supersedes the wait and starts a fresh turn (same contract as
   `ask_user_questions`).
4. A gesture that produces no screen reaction still settles (`terminal.send`
   no longer rides the 2-minute budget for a no-op); a `terminal.run` whose
   text is absorbed by a foreground program returns `input_absorbed` instead
   of waiting for a `command_finished` that cannot come.
5. Observe/wait output is capped; the prompt tells the model to wait, not poll.

## Design

### Daemon (stem + manager) — proto 0.3 additive
- **Arm settle at dispatch** (`stem::Session`): every programmatic write
  (`write_text` / `paste_text` / `send_key`) sets `settled_pending` +
  `input_pending` and wakes the event loop to arm the quiet deadline. At the
  quiet point `Settled` is emitted when `mode != Shell || open_command ||
  input_pending` — an at-prompt shell still never settles *spontaneously*,
  but a gesture at the prompt (e.g. `submit:false` compose, an ignored key)
  now yields a settle instead of silence. `Session::is_quiet()` exposes
  `!settled_pending`.
- **`terminal_observe { await?: "settled"|"command", quiet_ms? }`** →
  `terminal_observe_result` gains `outcome {event, data}`:
  - `settled`: subscribe, then if `is_quiet()` resolve immediately
    (`outcome.data.immediate: true`); else resolve on `Settled` /
    `PromptReady` / `CommandFinished` / `Closed`. Optional `quiet_ms >
    QUIET_MS` adds an output-quiet confirmation (ring offset unchanged for
    the extra window, else keep waiting) so a REPL/script pause does not
    wake the model early.
  - `command`: no open command → `outcome {event:"idle"}` immediately; else
    resolve on `CommandFinished` / `PromptReady` / `Closed`.
  - Snapshot is taken **after** the wait; the session lock is never held
    while waiting. 4 h safety cap → `error: "TIMEOUT"` as for sends.
- **`await:"command"` input_absorbed**: when the session has genuine OSC 133
  markers (so `command_started` is expected), a `Settled`/`PromptReady` with
  no `command_started` since dispatch starts a short grace
  (`INPUT_ABSORBED_GRACE`); if no `command_started` arrives, resolve with
  `outcome {event:"input_absorbed"}`. Sentinel sessions are excluded (they
  have no start marker until `D`).

### Service
- Dispatcher: `ObserveOptions.await/quietMs`; awaited observes get
  `TERMINAL_WAIT_TIMEOUT_MS` (30 min) instead of 30 s; `ObserveResult.outcome`
  threaded from both gateways. **Amendment (2026-08-27):** the "no protobuf
  change" assumption held only for daemon→service results (`frame_json`);
  service→daemon requests are typed field-level, so `TerminalObserve` gained
  `await = 7` / `quiet_ms = 8` in `proto/bud/v1/bud.proto`,
  `service/src/proto/wire.ts`, and `bud/src/proto_wire.rs` (found live:
  the codec silently dropped the fields and the wait degraded to a
  snapshot; both sides now have roundtrip regression tests).
- New model tool `terminal_wait { until?: "settled" | "command_finished" }`
  (default by session state: open command → `command_finished`, else
  `settled`; service `quiet_ms: 2000` for settled waits). Result
  `kind:"wait"` with `outcome`, `waited_ms`, delta `output`, facts,
  `open_command`; budget expiry → `outcome:"timeout"` + "call again" note;
  `interrupted` / `superseded` mapped from rejected pending requests.
- `terminal.run` maps the `input_absorbed` outcome to
  `status:"input_absorbed"` with guidance.
- Runtime phase `waiting_for_terminal` (pending `terminal.wait`);
  `AgentService.supersedePendingTerminalWaitForFollowUp` rejects the pending
  wait with `superseded_by_user_message`, the flow records the tool result,
  emits `final {reason:"superseded_by_user_message"}`, and the message route
  awaits finalization before starting the new turn (mirrors questions).
- Context hygiene: observe/wait output tail-capped at 32 KiB (`truncated`).
- Prompt: still-running / interactive / send-timeout guidance now says
  `terminal.wait`; observe is for looking, not waiting.

### Web
- `phase` union + `WorkbenchStatus` gain `waiting_for_terminal` ("Waiting on
  terminal" label; composer stays enabled, Stop available); `terminal.wait`
  tool renderer (dashed badge like observe).

### Risks / mitigations
- Early wake on programs that pause >300 ms → `quiet_ms` confirmation window.
- Spurious `input_absorbed` from a slow shell → grace window + OSC 133-only.
- Long pending turns: user can supersede (chat) or cancel at any time; the
  daemon safety cap bounds leaks.
- Restart during a wait: the run fails as today for any pending tool (not
  re-armed) — follow-up.

## Spec Files to Update
- [x] `bud/stem/stem.spec.md`
- [x] `bud/src/terminal/terminal.spec.md`
- [x] `service/src/agent/agent.spec.md` (+ fix one-hour / max-steps drift)
- [x] `service/src/runtime/runtime.spec.md` (+ remove `wait_for` mentions)
- [x] `service/src/runtime/terminal/terminal.spec.md`
- [x] `service/src/terminal/terminal.spec.md`
- [x] `web/src/routes/$budId/budId.spec.md`, `web/src/components/workbench/workbench.spec.md`,
      `web/src/components/message-renderers/tools/tools.spec.md`, `web/src/lib/lib.spec.md`,
      `web/src/features/threads/threads.spec.md`

## Impacted Contracts
- [x] WSS protocol — `docs/proto.md` §6.1 (`terminal_observe.await/quiet_ms`,
      `await:"command"` → `input_absorbed`), §6.5, §6.6 (`outcome`), §6.7, §12
- [x] SSE events — `agent.tool_call name:"terminal.wait"`, `/agent/state.phase:
      "waiting_for_terminal"` (§3.2, §7.1)
- [ ] DB schema — none
- [x] Agent tools — `terminal_wait`
- [x] Web UI — status/phase, tool renderer

## Test Plan
- stem: no-reaction gesture settles; compose at prompt settles; `is_quiet`.
- daemon integration (`bud/tests/terminal_stem.rs`): observe-await immediate
  on quiet; observe-await resolves on command finish; `input_absorbed` for
  text typed into a foreground `cat`.
- service: dispatcher (await frame shape, long budget, outcome), executor
  (wait settled / idle / timeout / superseded / interrupted, run
  input_absorbed, output cap), runtime-state phase, model-runner schema
  vocabulary, agent-service supersede, contracts args.
- web: type-check + existing route tests.

## Rollout
- Daemon and service are independently deployable: an old daemon ignores
  `await` on observe (returns a plain snapshot with no `outcome`); the
  executor treats a missing outcome as `settled` immediately and notes it.
  An old service never sends `await`.
- Mobile handoff note (reference/, untracked) for the new phase/tool name.
