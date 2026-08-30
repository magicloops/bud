# Design: Launch Proof and the Active-Hold Wait

**Status:** Implemented (daemon v0.1.17; service ships on merge)
**Created:** 2026-08-29
**Related:**
- [`debug/terminal-send-interactive-launch-blind-screen.md`](../debug/terminal-send-interactive-launch-blind-screen.md) (the codex trust-prompt incident)
- [`design/terminal-send-settled-by-default.md`](./terminal-send-settled-by-default.md)
- [`design/terminal-delta-observation-and-minimal-tool-payloads.md`](./terminal-delta-observation-and-minimal-tool-payloads.md)

---

## Summary

Two changes, shipped together, fixing the two halves of the codex trust-prompt
incident:

1. **Launch proof.** A `terminal.send` that launches an interactive program
   (`status:"interactive"`) attaches the settled screen delta to its result — the
   same send-plus-proof the `interaction_ack` branch already has. The agent reads
   what the program actually painted (trust prompt, login screen, update notice,
   the real input box) before typing anything into it.

2. **Active-hold wait.** `terminal.wait` holds only while the terminal is
   **changing** — a spinner, a progress bar, streaming output. The long wait
   budget (30 min) exists to cover *visible ongoing work* without polling. A
   screen that stays **visually static for ~10 seconds** cedes control back to
   the agent with a new `no_activity` outcome instead of holding. A wrong wait
   now costs seconds, not the 30-minute budget.

Together these restore the invariant the tmux-era system had implicitly (every
step returned a screen capture; the model re-read the terminal before every
decision) without giving up the stem-era facts model. The deeper prompt-guidance
rewrite and any further wait-budget tuning (options 2 and 3 in the debug doc) are
deferred until we see how these two land.

## Background

In the incident, the agent launched codex; codex painted its "trust this
directory?" selector; the launch resolved `interactive, ready:true` with **no
screen content**, so the agent pasted the task brief blind. The paste's Enter
approved the trust prompt, the brief was lost, and the agent — seeing its text
had not landed — called `terminal.wait`, which held against a completely static
screen (bounded only by the 30-minute service budget).

Root causes, verified in the debug doc:

- `interactive_started` results carry readiness facts but no screen
  (`service/src/agent/terminal-tool-executor.ts:535`), and the system prompt
  says "now ready for input — keep driving it."
- The wait's start snapshot treats *quiet + already-seen + command open* as
  "hold until new facts" (`bud/src/terminal/manager.rs:1541`). That hold was
  designed for silently-working programs, but it makes a mispredicted wait cost
  the whole budget while the terminal visibly does nothing.

**Clarified intent (this doc's contract):** the 30-minute wait budget is for a
terminal that is *changing* — codex thinking with its animated indicator, a
build streaming lines, a progress bar advancing. It was never meant to cover a
static screen. Static for ~5–10 seconds ⇒ the agent gets control back.

## Part 1 — Launch proof: delta on `status:"interactive"` results

### Change

Service-side only. In `executeSend`'s `interactive_started` branch, do exactly
what the `interaction_ack` branch does after settling
(`terminal-tool-executor.ts:575-594`): a `view:"delta"` observe, attached as
`delta: { changed, text }` plus the observe facts (`mode`, `integration`,
`altScreen`). Keep `readiness`, `note`, `openCommand`, and the gate facts as
they are.

The same attach applies to the sibling blind branches:

- `input_absorbed` — the program consumed the launch input; show what it left
  on screen.
- the `ready:false` readiness-cap result — the program had not painted; the
  delta shows whatever partial paint exists (often the clue to what is wrong).

`still_running` already has bespoke handling (still-running note + command id)
and its output is reachable through the command record; it is out of scope here.

### Why service-side, not daemon-side

The daemon has the settled screen in hand when the readiness hold resolves
(`wait_program_ready`), so putting it in `interactive_started.data` is tempting —
but it is a proto addition with no fidelity gain: by the time the service builds
the result, one delta observe returns the same screen. Service-side works with
every daemon already in the field, ships on merge with no release or capability
gate, and keeps `terminal_event` lean.

### Consequences

- The observe marks the screen as seen (`last_observed_screen`), which makes a
  follow-up wait's start snapshot consistent: the agent has provably seen this
  screen, so a static hold genuinely means "nothing new since you looked."
- Tool payloads grow by one screen delta per program launch. This is the same
  cost every `interaction_ack` already pays, capped by the existing
  `TERMINAL_OBSERVE_OUTPUT_CAP_BYTES` tail-keeping.
- Prompt: the result-shape line for `status:"interactive"` gains the factual
  addition that `delta` shows what the program painted, and one sentence of
  instruction: **read the screen before typing — freshly launched programs
  often show intermediate prompts (trust/consent/login/update) before their
  real input surface, and selector prompts are answered with keys, not pasted
  text.** The broader guidance rewrite stays deferred.

## Part 2 — Active-hold wait: static screens cede control

### Semantics

`await_observe_outcome` (`bud/src/terminal/manager.rs:1510`) gains one rule; the
rest is unchanged:

- Boundaries always win: `command_finished`, `prompt_ready`, `closed`.
- Unseen content that goes quiet for the stall window still resolves `stalled`
  (fast path, typically 1.5 s after output stops).
- Quiet + seen + nothing open still resolves `settled` immediately.
- **New:** whenever the wait is otherwise holding, a static clock runs against
  the *visible screen*. If the screen does not change for
  `WAIT_STATIC_CAP` (proposed **10 s**), the wait resolves:

  ```json
  { "event": "no_activity", "data": { "mode": "...", "static_ms": 10000 } }
  ```

  Any visible change resets the clock (and usually routes into the existing
  stalled path once it goes quiet). The clock starts at the wait's start
  snapshot, seeded with the current screen — so a wait issued against an
  already-static, already-seen screen returns in ~10 s flat.

### Static means the visible grid, not damage-quiet

The clock compares `screen_lines()` snapshots (as `await_send_settled` does),
not `is_quiet()`. Two reasons:

- A program that redraws identical content in a loop generates damage forever
  but shows the user nothing; damage-based quiet would hold the old way. Under
  grid comparison it is correctly static.
- Cursor position and blink are not grid content; an idle TUI with a blinking
  cursor is static.

Poll cadence reuses the existing 100 ms loop; one `screen_lines()` per tick is
already the cost profile of `await_send_settled`.

### Why a new outcome, not `stalled`

`stalled` means "output appeared and then stopped — read it and act," and the
prompt promises "re-waiting after a stall is free: it holds until new
activity." `no_activity` is a different fact — *nothing happened at all* — and
reusing `stalled` would both mislead the model and silently break the re-wait
contract. The new outcome gets its own note:

> Nothing happened during the wait and the screen is unchanged. The program is
> most likely idle and awaiting input — look at the screen and act. Only wait
> again if you have a concrete reason to believe it is working without
> painting anything.

The re-wait-after-stall contract survives for its intended case (a changing
program that pauses), but a re-wait against a static screen now costs ~10 s per
call rather than holding. That is the accepted trade-off: silently-working
programs that paint *nothing* (no spinner, no progress, no output) lose their
free hold. In practice they are rare — chat TUIs animate, builds stream — and
shell commands are covered by command boundaries, not wait. If a real workload
surfaces, options 2/3 from the debug doc (budget tiers, prompt guidance) are
the follow-up, informed by data.

### Choosing `WAIT_STATIC_CAP = 10s`

- Must comfortably exceed the stall window (1.5 s) and normal repaint gaps so
  a program that is merely between animation frames is not declared idle.
- Must be short enough that a mispredicted wait feels like a hiccup, not a
  hang. The user-visible symptom in the incident was "30+ seconds and
  counting"; 10 s keeps the worst case under that.
- Sits at the top of the requested 5–10 s range to give slow starters (a
  program clearing the screen and thinking before its first paint) the benefit
  of the doubt. Daemon-owned constant; the service passes nothing.

### Wire and rollout compatibility

- New daemon → current service: `TerminalEventOutcomeSchema` is tolerant
  (`event: z.string()`), but the executor's `waitOutcome` mapping defaults
  unknown events to `"settled"` — misleading for `no_activity`. The service
  change (map `no_activity`, add its note, surface `waited_ms`/`static_ms`)
  merges and auto-deploys **before** the daemon release, so this window never
  occurs in practice; dev setups running an old service against a new daemon
  degrade to `settled` + delta, which is safe.
- Old daemon → new service: never emits `no_activity`; old hold semantics
  remain until `bud upgrade`. No capability gate needed — nothing about the
  request side changes.

## Changes by component

| Component | Change |
|---|---|
| `bud/src/terminal/manager.rs` | `WAIT_STATIC_CAP`; static clock in `await_observe_outcome` (start snapshot + poll loop); `no_activity` outcome |
| `service/src/agent/terminal-tool-executor.ts` | delta observe attached to `interactive_started`, `input_absorbed`, ready:false results; `no_activity` in `TerminalWaitOutcome` mapping + `WAIT_NO_ACTIVITY_NOTE` |
| `service/src/agent/contracts.ts` | `TerminalWaitOutcome` union + `no_activity`; interactive result shape gains `delta` |
| `service/src/agent/default-system-prompt.md` | factual result-shape updates (interactive delta; wait `no_activity`); one-sentence read-before-typing instruction |
| `web/src/components/message-renderers/tools/terminal-run.tsx` | render `delta` on interactive results; `no_activity` wait outcome label |
| `docs/proto.md` | §6.1 awaited observe: static-cap rule + `no_activity`; changelog |
| Specs | `bud/src/terminal/terminal.spec.md`, `service/src/agent/agent.spec.md`, web `tools.spec.md` |

## Test plan

Daemon e2e (`bud/tests/terminal_stem.rs`):
- Launch the fake TUI, wait against its idle painted screen → `no_activity` in
  ~10 s (never the safety cap), `static_ms` reported.
- Wait while the fake TUI animates its working indicator for >10 s → holds
  through the animation, resolves `stalled` ~1.5 s after the animation stops
  (the static cap must not fire mid-animation).
- Wait over a shell command that prints then exits → `command_finished` still
  wins (boundaries beat the static clock).
- `unified_send_launching_a_tui_...`: unchanged daemon-side; launch-proof is a
  service concern.

Service unit (`terminal-tool-executor.test.ts`):
- `interactive_started` outcome → result carries `delta` from the follow-up
  observe; observe failure degrades to the existing note, result still returns.
- `input_absorbed` and ready:false results carry `delta`.
- `no_activity` outcome maps to `waitOutcome:"no_activity"` with its note;
  unknown outcomes still default to `settled`.
- Prompt vocabulary test: no retired words reintroduced.

Acceptance drill (manual, on the Ubuntu box, after `bud upgrade`):
- Fresh untrusted directory → agent launches codex → the interactive result's
  delta shows the trust prompt → agent answers it with keys → brief lands in
  the real input box.
- Agent waits while codex thinks (animated indicator) → wait holds; codex
  stops → `stalled` with the reply.
- Agent waits against idle codex → `no_activity` in ~10 s, agent acts instead
  of re-waiting.

## Rollout

1. Merge (service auto-deploys: launch proof + `no_activity` mapping live).
2. Tag v0.1.17 → release build → promote → `bud upgrade` on boxes (active-hold
   wait live).
3. Order-independent: each side degrades gracefully against the other.

## Deferred (revisit after observing these changes)

- Option 2 (debug doc): full prompt-guidance rewrite around interactive
  programs.
- Option 3: wait budget tiers (shorter first wake, etc.) — likely unnecessary
  once static screens cede in 10 s, since the 30-minute budget now only ever
  covers a visibly changing terminal.
