# Debug: Composer Spinner Resets Too Early

## Environment
- Web UI (`pnpm dev`) against local service + Bud agent.
- Command composer shows animated spinner while `status === 'dispatching'`.
- Issue occurs on multi-step agent runs (multiple tool calls or LLM re-entries).

## Repro steps
1. Open a thread and send a prompt that triggers at least two tool calls (or a second OpenAI pass).
2. Observe the send button spinner: it animates while the agent is planning, but as soon as Bud emits the first stdout chunk the spinner disappears even though the run continues (another tool call or assistant message still pending).
3. Tail the service logs to confirm SSE still streaming events after the spinner stops.

## Observed
- In `App.tsx`, `status` transitions:
  - On submit: `dispatching`.
  - Once we open the SSE stream (`startStream`), we immediately call `setStatus('streaming')`.
  - The button is disabled whenever `status === 'dispatching'`, so as soon as we flip to `streaming`, the spinner vanishes even though the run hasn’t finished.
- The send button does not reflect active runs beyond that first phase, so if the backend kicks off another Responses API call (after tool result) the user sees the button idle while logs still flow.

## Hypotheses
1. Spinner is tied to “dispatching” rather than “run active”. We probably want the loader anytime the run hasn’t completed (i.e., while SSE is streaming or the agent is still reasoning).
2. `status` is overloaded for view states (Bud rail uses it to show “Dispatching” vs “Streaming”), so we might need a separate state for “composer busy” vs “terminal streaming”.
3. For multi-call agent runs, we never re-enter the `dispatching` state even though the backend is issuing another API call—`status` stays `streaming`, so the composer appears idle.

## Proposed fixes
- Track a boolean `runInProgress` or extend `status` to include `running`. Keep the spinner active until we receive the final SSE event (and history sync).
- Alternatively, disable the composer until the run finishes regardless of status (and show spinner when disabled, not just in `dispatching`).
- Ensure we reset the spinner only after the SSE source closes (`final` event), not when the first stdout chunk arrives.

## Next actions
- [x] Capture behavior and hypotheses.
- [ ] Adjust composer button logic to reflect entire run lifecycle (either tie to `status !== 'idle'` or add a dedicated state).
