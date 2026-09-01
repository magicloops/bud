# Plan: terminal.send misroute into inline TUIs (codex endgame) — fix package

## Context
- Debug note: [debug/terminal-send-codex-endgame-misclassification.md](../debug/terminal-send-codex-endgame-misclassification.md)
- Related specs: `bud/src/terminal/terminal.spec.md`, `bud/stem/stem.spec.md`,
  `service/src/agent/agent.spec.md`, `docs/proto.md` §6.7.4

## Root cause (revised during implementation review)
The original debug note blamed a stray OSC 133 marker clearing
`open_command`. Full code review points at **reattach amnesia** instead:

- `SessionFacts.open_command`, `open_command_screen`, and `genuine_osc133`
  are **attachment-local** (`manager.rs attach()` seeds them `None`/`false`).
- stem's ring replay restores the emulator and stem's own `open_command`
  slot, but replayed events below `resume_from_offset` are **suppressed** —
  the pump never sees the historical `command_started`, so the facts stay
  empty.
- Any reattach mid-TUI (service deploy → WS reconnect → re-ensure; daemon
  restart; `entry_or_attach` after transport loss) therefore leaves
  `mode: shell` (replay-derived) + `open_command: None` + `genuine_osc133:
  false` → `await:"auto"` resolves `command`, the text gets the sentinel
  trailer, and the await waits for a `command_finished` codex can never emit.
- The state is sticky: codex emits no markers, so nothing ever repopulates
  the facts. (The prediction gate's own comment assumes "inline raw TUIs
  like codex all live under open_command" — this is that assumption
  breaking.)
- Separately, launching a TUI from a **sentinel** shell never sets
  `open_command` at all (no `C` marker), so the same misroute exists there
  from the first gesture.

## Objective
The agent must be able to keep driving (and interrupt) an inline TUI across
daemon reattaches, and misrouted sends must fail fast with screen proof
instead of burning the 2-minute budget blind.

## Changes

### A1 — service: DB open command ⇒ explicit `await:"settled"`
`executeSend` resolves the session's open command from `terminal_command`
rows (which survive reattaches) before dispatch; when one is open it sends
`await:"settled"` explicitly instead of `"auto"`. Safe on stale rows:
sentinel commands only ever get complete rows (inserted at `D`), so a
stale-open row implies a genuine-OSC133 shell — where settled awaits still
resolve on `command_finished` with real exit codes. **Fleet-wide on deploy;
fixes the incident for every daemon version.**

### A2 — daemon: attach-time fact seeding from replay
stem exposes `open_command()` / `saw_real_markers()` (A/B/C markers seen,
bare sentinel `D`s excluded); `attach()` seeds `SessionFacts.open_command`
(fresh ULID, screen baseline `None` = painted) and `genuine_osc133` from
them. Covers reattaches whose launch markers are still in the 8 MiB ring.

### A3 — daemon: `interactive_foreground` fact
A `BracketedPasteChanged{enabled:true}` with **no open command** and no
command/prompt boundary in the last second means the foreground program
itself enabled `?2004` (shells keep it off while a command runs; readline's
prompt re-enable follows `D`/`prompt_ready` within ms and is suppressed by
the recency window). Sets `SessionFacts.interactive_foreground`; cleared by
`prompt_ready` / `command_started` / `command_finished` / close.
`await:"auto"` treats it as "not at a prompt". Covers sentinel-shell TUI
launches and marker-less recoveries.

### B — daemon: fast `input_absorbed` for sentinel command-awaits
`await_outcome` currently arms `input_absorbed` only for genuine-OSC133
shells. Extend: a sentinel command-await that reaches `settled` /
`prompt_ready` while bracketed paste is **currently enabled** (a running
shell command would have it off) arms the same `INPUT_ABSORBED_GRACE`
candidate. A misrouted send then resolves in ~2–3 s with the absorbed
delta proof instead of the 2-minute budget. `command_finished` (the real
sentinel `D`) still wins if it arrives.

### E — daemon: decision instrumentation
- `handle_send`: one info line per send with the auto-resolution inputs
  (mode, open_command, interactive_foreground, genuine_osc133, submit) and
  the resolved await.
- `attach`: info line for seeded facts (A2).
- pump: info when `interactive_foreground` flips.

### F — service: screen proof on `still_running`
`buildSendTimeoutResult`'s command branch attaches a capped `view:"screen"`
observation (same courtesy the non-command branch already has), so a
2-minute burn is never blind.

### C — service: interrupt guidance in the tool description
`terminal_send` description: interrupts/exits go through `key` gestures
(`ctrl+c`) or the program's own quit command — typed text goes to the
foreground program, not the shell.

## Spec files to update
- [x] `bud/src/terminal/terminal.spec.md` (auto resolution inputs, seeding, B, E)
- [x] `bud/stem/stem.spec.md` (new `Session` accessors, `saw_real_markers`)
- [x] `service/src/agent/agent.spec.md` (A1, F, C)
- [x] `docs/proto.md` §6.7.4 + changelog
- [x] `debug/terminal-send-codex-endgame-misclassification.md` (root-cause update)

## Impacted contracts
- [ ] WSS protocol — **no frame shape changes**; `await:"settled"` is an
  existing value, `input_absorbed` an existing outcome. §4.7: new service +
  old daemon = A1/F/C effective immediately; old service + new daemon =
  A2/A3/B degrade to today's behavior (existing events only).
- [ ] SSE events — none
- [ ] DB schema — none
- [x] Agent tools — description text only (C)
- [ ] Web UI — none

## Test plan
- stem unit: `saw_real_markers` set by A/C, not by bare `D`; `open_command()`
  restored across replay.
- daemon unit: auto-resolution helper (pure fn) across the fact matrix;
  pump `interactive_foreground` set/clear/suppression.
- daemon integration (existing suite still green).
- service unit: open DB command ⇒ `await:"settled"`; still-running result
  carries `output`; existing executor tests green.

## Rollout
- Service ships on merge (A1/F/C effective fleet-wide).
- Daemon changes ride the next release + `bud upgrade` (A2/A3/B/E).

## Status: IMPLEMENTED (2026-08-31, uncommitted)
All of A1/A2/A3/B/C/E/F landed in the working tree. Verification:
- stem unit: 96 pass (incl. `real_markers_tracked_and_bare_d_excluded`,
  `open_command_slot_tracks_c_and_d`)
- daemon unit: 119 pass (incl. `auto_await_resolution_matrix`);
  `tests/terminal_stem.rs` integration: 30 pass; clippy + rustfmt clean
- service: executor tests 36 pass (open-command test updated to expect the
  explicit `settled` override; new still-running-screen test),
  tool-definition-dependent tests 22 pass, `tsc --noEmit` clean
Residual gap (documented, monitored via E's logs): a reattach whose ring
evicted the launch markers AND has no durable command row is only bounded
by B/F, not prevented.
