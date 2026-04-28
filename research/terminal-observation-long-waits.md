# Research: Terminal Observation Long Waits

**Date:** 2026-04-28
**Status:** Promoted to implementation plan; Phases 1-4 implemented
**Scope:** Bud daemon terminal runtime plus service agent/runtime terminal tools
**Implementation Plan:** [../plan/improve-observe/implementation-spec.md](../plan/improve-observe/implementation-spec.md)

## Implementation Outcome

The core rollout shipped through [../plan/improve-observe/implementation-spec.md](../plan/improve-observe/implementation-spec.md):

- `wait_for: "settled"` now receives a service-owned one-hour timeout budget for both `terminal.send` and `terminal.observe`.
- model-facing terminal tool schemas no longer advertise arbitrary `timeout_ms`; legacy model-supplied values are ignored by normal agent execution.
- Bud starts settled `terminal_send` quiescence/readiness sampling after dispatch plus a short guard, while preserving the pre-send-to-final delta baseline so command echo can remain visible.
- settled readiness is evidence-based: weak quiet captures no longer become high-confidence ready solely because output is quiet.
- terminal interrupt is now a thread-scoped service route that sends `key: "ctrl+c"` through the normal `terminal_send` path and rejects older pending waits as `interrupted`.
- `/agent/state.pending_tool` includes `started_at` so clients can display elapsed time during long pending waits.

Remaining follow-up work is Phase 5 wait-mode cleanup: reducing or clarifying the public model-facing `wait_for` option set while preserving compatibility for older payloads.

## Question

The agent often drives long-running TUIs such as Codex, Claude Code, and REPLs. The desired behavior is:

1. `terminal.send` dispatches input.
2. Bud keeps waiting while the terminal is visibly active.
3. Bud returns one useful result only after the terminal settles, or after a large upper bound such as one hour.
4. `terminal.observe` can perform the same long wait when explicitly needed.

The current behavior still tends to produce a 30-second send or observe boundary, followed by repeated `terminal.observe` calls. A concrete failure mode is a `terminal.send` result whose delta is only the echoed command line, yet readiness says `ready: true`, `confidence: 0.85`, and `trigger: "settled"`.

## Related Prior Work

- [../design/terminal-send-settled-by-default.md](../design/terminal-send-settled-by-default.md)
- [../design/terminal-delta-observation-and-minimal-tool-payloads.md](../design/terminal-delta-observation-and-minimal-tool-payloads.md)
- [../review/terminal-send-result-flow-review.md](../review/terminal-send-result-flow-review.md)
- [../debug/terminal-send-settled-default-refactor.md](../debug/terminal-send-settled-default-refactor.md)
- [../debug/terminal-send-observe-context-quality.md](../debug/terminal-send-observe-context-quality.md)

## Current Implementation Map

Daemon:

- [../bud/src/terminal/interaction.rs](../bud/src/terminal/interaction.rs) owns `terminal_send`.
- [../bud/src/terminal/observe.rs](../bud/src/terminal/observe.rs) owns `terminal_observe`.
- [../bud/src/terminal/readiness.rs](../bud/src/terminal/readiness.rs) owns screen waits, output quiescence, and readiness assessments.
- [../bud/src/terminal/delta.rs](../bud/src/terminal/delta.rs) owns additive delta extraction.
- [../bud/src/terminal/tmux.rs](../bud/src/terminal/tmux.rs) owns tmux `pipe-pane`, output watching, and `capture-pane`.

Service:

- [../service/src/runtime/terminal/request-dispatcher.ts](../service/src/runtime/terminal/request-dispatcher.ts) owns pending send/observe promises and local timeouts.
- [../service/src/agent/terminal-tool-executor.ts](../service/src/agent/terminal-tool-executor.ts) maps model tool calls to runtime send/observe calls.
- [../service/src/agent/model-runner.ts](../service/src/agent/model-runner.ts) advertises model-facing tool schemas and timeout descriptions.
- [../service/src/agent/conversation-loader.ts](../service/src/agent/conversation-loader.ts) provides the system prompt guidance.

## What Works Today

The settled-by-default design is partially implemented:

- Service `sendInteraction(...)` defaults `waitFor` to `"settled"`.
- Daemon `handle_send(...)` also defaults `wait_for` to `"settled"`.
- Daemon `handle_observe(...)` supports `wait_for: "settled"`.
- `settled` waits use `wait_for_output_quiescence(...)`, which watches the per-session output offset maintained by the `pipe-pane` watcher.
- `capture-pane` is used at the edges: once for a pre-send baseline and once for the final rendered screen.
- `terminal.send` stores the final delivered capture, and default `terminal.observe` can use that delivered capture as its delta baseline.

That matches the broad architecture from the settled-by-default plan.

## Findings

### 1. The effective default wait budget is still 30 seconds

The model-facing schema, service executor, service dispatcher, and daemon all default send/observe wait budgets to `30000ms` / `30_000ms` when no explicit `timeout_ms` is provided.

Relevant current defaults:

- `TerminalToolExecutor.executeDirective(...)`: `directive.timeoutMs ?? 30000`
- `TerminalRequestDispatcher.observeTerminal(...)`: `timeoutMs = 30000`, local timeout `timeoutMs + 1000`
- `TerminalRequestDispatcher.sendInteraction(...)`: `options.timeoutMs ?? 30000`, local timeout `timeoutMs + 1000`
- `TerminalManager::handle_send(...)`: `frame.timeout_ms.unwrap_or(30_000)`
- `TerminalManager::handle_observe(...)`: `frame.timeout_ms.unwrap_or(30_000)`

So the "simple fix" of a longer observe only works if the default passed through service and daemon actually changes, or if the model reliably supplies `timeout_ms` itself. Today the default path remains 30 seconds.

### 2. The quiescence timeout is an absolute wall-clock timeout

`wait_for_output_quiescence(...)` returns `timeout` once elapsed time reaches `timeout_ms`, even if output was continuously arriving during the wait. Activity updates `quiet_for_ms`, but it does not extend the overall deadline.

That means current behavior is:

- wait until output is quiet for the short quiet window, or
- stop at the fixed `timeout_ms`

It is not:

- keep waiting indefinitely while output continues changing, up to a large hard cap

For TUIs that stream progress for more than 30 seconds, increasing the timeout to around one hour is the shortest path to the desired behavior.

### 3. Quiet output is being treated as ready, even without a prompt

`build_quiescence_assessment(...)` currently marks every settled quiescence result as:

- `ready: true`
- confidence at least `0.85`
- `may_still_be_processing: false`

This happens even when the final capture does not look like a shell prompt, confirmation prompt, password prompt, pager, or REPL prompt.

That explains the observed payload where the delta is only:

```text
adam@Adams-MacBook-Pro-2 bud-mobile % codex "What is the latest file in the plan/ directory?"
```

The terminal went byte-quiet after the command echo, so Bud called it `"settled"`. The readiness override then turned that byte-quiet state into high-confidence readiness, even though `looks_like_prompt` was false and there was no evidence that Codex had actually finished.

This is likely the highest-value correctness fix. Byte quiescence should mean "screen/output is currently quiet"; it should not automatically mean "the foreground program is done and ready for the next instruction."

### 4. `terminal.send` delta should keep command echo, but quiescence should start post-dispatch

`handle_send(...)` captures `baseline_capture` before it sends text or keys. The returned delta is built from:

```text
pre-send capture -> final post-wait capture
```

That means the echoed command line is a legitimate part of the model-facing delta, and we should keep that behavior. The sample `delta.changed: true` is consistent with the desired delta contract.

The issue is the quiescence/readiness window, not the model-facing delta baseline. For `terminal.send`, quiescence should be measured from after the backend has finished sending the text/key gesture, with a small guard delay, roughly `30ms`, so tmux echo/input effects have a chance to reach `pipe-pane` and the output watcher.

The user-facing failure mode comes from the combination of:

- baseline captured before dispatch,
- output quiescence/readiness beginning too close to send dispatch,
- readiness forced to high-confidence ready,
- no distinction between "input echo changed" and "program produced a result."

The target is not to hide the echo from the model. The target is to avoid treating a short quiet period around the echo as sufficient proof that the foreground TUI has finished.

### 5. `terminal.observe` already has a delivered-capture delta mechanism

`handle_observe(...)` uses `get_delivered_capture(session_id, start_line)` for `view: "delta"`, and both send and observe store delivered captures after returning. This is the mechanism that prevents follow-up observes from replaying the same full pane content.

That means the missing piece is not a total absence of delta state. The missing piece is that send can deliver a weak or misleading first capture, and the 30-second budget causes subsequent observes to return before long-running TUIs have truly completed.

### 6. Service-side output observation is diagnostic only

`TerminalRequestDispatcher.noteOutputObserved(...)` records that output arrived while an observe is pending, and logs offset deltas. It does not extend the local observe timeout or resolve the request itself.

This is fine if Bud owns the wait, but it means the service has no independent activity-extending wait policy today. The service promise must be sized to outlive Bud's intended wait.

## Interpretation

The current implementation is closer to the ideal architecture than the symptom suggests. `terminal.send` already has a built-in observe-like wait, and `terminal.observe(wait_for:"settled")` already uses the same output-quiescence path.

The remaining problem is more specific:

- The default timeout budget is too small for long-running TUIs.
- The timeout is absolute rather than "continue while activity is happening."
- Quiescence readiness is too optimistic.
- The first send delta can be dominated by shell echo before the foreground TUI has produced meaningful output.

## Candidate Fixes

### Option A: Simple settled timeout increase

Change the default timeout to around one hour when `wait_for` is `"settled"`.

Required touch points:

- `TerminalToolExecutor` defaults for send and observe settled waits
- `TerminalRequestDispatcher.observeTerminal(...)` and `sendInteraction(...)` settled defaults
- daemon `handle_send(...)` and `handle_observe(...)` settled fallback defaults
- model schema descriptions
- system prompt guidance
- `docs/proto.md` and specs

Benefit:

- The agent can issue one long settled wait instead of many 30-second observes.
- The same policy can collapse common TUI `terminal.send` plus immediate observe chains into one `terminal.send`.

Limits:

- Does not fix optimistic readiness.
- Does not help commands that intentionally produce no output unless the agent chooses a different `wait_for` mode or falls back to send plus observe.

### Option B: Increase both send and observe defaults

Change `terminal.send` and `terminal.observe` settled waits to a larger default such as one hour. This is the preferred interpretation of Option A: the one-hour budget is tied to `wait_for: "settled"`, not to every terminal request.

Benefit:

- Collapses the common send-then-observe chain into one model-visible `terminal.send` for TUIs that keep emitting bytes while working.

Risks:

- Agent turns can remain in `tool_running` for up to one hour.
- Browser/mobile clients need to present live terminal progress from SSE while the tool is pending.
- Cancellation and Bud-offline rejection become more important, though the current dispatcher already has cancellation/offline rejection paths.
- Provider request lifetime is not the main blocker because the model call has already finished before the tool executes.

Limits:

- Still returns early if the terminal goes quiet while the foreground program is logically still working.
- Still over-reports readiness if quiescence is treated as high-confidence ready.

### Option C: Activity-extending wait with a hard cap

Keep a large hard cap, but treat terminal activity as progress. Conceptually:

- `settle_quiet_ms`: the short quiet window that defines settled
- `inactivity_timeout_ms`: optional timeout after no output for a suspiciously long interval
- `hard_timeout_ms`: maximum allowed wait, e.g. one hour

This better matches the product language: "while the TUI is running, printing bytes, changing display, keep waiting."

Implementation likely belongs in `wait_for_output_quiescence(...)`, because Bud already has `last_output_at`, `last_output_seq`, and `offset`.

### Option D: Fix readiness semantics for quiet-but-not-prompt states

Do not force `ready: true` just because output became quiet. Instead:

- Use prompt/confirmation/password/pager detection when present.
- If no prompt-like state is detected and the latest settled capture only provides weak evidence, return lower confidence and `may_still_be_processing: true`.
- Keep `trigger: "settled"` to report the wait condition, but decouple it from "safe to proceed."

This is probably required regardless of timeout strategy.

### Option E: Start quiescence after send-key effects can appear

Preserve the model-facing delta as pre-send to final-capture. Do not strip command echo from `delta.text`.

For the quiescence/readiness wait, however, introduce a post-dispatch activity baseline:

- dispatch literal text and/or key
- wait a small fixed guard, for example `30ms`
- sample the current output offset / last-output timestamp after that guard
- start the quiescence stable-sample logic from that post-dispatch point

The daemon already records `dispatch_completed_at` immediately after `dispatch_interaction_to_backend(...)`, but it should be validated and likely strengthened with a short guard so the first stable checks are not racing tmux echo and the output watcher.

This keeps command echo visible to the model while making the readiness assessment less likely to settle on the send gesture itself.

## Recommended Near-Term Path

1. Make `wait_for:"settled"` use a service-owned one-hour budget for both `terminal.send` and `terminal.observe`.
2. Simplify the model contract so the agent thinks in terms of `wait_for: "settled"` rather than choosing arbitrary `timeout_ms` values.
3. Change quiescence readiness so quiet output does not automatically mean high-confidence ready. Preserve `trigger: "settled"`, but derive `ready`, `confidence`, and `may_still_be_processing` from the captured screen.
4. Move or validate the `terminal.send` quiescence baseline so stable checks start after send-key dispatch plus a small guard delay, while preserving the pre-send-to-final model-facing delta.
5. Add a regression case for the Codex-style command echo:
   - send `codex "..."`,
   - first capture contains only the shell prompt plus echoed command,
   - expected readiness is not high-confidence ready,
   - expected delta may include the echoed command,
   - expected settled readiness should not authorize a final answer solely from that echo.

## Product Decisions From Follow-Up

- One hour should apply when `wait_for` is `"settled"` for both `terminal.send` and `terminal.observe`.
- The agent should not independently choose arbitrary `timeout_ms` values. The model-facing contract should stay closer to selecting `wait_for: "settled"`, with service-owned timeout policy underneath.
- Mobile should likely show the live terminal while the tool is pending, with an interrupt affordance that sends `ctrl+c` and returns control back to the agent.
- Commands that intentionally produce no output are acceptable edge cases. The agent can choose a different `wait_for` mode or fall back to send plus observe for those workflows.

## Bottom Line

The fastest useful fix is to make settled waits use the one-hour product budget, but the better product behavior needs two additional changes:

- apply that settled budget to `terminal.send` too, so the model does not need an immediate follow-up observe;
- start send quiescence after send-key dispatch plus a small guard while preserving command echo in the returned delta;
- stop treating byte quiescence as high-confidence readiness when the capture only shows weak evidence such as an echoed command or another non-prompt quiet state.

The model-facing delta baseline should remain pre-send to final-capture. The quiescence/readiness baseline should be post-dispatch, because fixing readiness timing is what prevents the agent from believing an echoed command is a completed TUI result.
