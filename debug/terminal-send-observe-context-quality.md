# Debug: terminal-send-observe-context-quality

## Environment
- OS / arch / versions: local macOS development workspace
- DB connection style: service-local development database
- LLM mode (real/mocked): real provider integration in the service harness
- Related docs:
  - [debug/terminal-observe-screen-stable-timeout.md](./terminal-observe-screen-stable-timeout.md)
  - [design/terminal-send-confirmation-and-fast-observe.md](../design/terminal-send-confirmation-and-fast-observe.md)
  - [plan/revised-terminal-contract/implementation-spec-follow-up.md](../plan/revised-terminal-contract/implementation-spec-follow-up.md)

## Repro Steps
1. Start or resume a thread-scoped terminal session that already contains Claude Code scrollback.
2. Launch Claude Code via `terminal.exec` or continue from an already-open Claude Code session.
3. Let the agent interact through the new contract:
   - `terminal.exec` to launch `claude`
   - `terminal.observe` to inspect the initial Claude screen / confirmation state
   - `terminal.send` to accept the initial confirmation
   - `terminal.send` to provide the actual prompt
   - `terminal.observe` or `terminal.send` again when Claude requests confirmation for a shell action
4. Observe the final result and the intermediate tool payloads in the chat transcript.

## Observed
- The end-to-end flow now works.
  - In the reported run, the agent successfully launched Claude Code, accepted the confirmation prompt, sent the task, accepted Claude's proposed shell command, and returned the final haiku answer.
  - This is materially better than the earlier broken state where `terminal.send` could report success while the Claude TUI remained visibly idle.
- `terminal.observe` is currently returning a full tmux capture, not just the new or changed content since the last agent-visible step.
  - The observed tool output included prior Claude transcript from the same pane before the new interaction.
  - That older content is still present in tmux scrollback and the observe path is faithfully returning it.
- `terminal.send` is returning useful transport and readiness evidence, but still not enough semantic screen context to eliminate many follow-up observes.
  - The send result included:
    - `submitted`
    - `readiness`
    - `acceptance`
    - `state`
    - a compact `observation`
  - The compact observation only included:
    - screen change flag
    - hashes
    - line count
    - one `last_non_empty_line`
    - short `preview_head` / `preview_tail`
- In the Claude example, the send result correctly told the model that the screen changed and the UI appeared settled and ready for more input, but it did not include enough post-send content for the model to fully understand what Claude was showing.
  - That pushed the model toward `terminal.observe` for additional context.
- `terminal.exec` launching `claude` still returns a command-oriented result, not a rich TUI bootstrap snapshot.
  - In the reported example, the `terminal.exec` output was minimal (`c\bclaude\n\n`) and `definitive` was `false`.
  - Under the current agent prompt, an immediate `terminal.observe` after such a launch is a rational fallback.

## Expected
- Preserve the fact that the new contract now works end-to-end with Claude Code.
- Reduce unnecessary `terminal.observe` calls when `terminal.send` already has enough evidence for the next action.
- Avoid feeding stale pane history back to the model when the agent only needs the newly changed or newly relevant content.
- Preserve a way to request the full rendered screen explicitly when that is actually needed.

## Findings

### 1. This is no longer a correctness blocker
- The current issue is not "Claude interaction is broken."
- The current issue is "the agent is paying too much context/latency cost to understand what changed."
- That distinction matters because the next fix should optimize information shape, not reopen the transport split.

### 2. `terminal.observe` is snapshot-oriented, not delta-oriented
- In Bud, `handle_observe(...)` waits and then returns the captured screen content from `tmux capture-pane`.
- When `lines` is set, Bud still returns the whole captured range for that request, not a diff against the prior observe call.
- In the service, `observeTerminal(...)` and `handleObserveResult(...)` simply relay that full output into the tool payload.
- There is currently no notion of:
  - "only new lines since the last observe"
  - "only the changed region"
  - "suppress content already shown to the agent a moment ago"

### 3. `terminal.send` is evidence-oriented but still too lossy for content understanding
- The current send contract does the right high-level thing:
  - it proves transport was attempted
  - it captures a fast post-send observation
  - it derives acceptance and next-action state from that observation
- But the returned observation is deliberately compact.
- That compact result is good for deciding whether something changed at all, but often not good enough for understanding what the TUI now wants.
- In practice, that means:
  - `terminal.send` is strong enough for control flow
  - `terminal.observe` is still needed for semantic comprehension

### 4. The current state model can describe interaction class, but not interaction content
- `processing`, `waiting_for_input`, `ready_at_shell`, and `ambiguous` are useful next-action categories.
- They do not tell the model whether the current Claude screen is:
  - a confirmation prompt with numbered options
  - a completed answer
  - a quick status update
  - a partially rendered response
- That gap is why "waiting for input" often still leads to `terminal.observe`.

### 5. Pane history reuse is confusing the model in exactly the way we would expect
- The agent sees old Claude transcript mixed with the new interaction.
- That creates two concrete risks:
  - stale instructions or conclusions may be mistaken for new state
  - the model spends context budget re-reading content it has effectively already seen
- This is especially visible when the same thread-scoped session keeps a long-lived TUI open across multiple interactions, which is exactly what Bud is designed to support.

## Current Implementation Notes
- `terminal.send` observation payload in the service is defined by `TerminalSendObservation` in `service/src/terminal/types.ts`.
- Bud builds that payload via `build_send_observation_payload(...)` in `bud/src/main.rs`.
- The current payload is intentionally compact:
  - `captured_after_ms`
  - `screen_changed`
  - `baseline_hash`
  - `current_hash`
  - `lines_captured`
  - `last_non_empty_line`
  - `preview_head`
  - `preview_tail`
- `terminal.observe`, by contrast, returns full captured output through `terminal_observe_result`.
- Bud's observe path currently uses `run_capture_pane_with_lines(...)` and returns the resulting capture directly.
- The service records that full output into the tool message for the agent.

## Hypotheses

### Hypothesis 1: We need two different observation products, not one
- One product should answer: "did anything happen and what class of state are we in now?"
- Another product should answer: "what exactly changed on screen?"
- Today:
  - `terminal.send` mostly answers the first question
  - `terminal.observe` answers the second question, but with too much historical baggage

### Hypothesis 2: The agent-facing default should skew toward novel content, not full pane replay
- For agent reasoning, "what changed since the last meaningful step?" is usually more valuable than "show me the full recent capture again."
- A full-screen capture is still useful, but it should be explicit or fallback behavior, not the default answer to every follow-up visibility question.

### Hypothesis 3: The right `terminal.send` improvement is a richer post-send excerpt, not a full embedded observe
- Returning the full screen on every `terminal.send` would likely bloat tool payloads and reintroduce a lot of repeated content.
- A better compromise is to return:
  - a larger post-send tail excerpt
  - or a changed-region excerpt
  - or both compact state plus a short semantic excerpt
- That would let the model understand many fast TUI turns without immediately paying for a separate full observe.

## Potential Improvements

### 1. Add a delta-aware observe mode
- Keep the existing full-screen observe for explicit inspection and debugging.
- Add an agent-friendly mode that returns only the novel or changed portion of the screen.
- Possible shapes:
  - `terminal.observe` with a new mode such as `view: "delta"`
  - `terminal.observe` with a `since` cursor or previous-hash reference
  - a result that includes both:
    - `output_full`
    - `output_delta`
  - or a simpler result that keeps `output` as the delta and exposes a way to request the full screen explicitly

### 2. Make `terminal.send` return a stronger post-send excerpt
- Keep the current compact observation metadata.
- Add a small semantic excerpt to the send result, such as:
  - the last 8-20 visible lines
  - the changed region relative to the baseline capture
  - the novel suffix after removing the shared prefix/suffix with the baseline
- This would let the agent understand many cases like:
  - Claude showing a confirmation prompt
  - Claude finishing a short answer and returning to idle
  - a REPL printing a quick result

### 3. Prefer "changed tail" over "last line"
- `last_non_empty_line` is useful, but it is too thin for many TUIs.
- `preview_head` / `preview_tail` are also often insufficient because two lines is a very small window.
- A modestly larger changed-tail payload would probably buy most of the benefit without needing a full observe.

### 4. Add per-session dedupe for agent-facing observation
- Maintain a previous delivered capture or hash per session, per thread, or per active agent turn.
- When a new observe result substantially overlaps with the previous capture, collapse the repeated prefix and return only the novel portion plus metadata such as:
  - `omitted_repeated_lines`
  - `shared_prefix_lines`
  - `shared_suffix_lines`
- This would preserve correctness while cutting repeated context.

### 5. Tune agent policy around "send already gave enough context"
- If a future `terminal.send` result includes:
  - `screen_changed: true`
  - a meaningful semantic excerpt
  - `state.status: "waiting_for_input"`
- then the agent should usually skip `terminal.observe` and continue directly.
- `terminal.observe` should stay the follow-up for:
  - `processing`
  - `ambiguous`
  - truncated or low-context excerpts
  - explicit full-screen inspection needs

## Risks / Constraints
- TUIs repaint entire regions, so naive line-based diffing may be noisy or misleading.
- Scrollback-based dedupe and screen-diff-based dedupe are not the same thing.
  - Scrollback suffix trimming is simple but may miss in-place screen rewrites.
  - Full screen diffing is more accurate but more complex.
- Some interactions really do need the full screen.
  - Confirmation prompts with hidden context
  - pagers
  - complex menus
  - screens where meaning depends on layout, not just tail lines
- Because of that, the likely target is:
  - better agent defaults for novel content
  - while preserving an explicit full-screen escape hatch

## Proposed Fix Direction
- Treat the current state as functionally correct but context-inefficient.
- Improve the contract in two complementary ways:

1. `terminal.send`
 - keep the fast observation and state model
 - add a richer post-send excerpt so the agent can understand many fast interactions without an extra observe

2. `terminal.observe`
 - add an agent-facing delta or changed-region mode so the model sees the new state, not a replay of recent pane history

- The likely end state is:
  - `terminal.send` answers "did something happen, what happened briefly, and what should I do next?"
  - `terminal.observe` answers "show me the new screen content I have not already seen"
  - an explicit full-screen observe remains available for debugging and complex TUI cases
