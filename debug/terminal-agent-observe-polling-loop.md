# Debug: agent spin-polls `terminal.observe` while a TUI/REPL/script is busy

## Environment
- Any Bud ≥ v0.1.0 (stem terminal stack, proto 0.3), service `main` as of 2026-08-26.
- Observed with Codex CLI (inline TUI, mode reads `shell` + `open_command`); the
  same shape applies to REPLs, long scripts, and anything that runs past the
  awaited-send budget.
- LLM mode: real providers (cost is real: one provider call per poll, each
  observe payload persisted and replayed into every later call).

## Repro Steps
1. In a thread, ask the agent to run a task through Codex (or any program that
   works for more than two minutes).
2. Agent launches it via `terminal.send raw_text:"codex ..."` (or `terminal.run`,
   which returns early as `status:"interactive"`).
3. Agent sends the prompt via `terminal.send`. The settled-await rides the
   **2-minute** service budget (Codex's spinner/timer never goes damage-quiet)
   and returns `send_timeout` → "still actively producing output… use
   terminal.observe".
4. Agent calls `terminal.observe` — it returns in milliseconds with a delta —
   and calls it again, and again, until Codex finishes.

## Observed
- Dozens of `terminal.observe` calls per minute, each a full provider round
  trip and each appended to the transcript in full (`transcript-writer.ts:147`
  persists `JSON.stringify(execution.payload)`; `conversation-loader.ts`
  replays every tool row verbatim on every subsequent provider call).
- No loop guard: `agentMaxSteps` defaults to **1000** (`config.ts:298`) and
  there is no repeated-tool / unchanged-delta detection or per-tool rate limit
  anywhere in `service/src`.
- `terminal.observe` output is uncapped service-side (only `terminal.run`
  output has the 64 KiB tail cap); `view:"screen"` also carries `output_ansi`.

## Expected
- One tool call should be able to *wait* for the terminal to become quiet /
  a command to finish, bounded by a service-owned budget, without sending
  input — the way `wait_for:"settled"` did in the tmux era — so a
  twenty-minute Codex run costs a handful of provider calls, not hundreds.

## What changed (tmux → stem, commit `dab3822`, PR #51)

Tmux era (proto 0.2):
- `terminal.send` and `terminal.observe` both took `wait_for ∈ none|changed|settled`
  (+ `observe_after_ms`). `terminal.observe { wait_for:"settled" }` was a real
  **no-input blocking wait** with a service budget of **one hour**
  (`TERMINAL_SETTLED_WAIT_TIMEOUT_MS = 60*60*1000`).
- Settling was file-size polling (50 ms samples, 3 stable, ≥150 ms quiet) plus
  capture-pane hashing for TUIs, wrapped in a `{ready, confidence, trigger,
  hints}` readiness blob the model was taught to branch on.
- Prompt: "Use wait_for:"settled" with terminal.observe when you explicitly
  want to keep waiting longer after a timeout or ambiguous result."

Stem era (proto 0.3):
- Settling became event-driven and honest: stem runs a single sliding 300 ms
  damage-quiet timer (`QUIET_MS = 300`, `manager.rs:46`; `session.rs:692-770`)
  over cursor-filtered emulator damage and emits a typed `settled {mode,
  quiet_ms}` fact (in tui/repl/unknown, or in shell while a command is open —
  the inline-TUI fix). No confidence scores. **This part is better and
  should stay.**
- The daemon's await machinery is intact: `await_outcome`
  (`manager.rs:976-1042`) resolves `await:"settled"` on `settled` /
  `command_finished` / `prompt_ready`, `await:"command"` on `command_finished`
  / `interactive_started`; 4 h internal safety cap.
- What was deleted: `wait_for` / `timeout_ms` / `observe_after_ms` left the
  wire **and** the tool schemas. `terminal_observe` is now a pure snapshot
  (`handle_observe`, `manager.rs:714-802`) — no wait at all. The only way to
  enter a wait is to send input (`terminal_send` rejects `empty_interaction`).
- The "codex incident" (2026-08-18, `plan/native-terminal-session-manager/validation-checklist.md`):
  a `terminal.run` typed into Codex's chat box and hung a turn for the old
  one-hour budget. Fixes were correct — daemon busy guard (`command_in_flight`),
  `open_command` on every result, `interactive_started` early resolve — **and**
  the awaited-send budget was cut to 2 minutes
  (`request-dispatcher.ts:56`). The hang was caused by waiting for the wrong
  reason, not by waiting long; the busy guard fixed the reason, but the long
  wait was removed anyway and nothing bounded replaced it.
- Prompt today (`default-system-prompt.md:75,159,168,176,179`): don't end the
  turn while things run; don't re-run; don't `terminal.run` while
  `open_command` is set (this also removes `sleep N` as an improvised timer —
  the daemon refuses it); "check on it with terminal.observe". Nothing says
  how long to wait or what to do when the delta is unchanged. The only
  executable strategy that satisfies all of that is a spin loop.

Net: the model went from one blocking wait with a bad bound to **zero**
model-callable waits. The 2-minute budget is not addressable by the model —
it cannot ask for it, extend it, or invoke it without also typing.

## Correction: what actually hung in the codex incident

The incident (2026-08-18) happened under the **stem** daemon during native
session-manager validation — the service still carried the tmux-era one-hour
budget, but the daemon was already stem. The agent's `terminal.run` maps to
`await:"command"`; the text was echoed into Codex's chat box, the screen went
damage-quiet, and stem emitted `settled` — which `await_outcome` **ignores for
command-awaits** (`manager.rs:976-1042`: command mode resolves only on
`command_finished` / `interactive_started`). So the daemon had the fact that
"nothing further is happening" and discarded it; the hour was just how long
it took for that to surface.

The tmux-era quiescence wait would *not* have hung on this: with no new
output it measured quiet from `started_at` (`dab3822^:readiness.rs:216-221`)
and returned `settled` after ~150 ms / 3 stable samples. This was not a tmux
limitation.

The busy guard closed that specific door (a run-style send is refused while a
command is open). But the underlying rule — *if nothing further happens after
my input, that is settled* — is still missing in two places today:

1. **`await:"settled"` with a gesture that produces no damage** (ignored key,
   program busy and not echoing, script reading stdin silently):
   `settled_pending` is only armed by damage (`session.rs:713-717`), so no
   output → no `settled` → the await rides the full 2-minute budget → the
   model gets `SEND_TIMEOUT_NOTE` claiming "the program is still actively
   producing output", which is the opposite of what happened. No regression
   test covers a no-reaction gesture in `manager.rs` or `session.rs`.
2. **`await:"command"` still ignores `settled`.** Safe only while
   `open_command` tracking is right; the bash-3.2 SIGINT gap
   (`terminal.spec.md` SPEC:TODO: no `D`/`A` after interrupt) is exactly the
   case where a command-await can ride the budget with a quiet screen.

### Fix implied by this (daemon, small — complements approach A)
- **Arm the quiet timer at dispatch**: the gesture itself counts as activity
  (`settled_pending = true; deadline = now + quiet` when the send is written),
  so a no-reaction gesture settles in ~`QUIET_MS` and returns a
  `changed:false` proof. Optionally use a longer no-reaction window (1–2 s)
  and mark the outcome `reacted:false` so the model knows the input may be
  buffered rather than accepted.
- **Command-awaits resolve on settle-without-`command_started`** as a
  distinct outcome (e.g. `input_absorbed`) instead of waiting for a
  `command_finished` that cannot come. Belt-and-braces with the busy guard.
- Fix `SEND_TIMEOUT_NOTE` to not assert activity it cannot know; the daemon
  can report whether any damage occurred during the wait.

This fixes "nothing happened after my input". It does **not** fix "Codex is
working for twenty minutes": while working, Codex animates, so it is
correctly *not* settled, and the send-await correctly rides the budget. That
case still needs a model-callable long wait (A) or async wake-up (B).

## Hypotheses (root cause)
- Primary: no no-input, bounded wait primitive in the tool surface. Confirmed
  by code reading above.
- Secondary (cost amplifier): observe results are persisted in full and
  replayed forever; no unchanged-delta short circuit.
- Not the cause: the 300 ms quiet threshold. For Codex the animation *is* the
  busy indicator — damage-quiet correctly means "prompt is back". For a
  program that pauses >300 ms mid-work, `settled` fires early; that is a
  separate, smaller tuning question (per-mode `quiet_ms`).

## Proposed approaches

### A. Model-callable bounded wait (recommended first)
Add a wait to `terminal.observe` (or a sibling `terminal.wait`):
`wait: "settled" | "command_finished" | "change"`, no timeout param
(service owns the budget). Service implementation needs **no wire change**:
`terminal-session-manager.ts:501` already receives the daemon's push
`settled` events (and `command_finished`, `prompt_ready`, `interactive_started`,
`child_exited`) and currently drops `settled`; a wait subscribes to that
stream and resolves on the requested fact, then returns the normal observe
payload plus `outcome`. Budget: long (5–10 min), because the busy guard now
makes long waits safe; on expiry return `status:"still_running"` /
`still_busy` with "call again to keep waiting". Cost model: one provider call
per budget window instead of per RTT.
- Daemon-side option (small proto 0.3 additive change): `terminal_observe.await`
  reusing `await_outcome`, plus an optional `quiet_ms` so the service can ask
  for a longer quiet window in tui/unknown modes. Not required for v1.
- Prompt: replace "use terminal.observe to watch progress" with "use
  terminal.observe wait:"settled" to wait for it; observe without wait only
  to look".
- Tests: `model-runner.test.ts` asserts no retired vocabulary in schemas —
  `wait` is new vocabulary, not `wait_for`; update the assertion deliberately.

### B. Async wake-up (the deferred long-term design)
Tool returns immediately with `status:"waiting"`, the run suspends in a
durable "waiting on terminal fact" state, and the runtime resumes it when the
session emits `settled`/`command_finished`/`prompt_ready`/`child_exited`.
Zero provider cost while waiting, no pending turn, user can chat meanwhile.
Changes the turn lifecycle (run states, SSE, cancel, UI) — deferred four
times already (`plan/terminal-send-refactor/…spec.md:90`,
`plan/improve-observe/…spec.md:64`). Do A first; B can reuse A's subscription.

### C. Cheap context hygiene (complementary to A)
- Unchanged delta → tiny result (`changed:false`, no grid text).
- Cap `terminal.observe` output like `terminal.run` (tail-keeping), and drop
  `output_ansi` from the model-facing payload (it exists for the web).
- Optional: collapse consecutive observe rows on load (keep latest only)
  — riskier for prompt caching; measure first.

### D. Runtime loop guard (safety net, not a fix)
After N consecutive observes with `changed:false` (or no meaningful change),
inject an append-only runtime note ("nothing changed for 40 s; wait with
`terminal.observe wait:"settled"`") or auto-upgrade the next observe to a
wait. Cheap; protects against small models ignoring guidance.

### E. Plain `wait { seconds }` tool
Simplest possible; still one provider call per wake and fixed sleeps. Only
worth it as a stopgap if A slips.

## Spec drift found on the way (fix alongside)
- `service/src/agent/agent.spec.md:216,324,329` still say "one-hour awaited-send
  budget"; real value is 2 minutes (`request-dispatcher.ts:56`).
- `agent.spec.md:799` says max steps 30; `config.ts:298` default is 1000.
- `service/src/runtime/runtime.spec.md:32,107` still describe `pending_tool.args`
  carrying the effective `wait_for` mode.

## Resolution addendum (2026-08-27, live drill)

The first live drill spun anyway: the service dispatched awaited observes
correctly, but `await`/`quiet_ms` were silently dropped on the wire — the
typed field-level codec (`service/src/proto/wire.ts` /
`bud/src/proto_wire.rs`) never encoded them, the daemon saw a plain observe,
returned a snapshot without `outcome`, and the executor took the
legacy-daemon fallback. Fixed by adding fields 7/8 to `TerminalObserve` on
both sides + roundtrip regression tests (`decodes_inbound_field_level_awaited_observe`,
wire.test.ts). Lesson: daemon integration tests call `handle_observe`
directly and bypass the codec; wire-shape changes need codec tests too.
Bonus find: `writeOptionalInt32` drops negative `lines` (pre-existing,
tracked in TODO.md).

## Resolution

Implemented as [plan/terminal-wait-async-wakeup.md](../plan/terminal-wait-async-wakeup.md)
(2026-08-27): `terminal.wait` (awaited `terminal_observe`, 30-minute service
budget, `waiting_for_terminal` phase, follow-up supersession), arm-at-dispatch
settling + `input_absorbed` in the daemon, 32 KiB observe/wait cap, and the
prompt rewrite (wait, don't poll). The runtime loop guard (D) was not added.

## Spec files affected (when implementing A)
- `service/src/agent/agent.spec.md`, `service/src/runtime/runtime.spec.md`
- `docs/proto.md` §6.7 (tool surface) — and §6.2 if the daemon-side `await`
  on observe is added
- `bud/src/terminal/terminal.spec.md` (daemon option only)
