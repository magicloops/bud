# Plan: Terminal Shell Transcript

## Context
- Link to issue(s): Phase 4 UI polish (terminal pane ergonomics).
- Related docs/sections in `/plan/proof-of-concept.md`: Phase 4 (Agent loop + UI), UI schema alignment notes.

## Objective
- Replace the current “raw event dump” terminal view with a shell-like transcript that shows only the commands Bud executes (tool calls) plus their stdout/stderr.
- Show an inline “running…” indicator while Bud is still executing a command (status `dispatching`/`streaming` or tool call without a result yet).
- Preserve historical output per run/thread so the UI mirrors an actual shell session.

## Design / Approach
- **Event hydration**:
  - Instead of flattening SSE events to strings (`humanLogs`), keep a structured array of `ShellEntry` items `{ id, command, cwd, status, stdoutChunks[], stderrChunks[], startedAt, finishedAt }`.
  - When `agent.tool_call` arrives, open a new pending entry keyed by call ID or run step ID.
  - Stream `stdout`/`stderr` events into the active entry (use `seq` to append in order).
  - When `agent.tool_result` or `final` arrives, mark the entry complete and record exit code/timestamp; if Bud reports an error prior to stdout, surface that as stderr text.
- **UI rendering (`RunView`)**:
  - Replace `logs: string[]` prop with `entries: ShellEntry[]` + `status`.
  - Render each entry as:
    ```
    bud@host ~/cwd $ <command>
    <stdout lines>
    <stderr lines styled>
    ```
  - If `status === 'pending'`, show spinner/ellipsis after the prompt and keep a placeholder area for upcoming output.
- **Pending indicator**:
  - When user submits a request and run is in planning/dispatching, display a banner or last entry “Preparing command…” until we receive the first `agent.tool_call`.
  - For commands in flight (tool call without `tool_result`), show `(running…)` next to prompt.
- **State reset**:
  - Clear transcript when selecting a different thread/run ID; optionally keep last completed transcripts per run for later retrieval.

## Impacted contracts
- [ ] WSS protocol
- [ ] SSE events
- [ ] DB schema (migration)
- [ ] Agent adapter/tool registry
- [x] Web UI surfaces (`web/src/App.tsx`, `web/src/components/workbench/run-view.tsx`)

## Test plan
- Manual:
  1. Trigger a command; terminal should show prompt + command immediately and “running…” indicator until stdout arrives.
  2. Validate stdout/stderr streaming shows incrementally (multiple chunks append).
  3. Tool failures (non-zero exit or Bud error) render stderr text and final status line.
  4. Multiple commands per run stack chronologically.
  5. Switching threads clears transcript.
- Automated: rely on lint + type checking; future opportunity to add utility tests for transcript reducer.

## Rollout
- Update `PROGRESS.md` after implementation.
- Document terminal behavior briefly in `web/README.md` or future UI docs.

## Out of scope
- Persisting transcripts server-side (still derived from SSE).
- Fancy terminal emulation (PTY, ANSI colors, input).
- Cancel semantics (Phase 5).
