# Plan: Bud Error Propagation

## Context
- Recent change: Bud now owns its working directory. When the server sends an invalid `cwd`, Bud logs `WARN Run cwd does not exist; command may fail` and `failed to spawn shell in …`, but the backend/UI only see a generic run failure (no reason).
- `RunExecutor::execute_run` uses `anyhow::Context` to wrap spawn errors, but `spawn_run` currently logs and swallows the error: `unwrap_or_else(|err| warn!(error = %err, "run execution failed"))`, then calls `finish_and_start_next`.
- As a result, Bud never sends a `run_finished` frame for the failed run. The backend only sees that the WS stream ends (no `stdout`/`stderr`/`run_finished`) and eventually times out or considers the run failed without a cause.
- For a good UX, the backend and web UI need a structured error payload (e.g., `run_finished` with `status=failed`, `error="cwd not found"` or a dedicated SSE error event) so users understand why the run failed.

## Objective
Propagate execution errors from Bud’s executor all the way to the backend SSE and UI. Specifically:
1. Ensure Bud sends a `run_finished` frame even when spawn fails (with `exit_code = null`, `error` and `cwd` context).
2. Update the backend to surface that error in the SSE stream (`agent.*` or `final` event) and in APIs/logs.
3. UI should display the failure reason so users (and the agent) know what went wrong without reloading.

## Research Findings
- Bud currently emits `run_finished` only after `child.wait()`. If `command.spawn()` fails early, the `Result` bubbles up, `spawn_run` logs it, and no frame is sent.
- `RunCommand` now contains a `PathBuf cwd`; after we move `current_dir(&run.cwd)` before `spawn`, any invalid path triggers `std::io::Error`. Bud needs to catch this and send a `run_finished` with `error` field.
- Protocol `run_finished` frame doesn’t have an `error` property yet. Backend SSE `final` event includes `error` only when agent loop sets `runTable.error`. We might re-use `exit_code` (set to null) and rely on `runTable.error`. For transparency, we should add an `error` field to `run_finished`.
- Backend `run_manager.handleRunFinished` currently sets `final` SSE data `{ status, exit_code, signal }`. It should include `error` when provided. Also, to capture early errors we might have to send `final` from Bud even if spawn fails.
- UI’s `appendEvent('final', data)` already logs the final payload; we can display `data.error` in the logs and UI surfaces. The optimistic flow will still work because `fetchMessages` refreshes after `final`.

## Proposed Changes
1. **Bud**
   - Update `RunExecutor::execute_run` to catch errors from spawn/wait. On error:
     - Send a `run_finished` frame with `exit_code: null`, `error: "<context>"`, `canceled: false`, `cwd`.
   - Always emit `run_finished` even if spawn fails before pipes are set up.
   - Extend the `run_finished` payload to include `error` (and ensure `docs/proto.md` reflects it).
   - Consider sending a dedicated `stderr` chunk with a descriptive message (optional).
2. **Backend**
   - Extend `RunFinishedSchema` in `ws/gateway.ts` to parse `error?: string`.
   - Pass `error` into `runManager.handleRunFinished`; update DB `run.error` and SSE final event accordingly.
   - When `error` is present, set run status to `failed` regardless of `exit_code`.
3. **UI**
   - When receiving `final` or `agent.message` events with `error`, display it in the log view (maybe highlight).
   - Optionally show the Bud current directory alongside the error (already added).

## Risks / Considerations
- Bud must ensure that sending `run_finished` on error doesn’t race with other frames; all errors should flow through the same path to avoid duplicate final events.
- Need to avoid leaking sensitive file paths unless acceptable; for now, CWD is already part of metadata, so logging `/Users/...` is OK for local testing.
- Agents or future automation might look at `run.error`; ensure SSE final event includes it.

## Next Steps
1. Modify Bud executor to send `run_finished` with `error` when `command.spawn()` (or later stages) fail. Update protocol doc.
2. Update backend schema & SSE to propagate `error`.
3. Adjust UI log display to show `final.error`.
4. Manually test by running with an invalid directory to confirm the UI shows an error message. 
