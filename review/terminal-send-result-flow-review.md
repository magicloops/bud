# Review: `terminal.send` Result-Flow Options

**Reviewed:** 2026-04-15
**Scope:** Current model -> service -> Bud -> `terminal.send` / `terminal.observe` flow
**Question:** How can Bud reduce extra observe turns and LLM work while still letting long-running work return control?

## Summary

The current architecture is fundamentally synchronous:

1. the model calls `terminal.send`
2. the service forwards one `terminal_send` request to Bud
3. Bud decides how long to wait
4. Bud returns one `terminal_send_result`
5. only then does the model regain control

The simplest way to improve this flow is not to make the model predict categories better. The simplest way is to make `terminal.send` itself smarter by default:

- dispatch input
- wait locally on Bud until the screen appears **settled**
- return a single result if that happens within a generous timeout
- otherwise return a timeout result with the latest delta so the model can either wait longer or intervene

That keeps the agent mostly synchronous for now, collapses most send+observe chains into one tool call, and leaves long-running async job orchestration for a later phase.

## Current Architecture

### End-to-end flow

1. `AgentService.executeTerminalCall(...)` in `service/src/agent/agent-service.ts` treats `terminal.send` as a blocking tool call.
2. `TerminalSessionManager.sendInteraction(...)` in `service/src/runtime/terminal-session-manager.ts` sends one `terminal_send` frame over `/ws` and waits on a `pendingSends` promise keyed by `request_id`.
3. `BudConnection` in `service/src/ws/gateway.ts` only resolves that promise when a matching `terminal_send_result` comes back from Bud.
4. `TerminalManager::handle_send(...)` in `bud/src/main.rs` captures a baseline, dispatches tmux input, performs the requested wait locally, captures screen state, and sends a single result frame.
5. The service persists a tool message, feeds that tool result back into the model, and the loop continues.

### Where the wait lives today

Bud currently owns the wait policy:

- `wait_for: "none"` still sleeps for `observe_after_ms` and then captures once
- `wait_for: "shell_ready"` waits for shell quiescence / prompt detection
- `wait_for: "changed"` waits until the screen differs from the baseline
- `wait_for: "settled"` waits until the screen has been quiet for a short window

Important current defaults from `docs/proto.md` and the implementation:

- `terminal.send` defaults to `wait_for: "none"`
- `observe_after_ms` defaults to `1000`
- `timeout_ms` defaults to `5000`

That means even the "fast" path usually costs about one second before the tool returns.

### What the service does not do today

The service does not currently:

- interleave other agent work while a send is pending
- consume `terminal_output` events to finish a pending tool call
- hide follow-up `terminal.observe` calls behind a single model-visible tool result
- queue a later agent wake-up when a long-running job finishes

The last item is the future async-notification direction, but that is explicitly out of scope for this review.

## Findings

### 1. This is a wait-policy problem, not mainly a delta problem

The delta engine is already materially better than the old replay-heavy behavior. The remaining issue is that a single synchronous `terminal.send` has to decide between:

- waiting long enough to cover "instant shell" and "startup/TUI" cases
- returning quickly enough for long-running work

The user-facing problem is that this choice is currently exposed too early. The agent is still pushed toward choosing between wait styles instead of getting one strong default.

### 2. The current contract is still optimized for explicit wait choice

`terminal_send` currently exposes `wait_for` modes like `none`, `changed`, `settled`, and `shell_ready`.

That is useful internally, but it is not the right default contract for the model. The agent should not need to predict up front whether:

- a shell command will finish quickly
- a TUI startup will stabilize cleanly
- a job will keep running

For the common case, the right default is simpler:

- send
- wait until settled
- return once
- if timeout happens, return partial/latest state

### 3. Long-running work is still the real boundary of the current synchronous design

For long-running jobs, you want:

- a quick confirmation that the command started
- an explicit "still running" or "backgrounded" state
- model control returned promptly

The current architecture can do the quick return part, but it cannot later resume the agent automatically when the job finishes. That means long-running work will still require either:

- a later `terminal.observe`
- or a future async wake-up / callback design

That limitation is real, but it does not block improving the common synchronous path first.

### 4. The agent loop is strictly serial right now

`AgentService.runAgentFlow(...)` executes one tool call, waits for the result, records it, then calls the model again. There is no parallel tool execution path in the current loop.

That means "let the model start another task while this one keeps running" only works if the send tool returns early with an explicit state like `processing` or `backgrounded`.

## Recommended Direction

### Put the smart default inside `terminal.send`

The simplest near-term design is:

- keep `terminal.send` mostly synchronous
- make **settled** the default send behavior
- give it a larger default timeout, for example `30000ms`
- return one result when the screen settles
- on timeout, return the latest visible delta plus conservative readiness

That means the model does **not** need to predict categories like:

- "this is a short shell command"
- "this is a TUI startup"
- "this is a long-running job"

For most current Bud use cases, that is a better fit than profile selection.

### Why this matches the current system

This direction fits the current architecture well:

- Bud already owns baseline capture
- Bud already owns the local screen polling loop
- Bud already owns readiness and delta generation
- the service already expects one blocking result frame

So the main change is not architectural upheaval. The main change is to make the default wait policy smarter and longer-lived before the result is returned.

## What `terminal.send` Should Mean

The default semantics should become:

1. capture a baseline before dispatch
2. dispatch the input
3. poll locally on Bud until the screen appears settled
4. if it settles before timeout, return the resulting delta/readiness
5. if timeout is hit, return the latest delta/readiness with an explicit timeout/processing signal

This is much closer to what the model actually wants in the common case:

- "send this and wait for the result unless it seems stuck"

not:

- "choose the perfect wait mode ahead of time"

## Why This Helps The Three Real Cases

### Fast shell commands

Most quick shell commands will:

- redraw quickly
- return to a prompt
- then stay stable

A settled-first default should usually capture that in one tool call without requiring a follow-up observe.

### TUI startup and interactive processing

Most TUIs Bud cares about will:

- visibly change while starting or processing
- then settle once a result, prompt, menu, or confirmation state is ready

That also fits a settled-first default well.

### Long-running jobs

Long-running jobs remain the exception:

- if they do not settle before timeout, Bud returns the latest delta and a timeout/processing assessment
- the model can then decide whether to wait longer with `terminal.observe`, interrupt, or change course

That is acceptable for now because the goal of this pass is to make the common synchronous path work better, not to solve async orchestration fully.

## Implementation Shape

### 1. Default `terminal.send` to settled

The model-facing default should shift from:

- `wait_for: "none"`
- `observe_after_ms: 1000`

to:

- implicit wait-for-settled behavior
- a send timeout closer to `30000ms`

The model should not need to specify this in normal use.

### 2. Keep the polling local to Bud

The daemon-side polling idea is correct. Bud should do the waiting locally rather than bouncing repeated observe decisions over the WebSocket.

That avoids:

- extra WS chatter
- extra tool calls
- extra LLM turns

This is the key benefit of solving the problem in the daemon instead of after multiple agent invocations.

### 3. Use stronger settle detection than a single unchanged comparison

Directionally, using more than two captures to confirm stability is sensible. The current implementation already has:

- immediate-start polling
- a `100ms` poll interval
- a short quiet window

If false positives remain a problem, the safest refinement is not ultra-fast polling like `1ms` / `5ms` / `10ms`. `tmux capture-pane` is a real process call and that cadence is likely too aggressive.

A more realistic refinement would be:

- poll every `50-100ms`
- require `3` consecutive unchanged captures
- also require a minimum quiet window such as `300-500ms`

That reduces accidental early settles without making the daemon excessively expensive.

### 4. Return timeout results as partial progress, not failure

When send times out, Bud should still return:

- the latest additive delta from the pre-send baseline
- readiness with `trigger: "timeout"`
- `may_still_be_processing: true`

That gives the model one useful decision point:

- wait longer with `terminal.observe`
- or intervene

This is much better than forcing multiple observe polls to learn the same thing incrementally.

## Role Of `terminal.observe`

`terminal.observe` should become the advanced waiting tool, not the normal immediate follow-up after send.

Recommended use:

- longer waits than the default send timeout
- explicit follow-up after timeout
- future async or "check back later" workflows

It should also support:

- `wait_for: "settled"`
- a longer timeout budget than `terminal.send`

So the normal flow becomes:

1. `terminal.send`
2. if it settled, continue
3. if it timed out, optionally `terminal.observe(wait_for:"settled")`

That collapses the current repeated send-observe-observe pattern into either:

- one send call
- or one send plus one advanced observe

## Tradeoffs And Limits

### 1. "Settled" is still heuristic

Because Bud is driving a live tmux session rather than a wrapped shell subprocess, it still cannot authoritatively know exit status the way direct command execution could.

So "settled" should be understood as:

- the terminal appears visually stable

not:

- the shell command definitely exited successfully

That limitation already exists today. This proposal just makes the default behavior better aligned with what the model wants.

### 2. Some jobs will falsely settle

A script that prints output in bursts with pauses can still look settled temporarily.

Mitigations:

- prompt detection when available
- multi-sample stability checks
- conservative timeout assessments
- explicit long-wait observe for advanced cases

This does not eliminate the problem, but it keeps it manageable without exposing more complexity to the model.

### 3. Long-running async work is still future work

This proposal does **not** solve:

- background jobs that should notify the model later
- multiple concurrent async tasks
- agent wake-up when a job finishes hours later

That is still a later design phase.

## Recommendation

### Near-term recommendation

Adopt a **settled-first synchronous default**:

1. make `terminal.send` wait until settled by default
2. move the default timeout closer to `30s`
3. keep the polling and settle logic entirely Bud-side
4. return latest delta on timeout instead of making the model repeatedly poll
5. reserve `terminal.observe(wait_for:"settled")` for longer or more advanced waits

### What not to do yet

Do not make the model choose among multiple send profiles as the normal path.

That would reintroduce the exact kind of foresight burden that this change is trying to remove.

If internal classification or override paths are ever added later, they should stay internal first and only become model-facing if the default settled path proves insufficient.

## Suggested Implementation Order

1. Change `terminal.send` defaults to settled + longer timeout.
2. Strengthen the Bud-side settle heuristic with multi-sample confirmation if needed.
3. Make timeout results explicitly return latest delta + processing readiness.
4. Align `terminal.observe` around the same settled wait model with larger budgets.
5. Revisit async job orchestration only after the synchronous default is working well.

## Bottom Line

The common case should not require the model to predict the future.

For now, the best fit is:

- **`terminal.send` means "send this and wait until it settles"`**
- **timeouts return partial/latest state**
- **`terminal.observe` is the longer-wait escape hatch**

That preserves the current synchronous architecture, removes most immediate observe churn, and postpones true async job orchestration until it is actually needed.
