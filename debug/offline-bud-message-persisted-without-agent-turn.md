# Debug: offline-bud-message-persisted-without-agent-turn

## Environment
- Date: 2026-05-26
- Workspace: `/Users/adam/bud`
- Scenario: mobile local dev points at local service while the Bud daemon is disconnected or restarting
- Route under review: `POST /api/threads/:thread_id/messages`
- Investigation mode: static architecture/code review only; no code changes

## Repro Steps
1. Open a thread that already has an active terminal session row.
2. Disconnect or restart the Bud daemon so the service considers the Bud offline.
3. Send a chat message through `POST /api/threads/:thread_id/messages`.
4. Observe the service logs, chat transcript, `/agent/state`, and client loading state.

## Observed
- Context sync attempts to observe the existing terminal session and fails because the Bud is offline:
  - `Context sync failed, skipping`
  - `Error: bud_offline`
  - stack points through `TerminalRequestDispatcher.observeTerminal(...)` and `ContextSyncService.captureCurrentState(...)`
- The route continues after context sync because context sync is intentionally best-effort.
- The user message is inserted into `message`.
- `AgentService.startUserMessage(...)` then attempts to ensure the thread terminal session.
- Terminal ensure fails:
  - `Session state is ready but bud is offline`
  - `Agent failed to queue message`
  - `Error: bud_offline`
- The route responds with `500 { "error": "bud_offline" }`.
- The persisted user message remains in canonical chat history, but no assistant response or failed `final` stream event is produced.

## Expected
- Clients should not be left waiting for an agent response that cannot start.
- The backend should expose one coherent outcome:
  - either reject the send before persisting the user message, or
  - persist the user message and clearly mark/emit that no agent turn was started.
- Mobile and web should be able to reconcile optimistic UI state from the HTTP response and canonical `/messages` state without guessing.

## Current Architecture

### `POST /messages` order of operations
In `service/src/routes/threads/messages.ts`, the fresh message path currently does this:

1. Resolve the authorized thread/viewer.
2. Resolve effective model/reasoning selection.
3. Deduplicate by client-supplied `client_id`.
4. Supersede pending `ask_user_questions` prompts.
5. Update thread model preference if needed.
6. If there is an active terminal session and no active agent, run best-effort context sync.
7. Build metadata, including cached path context.
8. Insert the user message row.
9. Record thread message metadata.
10. Call `agentService.startUserMessage(...)`.
11. On success, return `201 { message_id, client_id, message }`.
12. On failure, log `Agent failed to queue message` and return `500 { error }`.

The important ordering is that step 8 commits the user message before step 10 proves the agent can start.

### Context sync is not the root failure
`ContextSyncService.checkAndSync(...)` catches its own errors and returns `null` after logging `Context sync failed, skipping`. The route also wraps the call in a catch block.

That means the first `bud_offline` log is useful signal but not the request-failing error. It confirms the terminal path is offline before the user message insert.

### Agent startup failure path
`AgentService.startUserMessage(...)` starts a runtime turn and registers a cancellation controller before ensuring the terminal session. If session ensure fails, the catch path clears the cancellation and finishes the runtime turn, then rethrows.

This cleanup prevents `/agent/state` from remaining active forever. However, startup failure happens before `runAgentFlow(...)` is spawned, so there is no `final` SSE event with `status: "failed"`.

### Terminal ensure offline path
`TerminalSessionStore.ensureSession(...)` returns `bud_offline` when:

- an existing session is `ready`, `active`, or `idle`, but `daemonTransport.isBudOnline(budId)` is false
- a pending/creating session needs `terminal_ensure`, but `sendFrameToBud(...)` fails

`AgentService.getOrCreateSession(...)` converts that failed ensure result into `throw new Error("bud_offline")`.

## Why This Produces The Client Edge Case

The current route has non-atomic semantics:

```text
HTTP result: failed
durable transcript: user message committed
agent runtime: no active turn
agent stream: no assistant/tool/final event
```

That is awkward for clients:

- A client that treats HTTP failure as "message was not saved" may remove the optimistic row, only to see the message reappear after a history refresh.
- A client that treats the canonical user row as an active prompt may wait for an assistant response that will never arrive.
- A client that waits on agent-stream `final` will not receive one because the turn failed before `runAgentFlow(...)` began.
- Web's current route keeps a local optimistic row only during the request and removes it on non-OK, but the canonical row can still reappear from `/messages`.
- Mobile can show a spinner if it has already associated the submitted/canonical user message with an expected agent response and does not see a terminal `final` or explicit offline send result.

## Top Hypotheses

### 1. Strongest: POST `/messages` commits user intent before checking terminal availability
The durable user row is written before `AgentService.startUserMessage(...)` calls `ensureSession(...)`. If `ensureSession(...)` returns `bud_offline`, the route cannot honestly report "nothing happened" because the transcript already changed.

Why it fits:
- the stack shows `AgentService.getOrCreateSession(...)` throwing `bud_offline`
- the route catches that after the insert block
- the persisted message remains visible in chat history

### 2. Strong: startup failures do not emit a stream-level terminal event
The startup failure catch in `startUserMessage(...)` calls `runtime.finishTurn(...)` but does not emit `final { status: "failed" }`.

Why it fits:
- no agent flow has been spawned yet
- no assistant/tool message is possible
- clients relying on stream completion do not get an explicit failure boundary

Why this is only part of the issue:
- even with a failed `final`, the HTTP response would still be `500` after persistence unless the route contract also changes.

### 3. Medium: current HTTP status does not encode partial success
The route returns plain `500 bud_offline`, but the actual outcome is closer to "user message persisted; agent not started".

Why it fits:
- the response does not include the persisted `message`
- clients cannot reconcile the canonical row from the failed response
- retrying with the same `client_id` later returns the duplicate user row and intentionally does not launch a second agent turn

### 4. Medium: duplicate retry semantics make naive retry hard
Duplicate owned `client_id` retries short-circuit before side effects and do not launch a second agent turn. This is correct for normal idempotency, but it means a client cannot simply retry the exact same send after Bud reconnects and expect the old message to start an agent turn.

Why it matters:
- if the initial request persisted the row but failed before agent start, a retry with the same `client_id` returns the existing message only
- a retry with a new `client_id` creates a second user message

## Potential Fix Directions

### Option A: preflight terminal availability before inserting the user message
Before writing the user row, prove the thread can start an agent turn by checking Bud/session availability.

Possible shape:
- resolve or create/ensure the terminal session before inserting the user message
- if Bud is offline, return a typed non-500 error such as `409 bud_offline` or `424 bud_offline`
- do not persist the user message in that path

Pros:
- keeps POST semantics clean: non-2xx means no user message was committed
- clients can keep the draft or failed optimistic message locally
- no orphaned transcript rows

Cons:
- the agent needs the user message in durable history before model invocation, so this only preflights readiness; `startUserMessage(...)` still needs to run after insert
- Bud can disconnect between preflight and agent start, so the startup-failure path still needs handling
- creating a terminal session record as a preflight side effect may still leave a pending session row if Bud is offline unless the preflight is read-only

### Option B: keep the message, but return a partial-success response
If the user message is already persisted and agent startup fails, return a response that includes the canonical message plus explicit agent-start failure.

Possible shape:

```json
{
  "message_id": "...",
  "client_id": "...",
  "message": { "...": "..." },
  "agent": {
    "started": false,
    "error": "bud_offline",
    "retryable": true
  }
}
```

Status could be `201`, `202`, or a typed non-2xx. A 2xx is easier for clients to reconcile because the message was committed; the embedded `agent.started: false` tells them not to wait for a response.

Pros:
- minimal data-model impact
- clients can replace optimistic rows with the canonical persisted message
- clients can stop spinners immediately and show an offline/send-not-started state

Cons:
- first-party clients must handle a new create-message response shape
- old clients may treat 2xx as "agent will respond"
- does not by itself create a durable transcript marker explaining the missing assistant response

### Option C: persist a failed assistant/system marker for startup failures
When the user message is committed but the agent cannot start, also persist a short system or assistant-like failure row and/or emit a failed `final`.

Pros:
- transcript history explains why there is no assistant answer
- clients that reload history see a complete failure boundary
- avoids relying only on transient HTTP response handling

Cons:
- product decision needed: should offline startup failures become visible transcript rows?
- assistant/system role choice matters for model replay and user experience
- must ensure the failure marker does not get replayed as model-authored content unless intended

### Option D: introduce durable send/turn status
Add an explicit durable status model for user submissions or agent turns, for example `message.agent_status`, a new `agent_turn` table, or restored run-like metadata.

Pros:
- cleanest long-term state machine
- supports queued, failed, retryable, canceled, and running states
- mobile can render precise status without inferring from stream silence

Cons:
- schema and migration work
- broader API, SSE, and client updates
- heavier than this development-environment edge case may require

## Current Read

The best immediate diagnosis is a route-level atomicity/contract gap. `POST /messages` currently has a durable side effect before the agent-start precondition is confirmed, then reports the later `bud_offline` as a total request failure.

For a small pragmatic fix, the lowest-risk direction is likely a combination of:

1. add a typed offline startup failure response for the post-insert failure path that includes the canonical persisted user message
2. make clients stop waiting for an agent response when that response says `agent.started === false`
3. optionally add a preflight to avoid committing user messages in the common, already-known-offline case

If the product wants "send means durable user intent even while Bud is down", favor Option B or D. If the product wants "send only succeeds when an agent turn can start now", favor Option A plus a race fallback for startup failure after insert.

## Suggested Next Validation
1. Confirm the exact HTTP response mobile receives for the offline send: status, body, and whether it resolves or remains pending in the client layer.
2. After the failed send, call `GET /api/threads/:thread_id/messages?limit=100` and confirm the user row exists.
3. Call `GET /api/threads/:thread_id/agent/state` and confirm `active: false`.
4. Watch `/agent/stream` and confirm there is no `final { status: "failed" }` for that failed startup.
5. Retry the same request with the same `client_id` after Bud reconnects and confirm it returns the duplicate row without launching a turn.
6. Decide product semantics before code changes:
   - reject-before-persist when offline
   - persist-and-report agent-start failure
   - persist-and-queue for later

## Files Reviewed
- `bud.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/runtime/terminal/terminal.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/routes/threads/messages.ts`
- `service/src/agent/agent-service.ts`
- `service/src/terminal/context-sync-service.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/runtime/terminal/session-store.ts`
- `service/src/runtime/terminal/request-dispatcher.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/features/threads/use-thread-messages.ts`
