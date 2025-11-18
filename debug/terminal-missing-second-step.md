# Debug: Terminal Missing Second Tool Call

## Environment
- Web UI streaming SSE over `/api/runs/:id/stream` with Bud agent executing multiple commands.
- Backend `/api/threads/:threadId/runs` returns one entry per run (not per tool call).
- Observed in threads where the agent issues `ls -lt` followed by `sed -n '1,200p' ...`.

## Observed
- Chat timeline shows two tool calls (both shell.run entries) with their payloads.
- Terminal pane only shows the first command; second command’s stdout never appears.
- Refreshing the page doesn’t add the missing command (history view still shows one entry for that run).

## Root cause
1. **History endpoint granularity**: `/api/threads/:threadId/runs` returns a single record per run, sourced from `run_table` + `run_summary`. It pulls `run_step` only to capture the *first* step (`idx=0`) to get the original command. For multi-step/scripted runs the second tool call is the same `run_id`, so history never surfaces a separate entry.
2. **Terminal state reset**: When SSE `final` event fires, we immediately clear `terminalEntries` and rely on history to repopulate. Since history only contains the last command (or first step), any additional tool calls disappear.
3. **No SSE persistence**: We don’t retain previous SSE entries once history merges, so there’s no way to scroll back to earlier tool calls in the terminal unless they’re part of history.

## Summary
- We’re modeling runs at run-level granularity, but the chat/agent operate at tool-call granularity. Without storing each step’s stdout (or keeping terminalEntries per step), multi-call runs collapse into a single entry.

## Proposed fixes
- Option 1: Extend `/api/threads/:threadId/runs` (or add `/runs/:id/steps`) to return all steps with their commands/stdout tails, and render each in the terminal history.
- Option 2: Don’t clear live SSE entries after `final`; instead, append them to history so each tool call remains visible (needs persisted per-step metadata).
- Option 3: Per-run request for `/api/runs/:id/steps` when viewing history; combine with SSE to show all commands.

## Next actions
- [x] Document behavior and root cause.
- [ ] Decide whether to expose run steps in history or change terminal state management.
