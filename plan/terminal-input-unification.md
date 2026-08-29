# Plan: one terminal input tool; the daemon owns readiness and waiting

## Context
- Debug note: `debug/terminal-run-interactive-early-return.md`
  (codex launched via `terminal.run` returned at 267 ms on the
  bracketed-paste signal; the follow-up `terminal.send` typed into an
  uninitialized TUI and the text was lost).
- Related specs: `bud/src/terminal/terminal.spec.md`, `docs/proto.md`
  §6.6–6.7, `service/src/agent/agent.spec.md`,
  `debug/terminal-wait-codex-question-stall.md` (knobless wait — same
  principle: the model has no foresight, the daemon has the facts).

## Objective
- Launching an interactive program returns control only when the program
  is **ready** (has painted and gone quiet), not at its first escape
  sequence.
- Input is never typed into a program that cannot accept it yet: the
  daemon **gates** input on readiness (bounded), transparently.
- The agent has **one** way to send input; the daemon picks the wait
  (command boundary at a prompt; painted-then-quiet / stalled inside a
  program) and reports one outcome vocabulary.
- Acceptance: the codex transcript sequence (run codex → send brief →
  wait) works end to end with no agent-side timing decisions; existing
  shell `terminal.run` behavior (exit codes, durations) is unchanged.

## Design

### Phase 1 — daemon readiness + input gating (no contract change)
Definition, per open command: **painted** = at least one output byte since
the command's `output_byte_start` (store the start offset in
`SessionFacts::open_command`; `ring_next_offset` already tracks the tail);
**ready** = painted AND damage-quiet (stem `is_quiet()` / `Settled`).

1. `await:"command"` on `InteractiveStarted`: instead of resolving
   immediately, keep waiting until ready (or `command_finished` /
   `prompt_ready` / closed), capped at `INTERACTIVE_READY_CAP` (10 s).
   Resolve `interactive_started` with `data.ready: true|false` and
   `data.painted: bool` (false only when the cap expired).
2. `handle_send` input gating: when `open_command` is Some (any mode) and
   the program is not ready, wait for ready before writing, capped at
   `INPUT_READY_CAP` (10 s); then dispatch as today. Report
   `gated_ms` in the result payload. At a shell prompt (no open command)
   nothing changes.
3. No new wire fields are required by clients; the extra `data` fields on
   `interactive_started` are additive.

Risks: a program that intentionally paints nothing until input (rare;
`read` prompts print a prompt, `cat` with no args prints nothing) costs
the cap once — mitigated by the cap and by clearing gating once ANY output
arrives; TUIs that repaint continuously (spinners) never go quiet —
`is_quiet` uses damage-quiet, and the cap bounds the wait (report
`ready:false` so the agent knows).

### Phase 2 — one tool (contract change)
`terminal.send { text?: string, key?: string, submit?: boolean }` becomes
the single input tool (`terminal.run` retained one release as an alias
mapped to the same executor, then retired):
- At a shell prompt with `text`: behaves like today's `terminal.run`
  (bracketed paste + Enter, command-boundary await, real `exit_code`,
  `duration_ms`, byte-exact output). `command_in_flight` refusal is
  removed — the daemon delivers input wherever the foreground is.
- Inside a program: Phase-1 gating, then the knobless race already used by
  `terminal.wait` (`command_finished` | `prompt_ready` | ready-after-
  interactive | `stalled` 1500 ms | closed) plus the screen delta.
- One result shape (superset of run/send/wait today): `{ outcome,
  exit_code?, duration_ms?, output, changed, mode, integration,
  alt_screen, open_command, cwd? }`. `outcome` uses the wait vocabulary
  plus `command_finished`.
- `terminal.wait` and `terminal.observe` unchanged.
- System prompt: three tools → send/wait/observe; drop the run-vs-send
  classification guidance and the "interactive" special-casing.
- Renderers: web `message-renderers/tools` keyed by tool name — keep
  `terminal.run` for historical transcripts, render the unified result;
  mobile handoff doc for the new result shape.

Alternative considered — Option B: keep both tools but let `terminal.run`
deliver into an open program (settled semantics) instead of refusing.
Fewer moving parts, but leaves two names for one action; the user asked
for one.

## Spec Files to Update
- [ ] `bud/src/terminal/terminal.spec.md` (readiness, gating, caps)
- [ ] `docs/proto.md` §6.6/6.7 (+ changelog): `interactive_started`
      readiness fields, `gated_ms`, Phase-2 send semantics
- [ ] `service/src/agent/agent.spec.md`, `tool-definitions.ts`,
      `default-system-prompt.md`
- [ ] `web/src/components/message-renderers/*.spec.md` (Phase 2)
- [ ] `reference/` handoff for mobile (Phase 2 result shape)

## Impacted Contracts
- [ ] WSS protocol — additive fields only (Phase 1); Phase 2 none beyond
      removing the `command_in_flight` refusal
- [ ] SSE events — tool result payload shape (Phase 2)
- [ ] DB schema — none
- [ ] Agent tools — Phase 2 (one input tool)
- [ ] Web UI — renderers (Phase 2)

## Test Plan
- Daemon e2e (`bud/tests/terminal_stem.rs`) with a scripted "slow inline
  TUI" (python: enable bracketed paste at +0.2 s, sleep 2 s, paint a
  prompt box, then echo every submitted line): `run` resolves only after
  the paint (`ready:true`, ≥2 s); a `send` issued immediately after the
  early `interactive_started` is gated and the text arrives intact;
  cap path (`ready:false`) with a program that never paints; shell
  commands unchanged (exit codes/durations); alt-screen TUI (`less`)
  readiness.
- Service unit tests: executor mapping of the new outcomes; Phase 2
  unified executor + prompt snapshot.
- Live drill: dev stack + codex (or the scripted TUI) — run/send/wait
  sequence from the real model.

## Rollout
1. Phase 1 as v0.1.15 (daemon only; fixes the reported failure with the
   existing tools).
2. Phase 2 service + web PRs, mobile handoff; `terminal.run` alias for one
   release.
