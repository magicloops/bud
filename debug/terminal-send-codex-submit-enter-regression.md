# Debug: terminal-send-codex-submit-enter-regression

## Environment
- Current `terminal.send` contract on the thread-terminal-boundaries branch
- Service agent tool path through `service/src/agent/agent-service.ts`
- Runtime send path through `service/src/runtime/terminal-session-manager.ts`
- Bud daemon tmux dispatch path through `bud/src/main.rs`
- Compared against two interactive TUIs:
  - Codex
  - Claude Code

## Repro Steps
1. Start Codex inside the thread-scoped terminal session.
2. Use the agent `terminal.send` tool to send text with `submit: true`.
3. Compare the visible behavior with the same style of send against Claude Code.

## Observed
- Codex and Claude Code both use the same shared structured send path:
  - `AgentService.executeTerminalCall(...)` calls `terminalSessionManager.sendInteraction(...)`.
  - `TerminalSessionManager.sendInteraction(...)` sends a `terminal_send` frame with `text`, `submit`, `keys`, and optional `observe`.
  - Bud `handle_send(...)` dispatches through `dispatch_interaction_to_tmux(...)`.
- The failing agent case was specifically `text: "hello", submit: true`.
- Bud-side instrumentation proved that this failing case was **not** sending a trailing newline inside the text payload.
  - The logged dispatch plan was:
    - `literal("hello")@text_segment`
    - `key(Enter)@submit_flag`
  - The corresponding tmux calls were:
    - `tmux send-keys -t <session> -l hello`
    - `tmux send-keys -t <session> Enter`
- There was no `\n`, `\r`, or `\r\n` in the `text` field for that failing `hello + submit` case.
- The key observation from validation was the behavior matrix:
  - `text: "hello", submit: true` -> failed, required follow-up Enter
  - `text: "hello\n", submit: false` -> failed, required follow-up Enter
  - `text: "hello\n", submit: true` -> succeeded
  - `text: "hello"` followed by a second send with `{ submit: true }` -> succeeded, but with extra latency
- That pattern strongly suggests that the issue is not "Enter is missing" or "Enter was filtered out".
- Instead, the issue appears to be the boundary between literal text injection and submit semantics:
  - one immediate `literal text -> Enter` sequence is not always sufficient for Codex
  - a second Enter works
  - a small time boundary between the text send and the Enter also works
- A temporary Bud-side delay experiment confirmed this.
  - Adding a small delay between a literal text segment and a trailing `submit_flag` Enter resolved the issue.
  - The final shipped value is currently `10ms`.
- Claude is present in `service/src/terminal/known-programs.ts`.
- Codex is not present in `service/src/terminal/known-programs.ts`.
  - That affects context quality and follow-up hints, but it did not explain the low-level transport behavior by itself.
- The current implementation uses one shared structured send path for both programs:
  - `AgentService.executeTerminalCall(...)` calls `terminalSessionManager.sendInteraction(...)`.
  - `TerminalSessionManager.sendInteraction(...)` sends a `terminal_send` frame with `text`, `submit`, `keys`, and optional `observe`.
  - Bud `handle_send(...)` dispatches through `dispatch_interaction_to_tmux(...)`.
- In Bud, `submit: true` is always translated to `tmux send-keys Enter`.
  - There is no program-specific submit behavior for Codex vs Claude.
- The current `terminal.send.keys` path is limited.
  - Bud supports `Enter`, arrows, `Tab`, `Escape`, paging/navigation keys, and single-character literals.
  - It does not currently support richer modified keys such as `Ctrl+J`, `Meta+Enter`, or other program-specific submit chords.
- The current text-plus-submit path has a concrete edge case:
  - `send_text_payload_to_tmux(...)` splits `text` on newlines.
  - If `text` already ends with `\n` and `submit: true` is also set, Bud will send Enter for the trailing newline and then another Enter for `submit`.
  - That means one logical send can become a double-Enter if callers provide both a trailing newline and `submit: true`.

## Expected
- `terminal.send({ text, submit: true })` should either:
  - submit the prompt correctly for Codex and Claude alike, or
  - fail in a way that is clearly attributable to a program-specific key requirement rather than an ambiguous transport/result gap.

## Current Implementation Review

### Shared transport
- The agent path does not go through browser xterm input handling.
- The recent browser terminal-boundary changes are therefore unlikely to be the direct cause of an agent-only `terminal.send` regression.
- The relevant shared path is:
  - `service/src/agent/agent-service.ts`
  - `service/src/runtime/terminal-session-manager.ts`
  - `bud/src/main.rs`

### Submit semantics
- `submit: true` is not an abstract "program accepted the prompt" action.
- It is specifically "Bud should press tmux `Enter` after sending text".
- That works well for shell commands and for TUIs that use bare Enter as submit.
- The validated regression suggests an additional constraint for tmux-backed TUIs:
  - even when Enter is the correct logical submit key, sending it immediately after literal text can be too aggressive for some UIs.

### Program detection
- The strongest explicit implementation difference between Codex and Claude today is not the transport itself, but program classification.
- Claude is a known interactive program with guidance and pending-command tracking support.
- Codex is not.
- That affects context quality, follow-up hints, and how confidently the service can reason about what is on screen after launch.

### Evidence quality
- `terminal_send_result.submitted` only means the tmux dispatch succeeded.
- It does not prove that the foreground TUI accepted the prompt or reacted to Enter.
- If observation is omitted or yields no useful delta, a Codex no-op can still look like a generic submit failure.

## Findings
1. The main "Enter is being filtered out" hypothesis was not supported.
   - Bud was sending a distinct `Enter` key event after the literal text.
   - The validated failing case did not contain a trailing newline in the `text` payload.

2. The main "we accidentally embedded `\n` inside the failing `hello + submit` payload" hypothesis was also not supported.
   - The exact Bud-side dispatch log for that case showed:
     - `contains_cr=false`
     - `contains_lf=false`
     - `literal("hello")`
     - then `Enter`

3. The strongest validated explanation is now a timing/boundary issue between text injection and submit.
   - `tmux send-keys -l hello` followed immediately by `tmux send-keys Enter` was not reliably sufficient for Codex.
   - A second Enter worked.
   - A separate follow-up submit worked.
   - A small delay before the trailing submit Enter also worked.

4. The issue therefore appears to be about how the foreground TUI interprets the first Enter when it arrives too close to literal text injection.
   - The most plausible interpretation is that the TUI has not yet fully incorporated the injected text into the state where Enter means "submit".
   - Under that condition, the first Enter behaves more like "insert newline into the composer" than "submit prompt".

5. The current fix is a small Bud-side boundary, not a different key encoding.
   - Bud now inserts a `10ms` delay before a `submit_flag` Enter that immediately follows literal text in the same structured send.
   - That resolved the issue for both Codex and Claude Code in validation.

## Remaining Unknowns
- Whether the root cause is specifically:
  - Codex input-model readiness,
  - tmux text-injection pacing,
  - or a more general TUI distinction between freshly injected text and immediate submit keys.
- Whether a different named submit key such as `C-m` would behave differently from `Enter`.
- Whether Codex should eventually be added to `KNOWN_PROGRAMS` for better context quality, even though that did not drive the low-level fix.

## Conclusion
- The regression was not primarily a browser-input bug.
- It was not reproduced as a missing Enter event.
- It was not explained by trailing newline bytes in the failing `hello + submit` payload.
- The validated practical fix is to preserve a small boundary between literal text injection and the trailing submit Enter in the Bud daemon.
- Because the TUI does not expose a reliable readiness signal for "submit-safe now", the current `10ms` delay is the most pragmatic and defensible solution in this tmux-driven path.
