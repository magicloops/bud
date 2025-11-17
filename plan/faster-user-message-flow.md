# Plan: Faster User Message Flow

## Context
- Link to issue(s): _Phase 4 UI polish — reduce latency in chat input_
- `service/src/routes/threads.ts` currently posts user messages and then awaits `agentService.handleUserMessage`.
- `AgentService.handleUserMessage` performs the entire OpenAI/Bud loop before resolving, so `/api/threads/:id/messages` doesn’t respond until the run completes.
- Front-end (`web/src/App.tsx`) clears the input and calls `fetchMessages` after the POST resolves, but because the POST blocks, the user’s own message isn’t visible until OpenAI responds (or the page reloads).

## Objective
Return from `POST /threads/:threadId/messages` immediately after persisting the user message, while the agent loop runs in the background. Optionally, introduce optimistic UI so the message appears the moment you hit “Send”.

## Proposed Changes
1. **Backend async dispatch**
   - Split `AgentService.handleUserMessage` into:
     - `startUserMessage(threadId: string): { runId: string }` — creates the run + start record (current `createRunRecord` call), then fires an async task to execute the existing loop (`runAgentFlow`).
     - `runAgentFlow(threadId, runId, budId)` — current while-loop logic, moved into a private method with try/catch.
   - Route handler (`service/src/routes/threads.ts`):
     - Insert the user message + metadata (already done).
     - Immediately call `agentService.startUserMessage` and respond with `{ messageId, runId }`.
     - Background promise errors should be logged, but not block the HTTP response.
2. **Front-end refresh**
   - Since the API now responds right away, the existing `fetchMessages` call will include the newly inserted user message. (Optional) add an optimistic entry to `messages` before the fetch completes for an even snappier feel.
   - Make sure SSE streaming still works; the run events arrive even though the response is no longer delayed.
3. **Optimistic UI (optional)**
   - When the user submits, temporarily push a local message object with `message_id = 'temp_'+uuid`, `role = 'user'`.
   - After `fetchMessages` returns, reconcile by removing the temp entry if the real message is present.
   - This is optional if backend latency is acceptable once the POST returns immediately.

## Impacted Modules
- `service/src/agent/agent-service.ts`
- `service/src/routes/threads.ts`
- `web/src/App.tsx` (optional optimistic insert)

## Risks / Mitigations
- **Fire-and-forget errors**: ensure the async task logs failures and sets run status to failed via existing code so SSE subscribers still get a final event.
- **Concurrent POSTs**: maintain queue semantics; `RunManager.createRunRecord` already checks Bud status and ensures runs are serial for a thread.
- **Optimistic message duplicates**: require a reconciliation step; safest approach is to skip optimistic insert until backend change is verified.

## Rollout Steps
1. Refactor AgentService + route as above.
2. Test locally: send a message and confirm the API returns immediately, user message appears after `fetchMessages`.
3. Add optimistic UI only if needed after measuring latency.
