# Design: Mobile Chat Backend Contract For Thread-First UI

Status: Draft

Audience: Backend, web platform, iOS, and product

Last updated: 2026-03-20

## 1. Goal

Define the first-pass backend contract for iOS chat integration now that native auth works.

This tranche is intentionally limited to:

- Bud list/filter metadata
- thread-first conversation list
- thread detail bootstrap
- create thread
- send message
- thread-scoped streaming
- representative payload fixtures and contract notes for the iOS adapter layer

This tranche does not include the full terminal view, block-parity work, or cancel-vs-interrupt cleanup.

## 2. Review Summary

The current backend is closer to mobile-ready than the existing web IA suggests.

Key finding:

- the web app is Bud-first in navigation
- the backend is already capable of a thread-first mobile list

Today, the service already supports:

- authenticated Bud list via `GET /api/buds`
- authenticated thread list via `GET /api/threads`
- optional Bud filtering via `bud_id`
- thread metadata via `GET /api/threads/:threadId`
- message history via `GET /api/threads/:threadId/messages`
- thread creation via `POST /api/threads`
- message send via `POST /api/threads/:threadId/messages`
- thread-scoped agent SSE via `GET /api/threads/:threadId/agent/stream`
- cookie or bearer auth on the same route family through the shared `requireViewer(...)` contract

The main gaps are not missing primitives. They are:

1. missing mobile-focused contract documentation and fixtures
2. mixed response casing on some write routes
3. a few implementation-shaped details that need to be made explicit for native clients

## 3. Current Implementation Findings

### 3.1 Auth and ownership already work for mobile-style route reuse

The same Bud/thread/message routes currently accept either:

- Better Auth browser cookies
- OAuth bearer tokens verified through the local OAuth Provider JWT path

That means mobile does not need a separate auth flavor for core chat routes.

### 3.2 Thread-first list already exists

`GET /api/threads` already returns all visible owned threads for the authenticated user and does not require a Bud-scoped route.

Current behavior:

- no query params: all owned threads
- `bud_id=<id>`: only owned threads for that Bud
- ordered by `last_activity_at DESC`
- includes thread-level terminal summary fields:
  - `has_terminal_session`
  - `session_state`
  - `session_id`

### 3.3 Bud metadata route is already sufficient for picker/filter UI

`GET /api/buds` already returns enough Bud metadata for:

- filter UI
- new-thread Bud picker
- local label/color/status joins in the thread list

Important current behavior:

- ordered by `last_seen_at DESC`
- includes `display_name`, `accent_color`, `status`, `tags`, `capabilities`, and `last_run`
- does not include a dedicated "most recently used by chat" signal

That means mobile should own "selected Bud" and "most recently used Bud" in app state.

### 3.4 Thread detail is split across metadata and messages

Today there is no single combined thread-detail payload.

Current routes:

- `GET /api/threads/:threadId` for thread metadata
- `GET /api/threads/:threadId/messages?limit=...` for message history

This is workable for the first pass, but it must be documented clearly because the web app currently relies on parent-route loader state rather than one mobile-style thread bootstrap call.

### 3.5 Message history is not only user/assistant text

`GET /api/threads/:threadId/messages` can currently return:

- `user`
- `assistant`
- `tool`
- `system`

Also:

- the route currently returns newest-first (`created_at DESC`)
- the web UI sorts client-side before display

This needs to be explicit in the mobile contract so the iOS adapter can decide how to handle:

- reverse chronology
- tool rows
- context-sync system rows

### 3.6 Create and send routes exist, but write responses are inconsistent

Current chat write routes:

- `POST /api/threads` returns `{ threadId }`
- `POST /api/threads/:threadId/messages` returns `{ messageId }`

Those are the intended first-pass routes, but the response casing does not match the otherwise snake_case Bud/thread/message read surface.

### 3.7 Streaming exists and is thread-scoped

`GET /api/threads/:threadId/agent/stream` is already the canonical stream for agent activity within a thread.

Current behavior:

- channel key is `threadId`
- events are buffered in memory and replayed on attach
- an initial heartbeat is emitted when the buffer is empty so SSE mode opens immediately
- a periodic heartbeat is emitted by the route
- the event buffer is cleared at the start of each new agent turn

Current event types:

- `heartbeat`
- `agent.tool_call`
- `agent.tool_result`
- `agent.message`
- `final`

This is usable for mobile, but the reconnect and ordering semantics need to be written down explicitly.

## 4. Decision

For the first mobile chat tranche, Bud should keep the existing route family and adopt a thread-first usage pattern on the client.

Chosen direction:

1. Use `GET /api/threads` as the canonical thread-first list route.
2. Keep `bud_id` as an optional server-side filter on the same route.
3. Use `GET /api/buds` as the canonical Bud metadata/filter/picker route.
4. Keep thread creation and message send as separate routes in the first pass.
5. Keep agent streaming thread-scoped via `GET /api/threads/:threadId/agent/stream`.
6. Avoid inventing mobile-only chat routes unless contract cleanup clearly cannot be handled by the existing family.

This preserves parity with the current web/service architecture while letting mobile use a different top-level IA.

## 5. Recommended Backend Changes

These are the recommended changes to make the existing route family cleaner for mobile without redesigning it.

### 5.1 Publish checked-in sample fixtures and route docs

Backend should publish representative fixtures for:

- Bud list
- all-threads list
- Bud-filtered thread list
- thread detail
- message history
- send response
- stream events

These can live in checked-in markdown or JSON fixtures. The main requirement is that iOS can build adapter tests against stable examples from the backend repo.

### 5.2 Normalize or dual-emit snake_case on chat write responses

Recommended cleanup:

- `POST /api/threads` should return `thread_id`
- `POST /api/threads/:threadId/messages` should return `message_id`

To avoid breaking the current web client, the transition-safe version is:

```json
{ "thread_id": "uuid", "threadId": "uuid" }
```

and

```json
{ "message_id": "uuid", "messageId": "uuid" }
```

Longer term, mobile-facing chat routes should settle on snake_case.

### 5.3 Make message ordering explicit

Current behavior is newest-first.

That is acceptable if it is documented, but a low-risk improvement would be:

- add optional `order=asc|desc` to `GET /api/threads/:threadId/messages`
- keep current behavior as the compatibility default

This is not required to start mobile integration, but it would remove one client-side normalization step.

### 5.4 Document stream replay and reconnect semantics as part of the contract

The current agent stream can remain the first-pass stream route, but the contract needs to say explicitly:

- replay is in-memory only
- replay is process-local
- buffer is cleared at the start of a new turn
- clients should refetch canonical thread/messages state after reconnect or `final`

No new stream route is required for the first pass if these rules are documented and tested.

## 6. Canonical First-Pass API Contract

### 6.1 All my threads

Request:

```http
GET /api/threads
Authorization: Bearer <access_token>
```

Example response:

```json
[
  {
    "thread_id": "3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2",
    "bud_id": "bud_macbook_local",
    "title": null,
    "created_at": "2026-03-20T18:01:12.000Z",
    "last_activity_at": "2026-03-20T18:07:43.000Z",
    "last_message_preview": "Can you summarize the failing tests?",
    "message_count": 6,
    "pinned": false,
    "archived": false,
    "has_terminal_session": true,
    "session_state": "ready",
    "session_id": "bud-bud_macbook_local-thread-3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2"
  },
  {
    "thread_id": "0f8ca9ab-c622-4ca9-a0d0-1bb4f733df09",
    "bud_id": "bud_mini_lab",
    "title": "Check deployment logs",
    "created_at": "2026-03-19T22:11:09.000Z",
    "last_activity_at": "2026-03-20T09:12:55.000Z",
    "last_message_preview": "Show the last 200 lines from the service logs.",
    "message_count": 14,
    "pinned": false,
    "archived": false,
    "has_terminal_session": false,
    "session_state": null,
    "session_id": null
  }
]
```

Contract notes:

- this is already thread-first
- rows are ordered by `last_activity_at DESC`
- Bud label/color/status are not embedded; mobile should join them from `GET /api/buds`

### 6.2 Threads filtered to one Bud

Request:

```http
GET /api/threads?bud_id=bud_macbook_local
Authorization: Bearer <access_token>
```

Example response:

```json
[
  {
    "thread_id": "3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2",
    "bud_id": "bud_macbook_local",
    "title": null,
    "created_at": "2026-03-20T18:01:12.000Z",
    "last_activity_at": "2026-03-20T18:07:43.000Z",
    "last_message_preview": "Can you summarize the failing tests?",
    "message_count": 6,
    "pinned": false,
    "archived": false,
    "has_terminal_session": true,
    "session_state": "ready",
    "session_id": "bud-bud_macbook_local-thread-3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2"
  }
]
```

### 6.3 Bud list for filter and new-thread picker

Request:

```http
GET /api/buds
Authorization: Bearer <access_token>
```

Example response:

```json
[
  {
    "bud_id": "bud_macbook_local",
    "name": "adam-macbook",
    "display_name": "Adam MacBook",
    "os": "macos",
    "arch": "arm64",
    "version": "0.0.1",
    "accent_color": "#7dd3fc",
    "tags": ["local", "ios-dev"],
    "capabilities": {
      "terminal": true,
      "sessions": true,
      "sessions_backends": ["tmux"]
    },
    "status": "online",
    "last_seen_at": "2026-03-20T18:08:10.000Z",
    "created_at": "2026-03-18T21:42:31.000Z",
    "last_run": {
      "run_id": "01HV7TZ4A17VQ8R5H2N6M1P3XZ",
      "status": "succeeded",
      "exit_code": 0,
      "started_at": "2026-03-20T17:58:10.000Z",
      "finished_at": "2026-03-20T17:58:14.000Z"
    }
  }
]
```

Contract notes:

- use `display_name` when present, otherwise `name`
- mobile should own "selected Bud" and "most recently used Bud" locally
- no separate backend MRU field is available today

### 6.4 Thread detail bootstrap

Metadata request:

```http
GET /api/threads/3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2
Authorization: Bearer <access_token>
```

Metadata response:

```json
{
  "thread_id": "3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2",
  "bud_id": "bud_macbook_local",
  "title": null,
  "created_at": "2026-03-20T18:01:12.000Z",
  "last_activity_at": "2026-03-20T18:07:43.000Z",
  "last_message_preview": "Can you summarize the failing tests?",
  "message_count": 6,
  "pinned": false,
  "archived": false
}
```

History request:

```http
GET /api/threads/3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2/messages?limit=200
Authorization: Bearer <access_token>
```

Example history response:

```json
[
  {
    "message_id": "08f5dd9d-279c-4a9b-9d86-fbfd1f5935a8",
    "role": "assistant",
    "display_role": "Bud Agent",
    "content": "The failing tests are all in the auth suite.",
    "metadata": {
      "status": "succeeded"
    },
    "created_at": "2026-03-20T18:07:43.000Z"
  },
  {
    "message_id": "354951f8-c6dd-4427-92cf-c30077db63b4",
    "role": "tool",
    "display_role": "Tool",
    "content": "{\"tool\":\"terminal.run\",\"input\":\"pnpm test\\n\",\"output\":\"...\"}",
    "metadata": {
      "tool": "terminal.run"
    },
    "created_at": "2026-03-20T18:07:31.000Z"
  },
  {
    "message_id": "f7ea2c5f-1f67-4335-99da-dfa3fe0fc485",
    "role": "user",
    "display_role": "User",
    "content": "Can you summarize the failing tests?",
    "metadata": {},
    "created_at": "2026-03-20T18:07:20.000Z"
  }
]
```

Contract notes:

- history is currently newest-first
- clients should sort by `created_at ASC` for timeline display
- `tool` and `system` rows are valid and should not be treated as malformed data

### 6.5 Existing-thread send

Request:

```http
POST /api/threads/3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2/messages
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "text": "Can you summarize the failing tests?",
  "model": "claude-opus-4-5",
  "reasoning_effort": "medium"
}
```

Current response:

```json
{
  "messageId": "f7ea2c5f-1f67-4335-99da-dfa3fe0fc485"
}
```

Recommended future response:

```json
{
  "message_id": "f7ea2c5f-1f67-4335-99da-dfa3fe0fc485",
  "messageId": "f7ea2c5f-1f67-4335-99da-dfa3fe0fc485"
}
```

### 6.6 New thread plus first message

First-pass flow stays two-step.

Create thread request:

```http
POST /api/threads
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "bud_id": "bud_macbook_local"
}
```

Current response:

```json
{
  "threadId": "3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2"
}
```

Recommended future response:

```json
{
  "thread_id": "3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2",
  "threadId": "3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2"
}
```

Then send the first message with `POST /api/threads/:threadId/messages`.

There is no combined "create thread and first message" route today, and this design keeps that out of the first pass for parity with the current web flow.

### 6.7 Agent stream

Request:

```http
GET /api/threads/3e7d7f1d-3d79-4f1a-a82b-0938d13e1bd2/agent/stream
Authorization: Bearer <access_token>
Accept: text/event-stream
```

Current event contract:

- `heartbeat`
  - `{ "ts": <unix_ms> }`
- `agent.tool_call`
  - `{ "id": "...", "name": "terminal.run", "args": { "input": "pnpm test\n" } }`
- `agent.tool_result`
  - `{ "name": "terminal.run", "output": "...", "output_bytes": 1234, "readiness": {...}, "truncated": false, "omitted_lines": 0 }`
- `agent.message`
  - `{ "text": "The failing tests are all in the auth suite." }`
- `final`
  - `{ "status": "succeeded", "text": "..." }`
  - or `{ "status": "failed", "error": "..." }`
  - or `{ "status": "canceled", "error": "Agent turn canceled" }`

Example stream:

```text
event: heartbeat
data: {"ts":1774058000000,"initial":true}

event: agent.tool_call
data: {"id":"01HV7X80R2...","name":"terminal.run","args":{"input":"pnpm test\n"}}

event: agent.tool_result
data: {"name":"terminal.run","output":"...","output_bytes":4821,"truncated":false,"omitted_lines":0}

event: agent.message
data: {"text":"The failing tests are all in the auth suite."}

event: final
data: {"status":"succeeded","text":"The failing tests are all in the auth suite."}
```

Reconnect rules:

- attach is thread-scoped, not run-scoped
- buffered events are replayed on attach
- replay is in-memory and process-local
- the buffer is cleared at the start of each new agent turn
- clients should refetch canonical state after reconnect and after `final`

Practical first-pass recommendation:

1. `POST /messages`
2. open or refresh `/agent/stream`
3. on `final`, refetch:
   - `GET /api/threads/:threadId/messages?limit=200`
   - `GET /api/threads` if the list preview/count needs refresh

This matches the current web behavior closely.

## 7. Canonical Lifecycle Example

### Existing thread

1. mobile loads `GET /api/buds`
2. mobile loads `GET /api/threads`
3. user opens one thread
4. mobile loads:
   - `GET /api/threads/:threadId`
   - `GET /api/threads/:threadId/messages?limit=200`
5. user sends a message with `POST /api/threads/:threadId/messages`
6. mobile consumes `GET /api/threads/:threadId/agent/stream`
7. on `final`, mobile refetches message history and refreshes thread list state

### New thread

1. mobile loads `GET /api/buds`
2. user picks a Bud in local UI state
3. mobile creates thread with `POST /api/threads`
4. mobile sends first message with `POST /api/threads/:threadId/messages`
5. mobile follows the same thread-scoped stream flow as an existing thread

## 8. Mobile Adapter Notes

These are not new backend requirements, but they should be treated as part of the intended first-pass mapping.

- Thread list is the primary mobile list unit.
- Bud data should be joined client-side from `/api/buds` using `bud_id`.
- Message history should be sorted by `created_at ASC` before rendering.
- `tool` and `system` messages may be rendered in a reduced or hidden form in the first pass if the adapter is still plain-text-first.
- `/api/runs` is not the canonical first-pass send route for chat.
- terminal routes remain out of scope for this tranche even though thread rows may already expose terminal summary state.

## 9. Out Of Scope

This design does not require first-pass backend work on:

- terminal view semantics
- cancel vs interrupt cleanup
- mini-app session parity
- full structured block parity
- mobile-native settings/account UX

Those remain valid follow-up areas, but they should not block thread list, thread detail, send, and stream adoption.
