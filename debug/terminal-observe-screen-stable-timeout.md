# Debug: terminal-observe-screen-stable-timeout

## Environment
- OS / arch / versions: local macOS development workspace
- DB connection style: service-local development database
- LLM mode (real/mocked): real provider integration in the service harness
- Related docs:
  - [debug/revised-terminal-contract-cutover.md](./revised-terminal-contract-cutover.md)
  - [debug/terminal-observe-vs-capture.md](./terminal-observe-vs-capture.md)

## Repro Steps
1. Enter a simple TUI / REPL-like program such as Claude Code in the thread-scoped terminal.
2. Let the agent issue `terminal.observe` with `wait_for: "screen_stable"` and no explicit `timeout_ms`.
3. Observe the service logs:
   - request emitted at `11:08:17.583`
   - local `observe_timeout` at `11:08:22.584`
   - orphaned Bud response at `11:08:24.650`
4. In a later run, let the agent skip the explicit observe, then issue `terminal.send` with natural-language text plus `submit: true` while Claude Code is visibly idle and waiting for input.
5. Observe that:
   - the tool result reports `submitted: true`
   - readiness reports `trigger: "activity_stable"` with high confidence
   - `context_after` remains `mode: "repl", program: "claude"`
   - the visible Claude Code TUI still appears to be waiting for input and does not show evidence that the prompt was accepted
   - the assistant then incorrectly reports that Claude Code is actively working on the task

## Observed
- `AgentService.executeTerminalCall(...)` uses a default timeout of `5000ms` for `terminal.observe` when the model omits `timeout_ms`.
  - File: `service/src/agent/agent-service.ts`
- `TerminalSessionManager.observeTerminal(...)` uses that same `timeoutMs` for two separate purposes:
  - it sends `timeout_ms` to Bud
  - it also starts the local promise timeout at exactly `timeoutMs`
  - unlike `execCommand(...)` and `sendInteraction(...)`, it does **not** add any local grace window
  - File: `service/src/runtime/terminal-session-manager.ts`
- Bud handles `wait_for: "screen_stable"` by calling `resolve_readiness_after_interaction(...)`, which delegates to `wait_activity_and_capture(...)`.
  - File: `bud/src/main.rs`
- `wait_activity_and_capture(...)` currently uses hard-coded detector settings:
  - `initial_delay_ms = 2000`
  - `interval_ms = 5000`
  - `stable_count_target = 2`
- That means a fast TUI can become visually usable and effectively idle well before the detector takes its first look.
  - Example: Claude Code can paint an initial stable screen in a few hundred milliseconds.
  - The current detector still waits the full `2000ms` before its baseline capture, so that early stable state is invisible to `screen_stable`.
- That detector cannot produce a successful `"activity_stable"` result inside a `5000ms` timeout:
  - first it always waits `2000ms`
  - then it takes the first capture
  - then it sleeps another `5000ms` before the next timeout check
  - reaching `stable_count = 2` would require roughly three captures, so the happy path is closer to `~12s` than `5s`
- Even the timeout path is slower than the service-side timeout:
  - service times out at `~5.0s`
  - Bud returns at `~7.1s`
  - that matches the current detector structure: `2s` initial delay plus one `5s` sleep before the loop notices the timeout
- Once the service-side timer fires, `pendingObserves` is removed. When Bud later sends `terminal_observe_result`, `handleObserveResult(...)` logs `Orphaned observe result`.
  - File: `service/src/runtime/terminal-session-manager.ts`
- `handle_observe(...)` also performs an extra `capture-pane` after `wait_activity_and_capture(...)` returns, so the observe path captures twice:
  - once inside the readiness wait helper
  - once again for the actual returned output
  - this is not the primary timeout cause, but it adds latency and duplicates work
- In the reported Claude startup case, startup itself appears to have returned quickly enough that the current `screen_stable` wait likely over-ran the useful response window.
  - That makes the current path doubly inefficient: we miss the quick initial screen change, then still time out waiting for a stricter stability condition.
- There are now two different `screen_stable` implementations in Bud:
  - low-level `terminal_input` / `terminal_interrupt` readiness uses `ActivityDetector`
  - `terminal_send` / `terminal_observe` use `wait_activity_and_capture(...)`
  - their timing semantics are not identical
- A second failure mode is now visible on `terminal.send`:
  - the tool result can claim success even when the TUI appears unchanged and still idle
  - example payload:
    - `submitted: true`
    - `trigger: "activity_stable"`
    - `activity_checks: 3`
    - `stable_checks: 2`
    - `follow_up_hint: "Continue with terminal.send while Claude Code is active."`
- In the current implementation, `submitted: true` is only a transport-level acknowledgement.
  - In Bud, `dispatch_interaction_to_tmux(...)` returns success if the `tmux send-keys` calls exit successfully.
  - It does **not** verify that the target program displayed the text, accepted Enter, or changed state.
- In the current implementation, the tool-message summary is optimistic by construction.
  - `AgentService.summarizeInteractiveSend(...)` generates strings like `Sent "..." and pressed Enter` directly from the requested directive.
  - It does not incorporate any observed post-send evidence.
- `context_after` is also not observational.
  - `AgentService.executeTerminalCall(...)` gets `contextAfter` from `TerminalSessionManager.getSessionContext(...)`.
  - That context is derived from in-memory pending-command tracking and known-program hints, not from a fresh screen capture.
  - So `context_after: { mode: "repl", program: "claude" }` only means "we still believe Claude is active", not "Claude accepted the latest prompt".
- The current `screen_stable` success condition after `terminal.send` is compatible with "nothing happened".
  - `wait_activity_and_capture(...)` does not require any post-send screen delta before it can report `"activity_stable"`.
  - If the screen stays unchanged because input was dropped, ignored, or never reached the focused widget, the detector can still observe the same screen three times and return high-confidence stability.
- This means the result bundle currently conflates three different ideas:
  - transport submission (`tmux send-keys` exited successfully)
  - terminal context (`we believe Claude is still the active program`)
  - task acceptance (`Claude received and started acting on the request`)
  - Only the first two are currently evidenced; the third is inferred too aggressively.

## Expected
- `terminal.observe` with `wait_for: "screen_stable"` should not fail for a stable TUI under the default path.
- The service-side timeout budget and the Bud-side detector budget should represent the same wall-clock contract.
- `screen_stable` should have one consistent implementation and one consistent timeout model across `terminal_input`, `terminal_send`, and `terminal.observe`.
- `terminal.send` should not be treated as successful task handoff to a TUI unless we have some positive evidence that the screen changed or the program responded.
- Tool results and assistant narration should distinguish:
  - "input dispatch succeeded"
  - "the interactive program is still active"
  - "the interactive program appears to have accepted the request"

## Findings
1. The immediate cause of the reported failure is the `5000ms` default timeout for `terminal.observe`.
   - Under the current Bud detector, that budget is too short by design.

2. The service and Bud do not measure the timeout budget the same way.
   - Service starts counting immediately after dispatch.
   - `wait_activity_and_capture(...)` effectively adds a fixed `2000ms` pre-wait and only re-checks timeout after a full `5000ms` sleep.

3. `observeTerminal(...)` is more brittle than the new `exec` and `send` paths.
   - `execCommand(...)` and `sendInteraction(...)` both allow `timeoutMs + 10000` locally.
   - `observeTerminal(...)` does not, so it is the first path to fail when Bud is only slightly slower than the nominal timeout.

4. The current `screen_stable` settings make the `5000ms` default non-viable even for trivial, already-stable TUIs.
   - A stable screen still needs multiple spaced captures before Bud can declare `"activity_stable"`.
   - More importantly, if the TUI becomes stable before the first `2000ms` capture, that quick stability does not help at all under the current algorithm.
   - In other words, "stable quickly" currently behaves almost the same as "not yet observed".

5. The observe path currently does redundant work after the wait completes.
   - `wait_activity_and_capture(...)` already performs a final capture.
   - `handle_observe(...)` discards that output and captures again.

6. We currently lack enough visibility into what the detector is actually seeing between request start and timeout.
   - The logs show request start, timeout, and late result.
   - They do not show capture timestamps, screen hashes, line counts, last-line evolution, or whether the screen already reached a useful intermediate state well before the timeout.

7. `terminal.send` currently has a false-positive success mode.
   - `submitted: true` is weaker than it sounds.
   - It means the daemon successfully issued `tmux send-keys`, not that the TUI consumed the input.

8. `activity_stable` after `terminal.send` does not prove that the send caused any visible effect.
   - The detector accepts repeated unchanged screens as success.
   - That makes "input was ignored and the screen remained idle" look similar to "the TUI processed the request and then became idle again".

9. Agent-facing tool payloads currently overstate confidence after interactive sends.
   - `summary`, `follow_up_hint`, and `context_after` all encourage the model to assume the request landed.
   - None of those fields currently encode "screen changed after send" or "post-send observation confirms handoff".

10. The assistant’s natural-language response is therefore vulnerable to a stacked inference error.
   - tool summary says "sent ..."
   - readiness says "activity_stable"
   - context says "Claude is active"
   - model concludes "Claude is now working"
   - but the missing link is evidence that Claude accepted the actual prompt

## Hypotheses
- Primary root cause: the default observe timeout was kept at a shell-oriented `5000ms`, but `screen_stable` uses a slower activity-based detector.
- Secondary root cause: the service-local timeout and Bud detector timeout are not based on the same wall-clock semantics.
- Tertiary issue: duplicated capture work and split detector implementations make the path harder to reason about and tune.
- Timing-shape hypothesis: quick TUI startups are especially penalized because the detector ignores the first `2000ms` of screen evolution and only begins measuring stability after that blind window.
- Product follow-up hypothesis: for fast TUI responses, the right UX may not be "wait until stable" at all. A quick initial observation shortly after `terminal.send` may be more valuable than a stricter delayed stability result.
- Input-verification hypothesis: the new `terminal.send` contract proves dispatch but not acceptance.
  - We may have regressed from a workflow that implicitly inspected the screen after interactive input to one that returns an ack without a confirmation signal.
- No-op stability hypothesis: the Claude pane may be completely unchanged after the send, and the detector is rewarding that unchanged state as `"activity_stable"`.
  - If true, the bug is at least partly semantic: the readiness result is being misused as a send-success signal.
- Focus/modal-state hypothesis: `tmux send-keys` may be reaching the tmux pane, but Claude Code may not be accepting text into the input widget at that moment.
  - Examples: startup transition, modal overlay, confirmation state, or some other non-text-entry mode.
  - Under that condition, `submitted: true` would still be accurate at the tmux layer while the user-visible TUI remains idle.
- Wrong-target hypothesis: the daemon may be targeting a valid tmux session/pane, but not the exact user-visible interactive surface we assume.
  - If the session has window/pane state drift, `send-keys` success would not guarantee the visible Claude prompt changed.
- Context-staleness hypothesis: `context_after` may be stale or only partially informative.
  - Because it comes from pending-command tracking, it can remain `"claude"` even if the latest send failed or had no visible effect.
- Agent-interpretation hypothesis: even if transport behavior is correct, the current tool payload wording is too strong.
  - The model is being nudged to convert "acknowledged send into active Claude session" into "Claude is working on the task", which is not warranted.

## Logging Additions

### Service-side logging
- In `TerminalSessionManager.observeTerminal(...)`, log:
  - `session_id`, `request_id`, `wait_for`, `lines`, `timeout_ms`
  - local request start timestamp
  - local deadline timestamp
  - current `TerminalContext` (`mode`, `program`)
  - latest known readiness at dispatch time
- In the observe timeout callback, log:
  - request age in ms
  - `wait_for`, `timeout_ms`
  - current `TerminalContext`
  - latest readiness snapshot
  - `lastOffsets.get(sessionId)` and whether it changed since request start
  - whether any `terminal.output` frames were processed during the observe window
- In `handleObserveResult(...)`, log:
  - total latency from request dispatch to result receipt
  - whether the request was still pending vs already timed out
  - `output_bytes`, `lines_captured`
  - readiness trigger / confidence
  - a compact content fingerprint:
    - screen hash
    - last non-empty line
    - optional first/last 2 visible lines under debug mode

### Bud-side logging
- In `handle_observe(...)`, log:
  - `request_id`, `session_id`, `wait_for`, `lines`, `timeout_ms`
  - time spent in `resolve_readiness_after_interaction(...)`
  - time spent in final `capture-pane`
- In `resolve_readiness_after_interaction(...)`, log which branch was selected:
  - `none`
  - `shell_ready`
  - `screen_stable`
- In `wait_activity_and_capture(...)`, add debug logs for each check:
  - wall-clock elapsed ms since request start
  - detector elapsed ms since the post-delay timeout clock started
  - elapsed ms
  - check number
  - stable count
  - current screen hash
  - line count
  - last non-empty line
  - whether content changed vs previous capture
- For the final output returned from `wait_activity_and_capture(...)`, log:
  - final screen hash
  - final line count
  - last non-empty line
  - optional truncated preview under debug mode

### What we want to see
- Whether the TUI was already effectively stable before the first `2000ms` capture window.
- Whether the first capture after Claude startup already contains a useful ready screen.
- Whether the screen keeps changing meaningfully, or only small ephemeral indicators are changing.
- Whether we are timing out before the second or third capture.
- Whether the screen is effectively stable much earlier than the current detector declares it.
- For `terminal.send`, whether the screen changed at all after the send.
- Whether the first post-send capture still shows the exact same Claude idle screen.
- Whether the send path ever produces a visible intermediate state such as typed input, a submitted prompt, or a "working" indicator.
- Whether there was any output/log offset movement during the send window, or whether the pane remained entirely silent.

### Logging safety / volume
- Full screen dumps should be debug-gated and size-limited.
- Default logs should prefer hashes, line counts, and last-line previews.
- If full previews are logged, cap them to a small number of lines and bytes to avoid noisy logs and accidental secret leakage.

### Activation
- Service-side observe diagnostics should ride the existing `AGENT_DEBUG` path.
- Bud-side per-check `screen_stable` capture logs should be emitted only when `BUD_DEBUG=true`.
- One-line request/result logs can remain visible without debug mode so timeouts and late/orphaned results are still easy to spot.

## Potential Follow-Up

### `terminal.send` immediate observation
- Consider extending `terminal.send` with an optional immediate observation path for interactive launches and quick TUI responses.
- Example target behavior:
  - dispatch the send input
  - wait a short fixed delay, approximately `200ms`
  - capture a first rendered-screen snapshot
  - return that snapshot alongside the normal send acknowledgement, or emit it as an immediately linked follow-up result
- Good candidate cases:
  - starting Claude Code from shell
  - starting Python and immediately seeing the REPL prompt
  - sending a simple Python expression that returns almost instantly
  - lightweight confirmations or single-key TUI actions
- Why this helps:
  - it gives the agent immediate visibility into what the TUI became
  - it reduces reliance on a slower "screen_stable" detector for simple, fast interactions
  - it can let the agent continue with better context before a longer stability wait would finish
- Open design question:
  - should this be part of `terminal_send_result` itself, or a separate linked observation contract such as `terminal.send(..., observe_after_ms: 200)` that returns an ack plus `initial_observation`

### `terminal.send` result semantics
- Consider splitting the current single send result into separate evidence fields:
  - `submitted`: tmux transport succeeded
  - `screen_changed`: rendered screen changed after the send
  - `observed_response`: optional immediate post-send observation payload
  - `accepted_by_program`: reserved for stronger future heuristics, if we can justify them
- At minimum, avoid phrasing tool summaries as if task handoff is confirmed when we only know transport succeeded.

## Proposed Fix
- Decide on a single wall-clock contract for `wait_for: "screen_stable"` and apply it consistently in service and Bud.
- Raise the default timeout budget for `terminal.observe` when `wait_for` is `screen_stable`, or derive the timeout from the detector parameters rather than hard-coding `5000ms`.
- Give `observeTerminal(...)` the same kind of local grace window already used by `execCommand(...)` and `sendInteraction(...)`.
- Consolidate the Bud-side activity detector logic so `screen_stable` is implemented once.
- Reuse the final capture produced during readiness waiting instead of capturing twice in `handle_observe(...)`.
- Treat `terminal.send` as an acknowledgement of attempted input dispatch, not proof that the interactive program accepted the request.
- Add a post-send confirmation signal:
  - either require evidence of screen change before claiming success
  - or attach an immediate observation so the agent can verify what actually happened
- Soften agent/tool-result wording until the confirmation signal exists.
  - `Sent "..." and pressed Enter` should likely become an evidence-based direct summary such as `Send "..." and press Enter; no visible delta observed`
  - follow-up hints should not imply the task is underway unless there is observed evidence
