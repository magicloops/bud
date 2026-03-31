# Review: Message Streaming and Message IDs

## Conclusion

The current implementation is **partially** aligned with the impression described, but only for assistant and tool messages.

- The **user message row is inserted immediately** in `POST /api/threads/:threadId/messages`, before the agent starts streaming, and the route returns that canonical `message_id` in the HTTP response (`service/src/routes/threads.ts:540-558`).
- The **assistant draft is streamed without a DB row**. The assistant row is inserted only after the streamed draft is complete, then sent to the client as `agent.message` with the canonical `message_id`, followed by `final` (`service/src/agent/agent-service.ts:433-468`).
- Tool calls follow the same pattern as assistant drafts: the client first renders a synthetic pending tool row, then the service inserts the tool message row and sends it back in `agent.tool_result` (`service/src/agent/agent-service.ts:388-423`).

So the accurate summary is:

- **User message ID**: available immediately via the `POST /messages` response.
- **Assistant message ID**: available later via `agent.message` after draft streaming finishes and the row is persisted.
- **Tool message ID**: available later via `agent.tool_result` after tool execution completes and the row is persisted.

## Findings

### 1. User messages are persisted before streaming starts

`POST /api/threads/:threadId/messages` inserts the user message row first, records thread metadata, then calls `agentService.startUserMessage(...)`, and finally returns `{ message_id }` from the inserted row (`service/src/routes/threads.ts:540-558`).

This means the current system does **not** wait for the full agent turn to finish before assigning or returning the user message ID.

### 2. Assistant draft streaming is non-durable until the final assistant row is written

The agent runtime emits:

- `agent.message_start`
- `agent.message_delta`
- `agent.message_done`

while accumulating in-memory draft text (`service/src/agent/agent-service.ts:672-745`).

Those draft events update runtime state and SSE only. The assistant `message` table row is not inserted until `runAgentFlow()` reaches its final response path, where it inserts the assistant row and emits `agent.message` with the canonical payload and `message_id` (`service/src/agent/agent-service.ts:433-468`).

### 3. Tool rows are also persisted after execution, not before

When the model requests a tool call, the service emits `agent.tool_call` first, then executes the terminal action, persists the tool message row through `recordTerminalToolMessage(...)`, and finally emits `agent.tool_result` with both `message_id` and the full canonical `message` payload (`service/src/agent/agent-service.ts:328-423`, `service/src/agent/agent-service.ts:1141-1181`).

### 4. The front-end uses synthetic IDs during a live turn, then reconciles to canonical IDs

The existing thread view uses three ID classes:

- optimistic user IDs: `temp_*`
- pending tool IDs: `tool_call:<call_id>`
- draft assistant IDs: `assistant_draft:<turn_id>`

These are defined and reconciled in `web/src/routes/$budId/$threadId.tsx` (`web/src/routes/$budId/$threadId.tsx:95-163`).

The replacements happen as follows:

- optimistic user row -> canonical `message_id` from `POST /messages` (`web/src/routes/$budId/$threadId.tsx:1594-1625`)
- pending tool row -> canonical tool `message` from `agent.tool_result` (`web/src/routes/$budId/$threadId.tsx:960-974`)
- draft assistant row -> canonical assistant `message` from `agent.message` (`web/src/routes/$budId/$threadId.tsx:978-1076`)

### 5. `/agent/state` plus `stream_cursor` is the bootstrap contract for in-flight turns

The thread view loads `/messages` and `/agent/state` together (`web/src/routes/$budId/$threadId.tsx:226-238`), then overlays any in-flight pending tool or draft assistant state from `agent_state` on top of the durable transcript (`web/src/routes/$budId/$threadId.tsx:166-219`).

`AgentRuntimeStateManager.startTurn(...)` allocates active runtime state before visible stream events begin (`service/src/agent/agent-service.ts:276-287`), and the runtime snapshot always includes a `stream_cursor` (`service/src/runtime/agent-runtime-state.ts:98-107`, `service/src/runtime/agent-runtime-state.ts:443-450`).

The SSE connection resumes with `?after=<stream_cursor>` (`web/src/routes/$budId/$threadId.tsx:326`, `web/src/routes/$budId/$threadId.tsx:869-874`).

### 6. No-cursor agent stream attach is live-only; stale cursors require resync

The runtime stream store behaves like this:

- no `afterCursor` -> attach live with no replay (`service/src/runtime/agent-runtime-state.ts:321-328`)
- known cursor -> replay only newer buffered events (`service/src/runtime/agent-runtime-state.ts:332-343`)
- unknown/stale cursor -> return `resync_required` (`service/src/runtime/agent-runtime-state.ts:332-339`)

The route surfaces that as `agent.resync_required` (`service/src/routes/threads.ts:576-603`), and the front-end responds by refetching `/messages` plus `/agent/state` and reconnecting (`web/src/routes/$budId/$threadId.tsx:1080-1111`).

### 7. `final` is not the canonical transcript payload

The assistant canonical row is emitted in `agent.message` before `final` (`service/src/agent/agent-service.ts:453-468`).

On the client, `final` mainly:

- sets the UI back to idle
- clears synthetic pending rows
- reports failed/canceled status

It does **not** perform the assistant/tool ID reconciliation itself (`web/src/routes/$budId/$threadId.tsx:1113-1140`).

## Current End-to-End Flow

### Existing thread: user submits a message

1. The front-end appends an optimistic user row with `temp_*` (`web/src/routes/$budId/$threadId.tsx:1594-1601`).
2. `POST /api/threads/:threadId/messages` inserts the real user row in Postgres (`service/src/routes/threads.ts:540-550`).
3. The route calls `agentService.startUserMessage(...)`, which:
   - allocates `turn_id`
   - marks the turn active in runtime state
   - ensures/creates the terminal session
   - spawns the async agent loop
   (`service/src/agent/agent-service.ts:264-298`)
4. The HTTP response returns `{ message_id }` for the user row (`service/src/routes/threads.ts:558`).
5. The front-end replaces `temp_*` with that canonical user ID (`web/src/routes/$budId/$threadId.tsx:1624-1625`).
6. The front-end refreshes `/agent/state` and keeps or opens the SSE stream (`web/src/routes/$budId/$threadId.tsx:1627-1639`).

### Assistant streaming

1. The runtime may already show `active: true` with a resumable `stream_cursor` before any visible SSE text exists.
2. The SSE stream emits `agent.message_start`, `agent.message_delta`, and `agent.message_done` while the assistant text is still draft-only (`service/src/agent/agent-service.ts:672-745`).
3. The client renders that as `assistant_draft:<turn_id>` with `metadata.draft === true` (`web/src/routes/$budId/$threadId.tsx:978-1048`).
4. `ChatTimeline` renders draft assistant rows with a pulsing cursor instead of the normal message renderer (`web/src/components/workbench/chat-timeline.tsx:155-246`).
5. Once the agent has its final answer, the service inserts the assistant row and emits `agent.message` with the canonical `message` payload (`service/src/agent/agent-service.ts:433-458`).
6. The client replaces the draft row with the persisted assistant row (`web/src/routes/$budId/$threadId.tsx:1052-1076`).
7. The service emits `final`, and the client treats that as completion status rather than the source of truth for transcript identity (`service/src/agent/agent-service.ts:463-471`, `web/src/routes/$budId/$threadId.tsx:1113-1140`).

### Tool calls

1. `agent.tool_call` creates a synthetic pending tool row on the client (`web/src/routes/$budId/$threadId.tsx:927-958`).
2. After execution, the service inserts the tool row and emits `agent.tool_result` with canonical `message` data (`service/src/agent/agent-service.ts:388-423`, `service/src/agent/agent-service.ts:1141-1181`).
3. The client replaces `tool_call:<call_id>` with the persisted tool row (`web/src/routes/$budId/$threadId.tsx:960-974`).

### New thread flow

The `/new` route creates the thread, posts the first message, and immediately navigates to `/$budId/$threadId` (`web/src/routes/$budId/new.tsx:145-163`).

Notably, it does **not** consume the returned `message_id` before navigation. The canonical first user row is instead picked up by the destination route's `/messages` loader plus `/agent/state` bootstrap.

## Notable Behaviors and Risks

### 1. A failed `POST /messages` can still leave a persisted user row

Because the user row is inserted before `agentService.startUserMessage(...)` is awaited, a failure in agent startup can return `500` after the user message already exists in the database (`service/src/routes/threads.ts:540-558`).

The existing-thread UI removes the optimistic row on request failure (`web/src/routes/$budId/$threadId.tsx:1643-1646`), so a later reload can surface a user message that looked like it failed to send. That is the main behavioral mismatch I found.

### 2. The client does not need `final` to learn canonical assistant/tool IDs

The current code already streams canonical transcript rows once they exist:

- tool row via `agent.tool_result`
- assistant row via `agent.message`

That means the front-end no longer needs a post-turn transcript refetch just to learn IDs for healthy successful turns.
