# Debug: Live Tool Result Ordering After Follow-Up

## Environment
- Web existing-thread route: `web/src/routes/$budId/$threadId.tsx`.
- Transcript state hooks: `web/src/features/threads/use-thread-messages.ts` and `web/src/features/threads/thread-message-state.ts`.
- Agent stream hook: `web/src/features/threads/use-agent-stream.ts`.
- Message create route: `service/src/routes/threads/messages.ts`.
- Issue is live-feed only; after refreshing, `/api/threads/:threadId/messages` returns the expected order.

## Repro Shape
1. Agent emits an `ask_user_questions` tool call and the web timeline renders the pending question row.
2. User ignores the question card and sends a normal follow-up message through the composer.
3. Service supersedes the pending question request, records a skipped tool result for the old turn, then starts a fresh turn from the new user message.
4. In the live timeline, the skipped tool result appears after the new user message.
5. Refreshing the page shows the skipped tool result before the user message.

## Current Frontend Flow
- `handleSubmit(...)` creates an optimistic user row immediately with `created_at: new Date().toISOString()`.
- `POST /api/threads/:threadId/messages` now returns `{ message_id, client_id, message }`.
- `reconcileMessagePersistence(...)` should replace the optimistic row with the returned canonical `message`, including server `created_at`.
- `useAgentStream(...)` handles `agent.tool_result`; if the event contains `message`, `applyToolResultMessage(...)` upserts that full canonical tool row.
- `upsertMessage(...)` always re-sorts by `created_at`, then `client_id`.
- `ChatTimeline` renders the hook-owned array directly and does not re-sort.

## Backend/Refresh Contrast
- The message-create route calls `agentService.supersedePendingUserQuestionsForFollowUp(...)` before inserting the new user message.
- Tool-result SSE events include a full serialized canonical message with server `created_at`.
- The latest transcript endpoint orders persisted messages by `message.created_at`, then `message.message_id`, and returns full serialized rows.
- Because refresh discards optimistic local timestamps, it naturally converges to the persisted order.

## Top Hypotheses
1. **Likely root cause: optimistic user timestamp survives reconciliation.** The browser timestamps the follow-up user row before the POST runs. The service then records the superseded tool result and user row with server timestamps, but the live user row never receives its canonical `created_at`. Sorting can therefore keep the user row before the tool result even though the persisted server order is tool result first, user second.

2. **The create-message response is too thin for live transcript convergence.** Returning only ids forces the web client to keep optimistic fields that are semantically temporary. A full serialized user message, or at least canonical `created_at`, would let `reconcileMessagePersistence(...)` align live ordering with refresh ordering immediately.

3. **Frontend tie-breaking does not match the backend cursor/order contract.** The client tie-breaks equal timestamps by `client_id`, while the service orders by `message_id`. This is probably not the main issue here, but it can create live-vs-refresh drift when rows share the same timestamp or when an optimistic row has been partially reconciled.

4. **Agent-state refresh after send may briefly remove/rebuild synthetic rows.** After message persistence, `handleSubmit(...)` calls `refreshAgentState(...)`, which applies a fresh pending-tool/draft overlay. This should not reorder a canonical tool result once received, but it could make the visual transition harder to reason about if the old turn finalizes while the new turn is starting.

## Suggested Validation
- Add a pure `thread-message-state.test.ts` case with:
  - pending ask-user tool row at `T0`
  - optimistic user row at browser time `T1`
  - canonical skipped tool result at server time `T2`
  - canonical user row at server time `T3`
- Assert current behavior places the user before the tool when the user row keeps `T1`.
- Assert the desired behavior after reconciliation uses `T3` and sorts tool before user.
- In the browser, log live `created_at` values for the optimistic user row, canonical tool-result row, and post-refresh user row during the repro.

## Candidate Fixes
- Prefer returning the full serialized user message from `POST /api/threads/:threadId/messages` and updating the web reconciliation path to replace optimistic rows with that canonical row.
- At minimum, include `created_at` in the create-message response and have `reconcileMessagePersistence(...)` update it.
- Align client sorting with backend ordering by using `created_at`, then `message_id`, with `client_id` only as a fallback for synthetic/optimistic rows.
- Keep any special-case follow-up supersession ordering out of `ChatTimeline`; ordering should be solved in transcript state so web and mobile can share the same service contract assumptions.

## Next Actions
- [x] Capture the live-vs-refresh flow and top hypotheses.
- [x] Decide whether the message-create response should return a full serialized `message`.
- [x] Add a frontend pure-state regression test before changing behavior.
