# Debug: `terminal.wait` hangs when Codex asks a question mid-command

## Environment
- Service + daemon at current `main` (terminal.wait shipped in #77, daemon
  with awaited observes). Codex CLI as an inline TUI (mode `shell`,
  `open_command` = the `codex` invocation itself).

## Repro Steps
1. Codex is running in the thread terminal (inline TUI; `open_command` set).
2. Agent enters a task into Codex via `terminal.send` (settled-await resolves
   normally on the post-input quiet point).
3. Almost immediately, Codex renders a QUESTION (confirmation prompt) and the
   screen goes quiet.
4. Agent calls `terminal.wait` with no `until` (or explicitly
   `until: "command_finished"`).

## Observed
- The wait parks indefinitely (user interrupted after ~30s; budget is 30
  minutes). The question sat fully rendered and quiet the whole time.
- After a manual interrupt + "continue with the question", the flow worked.

## Expected
- Once the screen has stopped changing for a meaningful duration while a
  command is still open, control should return to the calling agent so it can
  read the question and answer it. (Long waits are fine WHILE the screen is
  changing.)

## Root cause (code-confirmed, two pieces)

1. **`until` defaults to the command boundary whenever a command is open** —
   `terminal-tool-executor.ts` `executeWait`:
   `directive.until ?? (openCommandBefore ? "command_finished" : "settled")`.
   During a Codex session the open command IS `codex`, so every bare
   `terminal.wait` waits for **Codex itself to exit** — almost never what the
   model means mid-session.
2. **The daemon's command-await is blind to quiet** —
   `await_observe_outcome` (`bud/src/terminal/manager.rs`)
   `TerminalSendAwait::Command` branch resolves ONLY on `CommandFinished` /
   `PromptReady` / `Closed`. stem's `Settled` events (which DO fire
   mid-command in shell mode — the codex-hang fix from the stem cutover) are
   explicitly skipped (`Ok(_) => continue`). A settled question screen
   therefore never resolves a command-wait; nothing short of the 30-minute
   service budget returns control.

Not implicated: `INPUT_ABSORBED_GRACE` (1.5s; only the `terminal.run`
absorbed path) and the settled-wait `quiet_ms` confirmation (2s; settled
waits resolve fine on the question screen — the repro's wait was a
command-wait).

Why it "used to work": in the observe-polling era the model looked every few
seconds and saw the question within one poll; and today's `terminal.send`
settled-await also resolves on the question. Only the command-boundary wait
regressed the case.

## Approaches

### A. Stall outcome on command-waits (daemon) — recommended
The user-stated semantics, plus one refinement that protects the silent-
command case: while awaiting `command_finished`, if meaningful screen
activity HAS occurred since the wait started and the screen then stays
quiet for a long threshold D, resolve with a new outcome
`stalled { quiet_ms }` (snapshot taken after, as usual). If NO activity has
occurred at all, keep waiting — `sleep 150` / silent builds still resolve in
one wake at the real boundary.

- Implementation: the command branch already receives `PumpEvent::Settled`
  (fires 300ms after any mid-command damage). On each Settled, arm/refresh a
  stall deadline (`D - QUIET_MS`); further damage produces another Settled
  which re-arms; deadline elapse → `stalled`. No new stem work.
- D delivered per-request via the existing `terminal_observe.quiet_ms` field
  (currently settled-only), service-owned (e.g. 15–30s for
  `until:"command_finished"`).
- Service maps `stalled` → wait `outcome: "stalled"` + note: "the command is
  still running but the screen stopped changing — it is likely waiting for
  input; read the output and respond with terminal.send, or wait again."
- Cost model: a chatty-then-quiet program costs one extra wake at D; silent
  programs cost nothing; interactive questions surface in ≤D.

### B. Smarter `until` default via the interactive fact (service)
`terminal-session-manager` already ingests `interactive_started` events;
cache "open command turned interactive" in `TerminalRuntimeState` and have
`executeWait` default to `settled` when set. Fixes the bare-wait default for
TUIs launched via `terminal.run`, in-memory only (restart loses it), and
does NOT help when the model explicitly asks for `command_finished`. Good
polish, not sufficient alone. (Codex launched by the user or via
`terminal.send` never emits `interactive_started` — only run-style dispatch
does — so coverage is partial.)

### C. Prompt guidance (immediate, model-dependent)
"Inside an interactive program (open_command + mode shell, or mode tui),
wait with until:\"settled\" — until:\"command_finished\" means 'until the
program exits'." Cheap and worth doing regardless; does not protect small
models that ignore it.

### D. Unconditional prolonged-quiet resolution on command-waits
The literal reading of the request (no activity-seen gate). Rejected:
`sleep 150; echo done` is quiet for 150s and would wake the model every D
seconds — reintroducing poll-shaped provider spend for exactly the case
`terminal.wait` was built to solve. The activity gate in (A) preserves it.

## Proposed fix
A + C (one PR: daemon stall outcome + service mapping + prompt line +
tests: daemon integration "codex question" shape — open command, damage,
quiet ≥ D → `stalled`; silent command → no stall; executor mapping; prompt).
B as an optional follow-up.

## Resolution (2026-08-27): knobless wait

Went further than A on review: relying on the model to pick `until` at all
was the root fragility (the same "no foresight" principle that retired
`wait_for`), so the knob was deleted. `terminal.wait {}` now maps to one
awaited observe (`await:"settled"`, `quiet_ms: 1500`) and the daemon races
every fact: `command_finished`/`prompt_ready`/close from events, `stalled`
from a 100ms poll over quiet+UNSEEN persistence (delta vs the observe
baseline) — chosen over event-armed stall timers because an at-prompt
shell's quiet point emits no event (found as a test hang) and because
pre-question echo settles must not start the stall clock. Silent commands
never stall (nothing unseen); re-waiting after a stall holds (quiet+seen+
open) so at most one wake per quiet stretch. D = 1500ms per product
decision. Approach B became unnecessary (no default to choose).

## Spec files affected (when fixed)
- `bud/src/terminal/terminal.spec.md`, `docs/proto.md` §6.1/§6.6/§6.7
- `service/src/agent/agent.spec.md`, `service/src/runtime/terminal/terminal.spec.md`
- `reference/terminal-wait-handoff.md` (new outcome value for mobile)
