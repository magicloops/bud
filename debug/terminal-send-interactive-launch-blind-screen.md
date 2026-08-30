# Debug: codex trust prompt — blind interactive launch, misdirected paste, open-ended wait

## Environment
- Daemon: v0.1.16 (unified `terminal.send` with `await:"auto"`, reaction-settle from PR #93)
- Service: main @ `78337a3` (auto-deployed)
- Program under test: codex CLI, launched in a directory it had not been trusted for
- LLM mode: real (production agent run)

## Repro Steps
1. Agent thread on an upgraded box; ask the agent to use codex in a fresh (untrusted) directory.
2. Agent calls `terminal.send { text: "codex" }`.
3. Codex paints its **"Do you trust this directory?"** selector prompt (not its normal input box) and goes quiet.
4. Agent calls `terminal.send { text: "<task brief>" }`.
5. Agent calls `terminal.wait`.

## Observed
1. The launch send resolved as `status:"interactive", ready:true`. The agent then pasted the brief immediately.
2. The paste landed on the trust selector: the text was discarded (selector prompts don't accept free text) and the trailing **Enter approved the highlighted "trust this directory" option**. Codex proceeded to its main UI with an empty input box; the brief was lost.
3. The agent's send returned an `interaction_ack` whose delta showed the post-approval screen; the agent correctly noticed the brief had not been input.
4. The agent then called `terminal.wait`, which has now been holding for 30+ seconds with a completely static screen (codex idle at its input box).

## Expected
- The agent should have *seen* the trust prompt after the launch and answered it deliberately.
- The brief should only be typed once the codex input box is actually on screen.
- A wait against a static, already-seen screen with an idle TUI should not look like progress; it should either not be chosen by the agent, or come back quickly with "nothing is happening".

## Hypotheses (evaluated against the code)

### H1 — the agent never saw the trust screen: **CONFIRMED, by construction**
The `interactive_started` branch of the send executor returns readiness facts and a
canned note but **no screen content whatsoever**
(`service/src/agent/terminal-tool-executor.ts:535-554`):

```ts
return {
  kind: "command",
  status: "interactive",
  commandId, readiness: { ready, painted },
  note: ready ? INTERACTIVE_STARTED_NOTE : INTERACTIVE_NOT_READY_NOTE,
  ...gateFacts, ...sessionContextFacts, openCommand,
};
```

The daemon side is the same: `interactive_result` (`bud/src/terminal/manager.rs:1276`)
inserts only `ready`/`painted` into the outcome data, even though the readiness hold
(`wait_program_ready`, manager.rs:1247) polls the exact screen it is judging and has it
in hand when it resolves.

So the agent was not "erroneously summarizing" anything — it had nothing to summarize.
Worse, the system prompt actively instructs the blind behavior
(`service/src/agent/default-system-prompt.md`):

> `status:"interactive"`: the command launched a program that is **now ready for
> input** … Keep driving it with terminal.send

"Ready" here is the daemon fact *painted + quiet* — which the trust prompt satisfies
perfectly. Ready never meant "the input box you expect is on screen"; only the screen
itself can tell the agent that, and we withhold it.

### H2 — the paste approved the trust prompt: **CONFIRMED (consequence of H1)**
The input gate (`wait_program_ready`) admits input as soon as the program is painted +
quiet. The trust selector is painted and quiet, so the gate passed immediately, the
brief was bracketed-pasted (ignored by the selector), and the default-submit Enter
selected the highlighted option. No daemon fact can distinguish "selector awaiting a
choice" from "input box awaiting text" — this is inherently the agent's call, and it
needs the screen (H1) to make it.

### H3 — the wait was triggered by something else: **REFUTED**
`terminal.wait` is only ever dispatched as the model's own tool call
(`service/src/agent/model-runner.ts:607`). Nothing in the runtime auto-issues waits.
The model chose it — and the prompt nudged it there: after a send whose delta doesn't
show a reply, the guidance funnels toward `terminal.wait` ("a send whose delta shows
only your own input echoed … call terminal.wait"). The agent had just watched its text
fail to land, had no better guidance, and waited.

### H4 — the wait runs (near-)indefinitely on an unchanged screen: **CONFIRMED, by design**
`await_observe_outcome` (`bud/src/terminal/manager.rs:1510`) takes a start snapshot:

- quiet + **unseen** content → `stalled` immediately
- quiet + seen + nothing open → `settled` immediately
- quiet + seen + **command open → HOLD** (manager.rs:1541) until new output or a
  boundary

The agent's previous send ended with a delta observe, which set
`last_observed_screen` (manager.rs:912) — so at wait time the screen was quiet, seen,
and codex was the open command. The hold is bounded only by the service wait budget,
`TERMINAL_WAIT_TIMEOUT_MS = 30 minutes`
(`service/src/runtime/terminal/request-dispatcher.ts:65`), then the daemon's 4h leak
cap. The hold exists for a real reason (a silently-working program produces no output
until it finishes; re-waiting after a stall must be free), but its cost profile is
wrong when the model *mispredicts*: one wrong wait = a turn hostage for 30 minutes
with a visibly idle terminal.

## How the pre-stem (tmux) system handled this

Checked at `7a324fa^` (last tmux-era commit).

- **Every send was send-plus-proof, including launches.** All `terminal.send` results
  were `kind:"interaction_ack"` with `delta: result.delta` — the captured pane after
  the readiness detector settled (old `terminal-tool-executor.ts`, `executeSend`).
  Launching codex returned the trust prompt's *actual text*. The tmux-era agent
  physically could not be blind to an intermediate screen.
- **There was no long-hold wait.** The readiness/activity detectors
  (`bud/src/terminal/readiness.rs`, `interaction.rs`) always resolved with a capture;
  the agent looked, decided, acted. The "hold until new facts" wait is a stem-era
  design (a good one — it replaced confidence-score guessing) but it removed the old
  system's implicit property that *the model re-read the screen at every step*.

The stem migration kept the screen-proof invariant for the `interaction_ack` branch
(delta observe after settle) but **dropped it for the command-shaped branches**:
`interactive_started`, `input_absorbed`, and `still_running` all return facts + notes,
no screen. That's the regression relative to tmux — not the readiness model itself.

## Resolution

Fixed per [`design/terminal-launch-proof-and-active-wait.md`](../design/terminal-launch-proof-and-active-wait.md):
option 1 (launch proof: `interactive_started`/`input_absorbed` send results
attach the settled screen delta, service-side) plus the active-hold wait
(`no_activity` after the daemon's 10s static cap — the 30-minute budget only
ever covers a visibly changing terminal). Options 2 and 3 below stay deferred
pending how these land.

## Proposed Fix (outline — as evaluated at debug time)

1. **Restore the screen-proof invariant for `interactive_started`** (root fix).
   Cheapest correct version is service-side: the executor's interactive branch does
   the same post-send delta observe the `interaction_ack` branch already does
   (`terminal-tool-executor.ts:575-594`) and attaches `delta` to the result. No proto
   change, works for any daemon, and marks the screen observed so a follow-up wait's
   start snapshot is consistent. (Daemon-side alternative: put the settled screen in
   `interactive_started.data` — it's already in hand in `wait_program_ready` — but
   that's a proto addition for no extra fidelity.)
2. **Prompt: make the interactive result a screen to read, not a green light.**
   Replace "now ready for input … keep driving it" with: the result shows what the
   program painted; read it before typing — freshly launched programs often show
   intermediate prompts (trust/consent/login/update) before their real input surface,
   and selector prompts are answered with keys, not pasted text.
3. **Bound the cost of a mispredicted wait.** Options, in preference order:
   - (a) Do nothing beyond 1+2: with the screen in view the model shouldn't have
     waited at all; 30 min remains the worst case for a genuine misprediction.
   - (b) Shorten the *first* wake budget (e.g. 2–5 min) when the wait's start
     snapshot is quiet+seen+open, returning `timeout` ("nothing has happened —
     terminal unchanged; the program may be idle awaiting input") so a wrong wait
     costs minutes; re-waits keep the long budget for genuine silent work.
   - (c) A distinct early outcome (`no_activity`) from the daemon after N× the stall
     window on a static screen — same effect as (b) but a proto change; only worth it
     if we want daemon-owned wording.
   Note (b)/(c) cannot *detect* "idle TUI vs silently working program" — that's the
   same undecidable question as readiness; they only cap the price of guessing wrong.
4. **Non-goal:** daemon-side heuristics to detect selector/consent screens and block
   pastes. That's the readiness-guessing road we deliberately left; the agent with
   eyes (fix 1) is the right decision-maker.

## Spec files affected (when fixed)
- `service/src/agent/agent.spec.md` (interactive result shape, prompt guidance)
- `bud/src/terminal/terminal.spec.md` (only if 3b/3c touch daemon wait semantics)
- `docs/proto.md` (only for daemon-side variants: screen in `interactive_started`, or a new wait outcome)
