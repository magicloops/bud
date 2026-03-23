# iOS Mobile Backend Handoff

**Status:** Current backend/web contract documented for mobile integration  
**Audience:** iOS team, backend, web platform, product  
**Last updated:** 2026-03-22

## Purpose

This is the current backend handoff for the iOS app now that local auth is working.

It is intended to be the single mobile-facing reference for:

- auth assumptions for authenticated API use
- the current Bud/thread/message/model API surface
- the thread-first mobile integration path
- SSE and runtime behavior that matters for native clients
- known edge cases and the specific ways the current web UI uses these endpoints

This document is intentionally detailed so iOS can implement against the real current contract without reverse-engineering the web app.

## Scope

This document covers:

- authenticated Bud inventory
- thread-first conversation list
- Bud filtering and Bud picker metadata
- thread metadata and message history
- thread creation and message send
- thread-scoped agent streaming
- model inventory used by the composer
- currently available run and terminal endpoints
- known gotchas from the existing web client

This document does not attempt to redesign the product contract. It documents what exists today.

## Assumptions

This handoff assumes mobile auth is already functioning per the current local auth bundle:

- mobile uses OAuth bearer tokens, not browser cookies
- authenticated API calls send `Authorization: Bearer <access_token>`
- `GET /api/me` is the bootstrap request after sign-in
- bearer-mode sign-out/revoke uses `POST /api/me/oauth/revoke`

For full local OAuth details, see [IOS_LOCAL_AUTH_HANDOFF.md](./IOS_LOCAL_AUTH_HANDOFF.md).

## Contract Rules

### 1. Auth mode

Most browser-facing Bud routes now accept either:

- Better Auth cookie sessions
- OAuth bearer tokens

The mobile app should treat bearer auth as the canonical mode.

### 2. Ownership rules

All Bud/thread/message/run/terminal routes are user-scoped.

Practical implications:

- `401` means no valid auth
- `404` means the resource does not exist for the current user, including "belongs to another user"
- list endpoints are already ownership-filtered server-side

### 3. Wire casing

Bud-owned request and response bodies are now `snake_case`.

Important note:

- route placeholder names in this doc use `:bud_id`, `:thread_id`, and `:session_id` for readability
- the literal server implementation may still use camelCase variable names internally
- that does not change the actual URL shape seen by clients

### 4. Web IA vs backend capability

The current web UI is Bud-first in navigation.

The backend is already capable of a thread-first mobile experience.

That means iOS should not copy the web layout structure blindly:

- web route shell: Bud-first
- mobile recommendation: thread-first using `GET /api/threads` without a Bud filter by default

## Recommended Mobile Integration Path

For the first real chat tranche, the recommended mobile flow is:

1. `GET /api/me`
2. `GET /api/buds`
3. `GET /api/threads`
4. open thread detail with:
   - existing thread summary from the list
   - `GET /api/threads/:thread_id/messages?limit=100`
   - optional older-page loads with `before=<opaque_cursor>`
   - `GET /api/threads/:thread_id/agent/stream`
5. send user input with `POST /api/threads/:thread_id/messages`
6. treat SSE as live progress, but refetch the latest `/messages` page after reconnect or suspected drift to resync canonical history

For new chat:

1. choose a Bud locally
2. `POST /api/threads`
3. `POST /api/threads/:thread_id/messages`
4. open the new thread and attach the same agent stream

## Route Summary

### Required for first mobile chat slice

| Method | Path | Purpose | Recommended for iOS |
|---|---|---|---|
| `GET` | `/api/me` | auth/bootstrap current user | yes |
| `GET` | `/api/buds` | Bud list for filtering and new-thread Bud picker | yes |
| `GET` | `/api/threads` | global owned thread list | yes |
| `GET` | `/api/threads?bud_id=<bud_id>` | Bud-filtered thread list | yes |
| `GET` | `/api/threads/:thread_id` | thread metadata | optional |
| `GET` | `/api/threads/:thread_id/messages?limit=<n>[&before=<cursor>][&after=<cursor>]` | thread transcript/history | yes |
| `POST` | `/api/threads` | create new thread | yes |
| `POST` | `/api/threads/:thread_id/messages` | send user message / start agent turn | yes |
| `GET` | `/api/threads/:thread_id/agent/stream` | thread-scoped live agent stream | yes |
| `GET` | `/api/models` | model selector inventory | optional but used by web |

### Available but not required for the first chat slice

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/threads/:thread_id/runs` | run history with cursor pagination |
| `POST` | `/api/runs` | standalone command execution flow, separate from the chat composer |
| `POST` | `/api/threads/:thread_id/cancel` | cancel active agent turn |
| `POST` | `/api/threads/:thread_id/terminal` | create/get thread-scoped terminal session record |
| `POST` | `/api/threads/:thread_id/terminal/ensure` | ensure terminal is running on Bud |
| `GET` | `/api/threads/:thread_id/terminal` | terminal session status |
| `GET` | `/api/threads/:thread_id/terminal/stream` | terminal SSE output stream |
| `GET` | `/api/threads/:thread_id/terminal/history?bytes=<n>&since_offset=<n>` | output history/backfill |
| `POST` | `/api/threads/:thread_id/terminal/input` | terminal input |
| `POST` | `/api/threads/:thread_id/terminal/interrupt` | terminal Ctrl+C |
| `POST` | `/api/threads/:thread_id/terminal/resize` | terminal resize |
| `GET` | `/api/buds/:bud_id/sessions` | active session inventory for one Bud |
| `DELETE` | `/api/buds/:bud_id/sessions/:session_id` | close one active session |
| `POST` | `/api/me/oauth/revoke` | bearer-mode revoke/sign-out |

## Detailed Contract

### 1. `GET /api/me`

Use this as the authenticated bootstrap.

Example response:

```json
{
  "auth_type": "bearer",
  "user": {
    "id": "usr_01JQ7X9Y2Q0YV9C8N7J3T5K6X1",
    "email": "ada@example.com",
    "email_verified": true,
    "name": "Ada Lovelace",
    "image": "https://example.com/avatar.png"
  },
  "session": {
    "id": null,
    "expires_at": "2026-03-20T23:15:00.000Z"
  },
  "profile": {
    "username": "ada",
    "created_at": "2026-03-15T18:22:01.000Z",
    "updated_at": "2026-03-20T17:01:15.000Z"
  },
  "linked_accounts": {
    "github": true,
    "google": true
  },
  "linked_providers": ["github", "google"]
}
```

Gotchas:

- mobile bearer auth reports `session.id = null`
- this is the cleanest "am I authenticated and who am I?" route
- the current web shell uses this route for auth gating before loaders run

### 2. `GET /api/buds`

Use this for:

- Bud filter UI
- new-thread Bud picker
- Bud labels and status

Ordering:

- currently `last_seen_at DESC`
- there is no separate backend-owned "most recently used in chat" signal

That means:

- mobile should own its selected Bud locally
- mobile should own "last used Bud" locally if it wants that behavior

Example response:

```json
[
  {
    "bud_id": "b_01JQ7Y4S2E3JQ3JPN4C5A7W8M2",
    "name": "adam-mbp",
    "display_name": "Adam MacBook Pro",
    "os": "macos",
    "arch": "arm64",
    "version": "0.1.0",
    "accent_color": "oklch(0.70 0.25 330)",
    "tags": [],
    "capabilities": {
      "terminal": true,
      "terminal_backends": ["tmux"],
      "sessions": true,
      "sessions_backends": ["tmux"],
      "tmux_version": "3.4"
    },
    "status": "online",
    "last_seen_at": "2026-03-20T17:53:01.000Z",
    "created_at": "2026-03-16T21:03:44.000Z",
    "last_run": {
      "run_id": "run_01JQ7YQZYQ7C8JQ2R5WZNH4P8D",
      "status": "succeeded",
      "exit_code": 0,
      "started_at": "2026-03-20T16:45:00.000Z",
      "finished_at": "2026-03-20T16:45:09.000Z"
    }
  }
]
```

Web-specific note:

- the web app uses `/api/buds` in the Bud-first layout loader and routes `/` to the first Bud in this list
- mobile should not inherit that IA; it can use this data only for filtering/picker purposes

### 3. `GET /api/threads`

This is the canonical thread-first list route.

Supported shapes:

- `GET /api/threads`
- `GET /api/threads?bud_id=<bud_id>`

Ordering:

- server returns rows ordered by `last_activity_at DESC`

Example response:

```json
[
  {
    "thread_id": "02d6b54c-34e2-4f6a-a29c-65f82dbb2bc0",
    "bud_id": "b_01JQ7Y4S2E3JQ3JPN4C5A7W8M2",
    "title": "Investigate tmux reconnect issue",
    "created_at": "2026-03-20T17:31:00.000Z",
    "last_activity_at": "2026-03-20T17:34:42.000Z",
    "last_message_preview": "I found the first failure point in the reconnect path.",
    "message_count": 6,
    "pinned": false,
    "archived": false,
    "has_terminal_session": true,
    "session_state": "ready",
    "session_id": "sess_01JQ7Z2AX9JV5ZQ3P6N2V5GJQ9"
  },
  {
    "thread_id": "b2df0e75-d1f3-478c-b637-df4e6e7c13fc",
    "bud_id": "b_01JQ80A1A0V46MTD2T8AA6Y9S0",
    "title": null,
    "created_at": "2026-03-20T15:02:00.000Z",
    "last_activity_at": "2026-03-20T15:03:12.000Z",
    "last_message_preview": "Can you summarize the active sessions?",
    "message_count": 3,
    "pinned": false,
    "archived": false,
    "has_terminal_session": false,
    "session_state": null,
    "session_id": null
  }
]
```

Gotchas:

- this is already global across all owned Buds
- Bud filtering is server-side through `bud_id`, not client fanout
- thread list entries already include enough terminal summary to show lightweight status chips

Web-specific note:

- the current web Bud layout calls `/api/threads?bud_id=<bud_id>` because its rail is Bud-scoped
- mobile can skip that and call `/api/threads` for the default home list

### 4. `GET /api/threads/:thread_id`

Use this if the mobile detail screen needs authoritative thread metadata beyond what the thread list already has.

Example response:

```json
{
  "thread_id": "02d6b54c-34e2-4f6a-a29c-65f82dbb2bc0",
  "bud_id": "b_01JQ7Y4S2E3JQ3JPN4C5A7W8M2",
  "title": "Investigate tmux reconnect issue",
  "created_at": "2026-03-20T17:31:00.000Z",
  "last_activity_at": "2026-03-20T17:34:42.000Z",
  "last_message_preview": "I found the first failure point in the reconnect path.",
  "message_count": 6,
  "pinned": false,
  "archived": false
}
```

Web-specific note:

- the current web thread view does not call this route on open
- it relies on parent loader thread summaries plus `GET /messages`
- mobile can do the same if its list data is already in memory

### 5. `GET /api/threads/:thread_id/messages`

Use this as the canonical transcript/history route.

Supported shapes:

- `GET /api/threads/:thread_id/messages?limit=<n>`
- `GET /api/threads/:thread_id/messages?limit=<n>&before=<opaque_cursor>`
- `GET /api/threads/:thread_id/messages?limit=<n>&after=<opaque_cursor>`

Current limits:

- `limit` defaults to `100`
- max `limit` is `200`

Important behavior:

- a latest-page request has no cursor
- each returned `messages` array is ordered oldest-to-newest within that page
- the response is an envelope: `{ messages, page }`
- `page.before_cursor` and `page.after_cursor` are opaque cursors
- cursors are derived from `(created_at, message_id)` so tied timestamps remain stable
- `before` loads older messages than the boundary, exclusive
- `after` loads newer messages than the boundary, exclusive
- roles can be `user`, `assistant`, `tool`, or `system`
- `metadata` may be present and may matter for tool rows

Example response:

```json
{
  "messages": [
    {
      "message_id": "54f69b72-c3c8-4565-a5d0-5267a4952f1c",
      "role": "user",
      "display_role": "User",
      "content": "Check the terminal reconnect path.",
      "metadata": {},
      "created_at": "2026-03-20T17:34:20.000Z"
    },
    {
      "message_id": "50845910-a8f9-4f36-8b69-e0f07dc6a7e1",
      "role": "tool",
      "display_role": "terminal.run",
      "content": "{\"tool\":\"terminal.run\",\"input\":\"tmux ls\\n\",\"summary\":\"Ran tmux ls\",\"output\":\"dev: 1 windows\\n\",\"output_truncation_reason\":null}",
      "metadata": {
        "tool": "terminal.run",
        "input": "tmux ls\n",
        "summary": "Ran tmux ls",
        "output": "dev: 1 windows\n",
        "output_bytes": 15,
        "truncated": false,
        "output_truncation_reason": null
      },
      "created_at": "2026-03-20T17:34:40.000Z"
    },
    {
      "message_id": "0f47c815-7655-47d4-8bdf-e5b98dc7bb9b",
      "role": "assistant",
      "display_role": "Bud Agent",
      "content": "I found the first failure point in the reconnect path.",
      "metadata": {
        "status": "succeeded"
      },
      "created_at": "2026-03-20T17:34:42.000Z"
    }
  ],
  "page": {
    "limit": 100,
    "returned": 3,
    "has_more_before": true,
    "has_more_after": false,
    "before_cursor": "opaque_cursor_oldest_in_page",
    "after_cursor": "opaque_cursor_newest_in_page"
  }
}
```

Gotchas:

- the route is not plain user/assistant text only
- tool and system rows are real persisted rows and can appear anywhere in history
- the current web UI requests the latest page, then prepends older pages via `before`
- the current web UI hides `system` rows by default unless a debug config enables them

Recommendation for mobile:

- preserve all roles in the DTO layer
- decide separately whether `system` should render in the default UI
- render the returned `messages` array in response order
- use `page.has_more_before` plus `page.before_cursor` for upward history loading
- treat `after` as an explicit forward-catch-up tool rather than the default transcript bootstrap

### 6. `POST /api/threads`

Use this to create a new thread under a selected Bud.

Request:

```json
{
  "bud_id": "b_01JQ7Y4S2E3JQ3JPN4C5A7W8M2",
  "title": "Optional title"
}
```

Response:

```json
{
  "thread_id": "02d6b54c-34e2-4f6a-a29c-65f82dbb2bc0"
}
```

Gotchas:

- there is no combined "create thread and first message" endpoint
- current web behavior is two-step:
  1. create thread
  2. send first message
  3. navigate into the thread

### 7. `POST /api/threads/:thread_id/messages`

Use this to send a user message into an existing thread and kick off the agent turn.

Request:

```json
{
  "text": "Check the reconnect logic.",
  "model": "claude-sonnet-4-5",
  "reasoning_effort": "low",
  "cwd": "/Users/adam/bud"
}
```

Response:

```json
{
  "message_id": "m_01"
}
```

Important behavior:

- success means the user message was accepted and the agent was queued
- the response does not include assistant output
- live activity arrives separately over `GET /api/threads/:thread_id/agent/stream`

Gotchas:

- the request may insert a context-sync `system` message before the user message if terminal state changed
- `cwd` is currently advisory metadata for the turn, not a standalone route-level workspace selector

Web-specific notes:

- web inserts an optimistic local user message immediately
- once the POST succeeds, web relies on agent SSE plus later `/messages` refetches for canonical state

### 8. `GET /api/threads/:thread_id/agent/stream`

This is the canonical live stream for the first mobile chat tranche.

Scope:

- thread-scoped
- not Bud-scoped
- not run-scoped

Auth behavior:

- the stream is protected by the same authenticated viewer contract as REST routes
- bearer clients must send `Authorization: Bearer <access_token>` on the streaming request
- the current web app avoids this issue because it typically uses same-origin cookie auth for SSE
- iOS should use a streaming HTTP client that supports request headers rather than assuming a browser-style `EventSource` environment

Behavior:

- returns SSE
- route emits heartbeats periodically
- if the buffer for that thread is empty, the server primes the stream with an initial heartbeat so SSE mode opens immediately
- events are buffered in memory and can be replayed on attach
- the buffer is cleared at the start of each new agent turn

That last point is important:

- this is not a durable event log
- it is a live turn stream with short replay
- canonical transcript state still lives in `/messages`
- replay resume can use either the standard `Last-Event-ID` header or an explicit `last_event_id=<sse_frame_id>` query parameter
- if the requested resume id is no longer present in the in-memory buffer, the server falls back to live-only delivery and the client should refetch canonical history

Current event types and payloads:

#### `heartbeat`

Payload shape:

```json
{
  "ts": 1774053724000,
  "initial": true
}
```

`initial` is only present on the priming heartbeat when no buffered events existed.

#### `agent.tool_call`

Payload shape:

```json
{
  "turn_id": "01TURNABC123",
  "call_id": "call_123",
  "name": "terminal.run",
  "args": {
    "input": "tmux ls\n"
  }
}
```

#### `agent.tool_result`

Payload shape:

```json
{
  "turn_id": "01TURNABC123",
  "call_id": "call_123",
  "message_id": "50845910-a8f9-4f36-8b69-e0f07dc6a7e1",
  "name": "terminal.run",
  "summary": "Ran tmux ls",
  "output": "dev: 1 windows\n",
  "output_bytes": 15,
  "readiness": {
    "ready": true,
    "confidence": 0.96,
    "trigger": "prompt_detected",
    "hints": {
      "looks_like_prompt": true
    }
  },
  "truncated": false,
  "output_truncation_reason": null,
  "omitted_lines": 0,
  "message": {
    "message_id": "50845910-a8f9-4f36-8b69-e0f07dc6a7e1",
    "role": "tool",
    "display_role": "Tool",
    "content": "{\"tool\":\"terminal.run\",\"call_id\":\"call_123\",\"input\":\"tmux ls\\n\",\"summary\":\"Ran tmux ls\",\"output\":\"dev: 1 windows\\n\",\"output_truncation_reason\":null}",
    "metadata": {
      "tool": "terminal.run",
      "call_id": "call_123",
      "input": "tmux ls\n",
      "summary": "Ran tmux ls",
      "output": "dev: 1 windows\n",
      "output_bytes": 15,
      "truncated": false,
      "output_truncation_reason": null
    },
    "created_at": "2026-03-22T17:34:40.000Z"
  }
}
```

#### `agent.message_start`

Payload shape:

```json
{
  "turn_id": "01TURNABC123"
}
```

Use this to create or reset a per-turn draft assistant row locally.

#### `agent.message_delta`

Payload shape:

```json
{
  "turn_id": "01TURNABC123",
  "delta": "I found the first "
}
```

This is a true append chunk for the current turn's assistant draft text.

#### `agent.message_done`

Payload shape:

```json
{
  "turn_id": "01TURNABC123",
  "text": "I found the first failure point in the reconnect path."
}
```

This is the full draft assistant text just before the backend persists the canonical assistant row.

#### `agent.message`

Payload shape:

```json
{
  "turn_id": "01TURNABC123",
  "message_id": "0f47c815-7655-47d4-8bdf-e5b98dc7bb9b",
  "text": "I found the first failure point in the reconnect path.",
  "message": {
    "message_id": "0f47c815-7655-47d4-8bdf-e5b98dc7bb9b",
    "role": "assistant",
    "display_role": "Bud Agent",
    "content": "I found the first failure point in the reconnect path.",
    "metadata": {
      "status": "succeeded"
    },
    "created_at": "2026-03-22T17:34:42.000Z"
  }
}
```

Important distinction:

- `agent.message_start` / `agent.message_delta` / `agent.message_done` describe a draft assistant message
- `agent.message` is the canonical persisted assistant transcript row
- the current web client replaces the draft row with `agent.message.message` when it arrives

#### `final`

Success shape:

```json
{
  "turn_id": "01TURNABC123",
  "status": "succeeded",
  "text": "I found the first failure point in the reconnect path.",
  "message_id": "0f47c815-7655-47d4-8bdf-e5b98dc7bb9b"
}
```

Cancel/failure shapes:

```json
{
  "turn_id": "01TURNABC123",
  "status": "canceled",
  "error": "Agent turn canceled"
}
```

```json
{
  "turn_id": "01TURNABC123",
  "status": "failed",
  "error": "agent_failed"
}
```

SSE gotchas:

- the SSE event `id` exists in the SSE frame metadata, not inside most JSON payloads
- assistant text now streams as true deltas before canonical persistence
- successful tool and assistant events now carry canonical persisted transcript rows under `message`
- `call_id` on `agent.tool_call` and `agent.tool_result` is stable and matches `metadata.call_id` in persisted tool rows
- `agent.tool_result.summary` is the compact server-owned label for collapsed UI
- `truncated` answers whether the raw tool output itself was partial; `output_truncation_reason` explains whether that came from the Bud runtime or the service backfill path
- the current web client keeps one temporary pending tool row between `agent.tool_call` and `agent.tool_result`
- it also keeps one temporary draft assistant row per `turn_id`, built from `agent.message_start` / `agent.message_delta` / `agent.message_done`
- the current web client does not invent long-lived assistant/tool transcript ids once the persisted row exists

Recommended mobile behavior:

1. connect stream when opening a thread
2. if reconnect happens, resume with `Last-Event-ID` or `last_event_id` when your client supports it, then refetch the latest `/api/threads/:thread_id/messages?limit=100`
3. build one draft assistant row per `turn_id` from `agent.message_start` / `agent.message_delta`
4. treat `agent.message_done.text` as the final draft snapshot, not the canonical transcript row
5. during healthy connected turns, upsert `agent.tool_result.message` and `agent.message.message` directly into the transcript
6. replace the draft assistant row with `agent.message.message` when it arrives
7. treat `final` as completion/status, not as the only way to learn assistant/tool message ids
8. do not treat replayed SSE alone as the source of truth for the full transcript

### 9. `GET /api/models`

This route is authenticated and currently used by the web composer.

Example response:

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-5",
      "provider": "anthropic",
      "display_name": "Claude Sonnet 4.5",
      "capabilities": {
        "vision": true,
        "tools": true,
        "streaming": true,
        "reasoning": true,
        "thinking": true
      },
      "is_alias": true,
      "alias_target": "claude-sonnet-4-5-20250929"
    }
  ],
  "default_model": "claude-opus-4-5"
}
```

Web-specific behavior:

- web filters the list to aliases only if any aliases exist
- otherwise it shows all models
- web initializes the composer to `default_model` if that model exists in the filtered display list

Implication for mobile:

- if iOS wants exact parity with the current web selector, it should copy that alias-filtering behavior
- if not, iOS can keep this simpler and either:
  - show all models
  - pin one supported default
  - hide model selection in the first pass

### 10. `POST /api/runs`

This is a separate command-execution route.

It is not used by the current chat composer.

Request:

```json
{
  "bud_id": "b_01JQ7Y4S2E3JQ3JPN4C5A7W8M2",
  "cmd": "git status",
  "cwd": "/Users/adam/bud",
  "thread_id": "02d6b54c-34e2-4f6a-a29c-65f82dbb2bc0"
}
```

Response:

```json
{
  "run_id": "run_01JQ80TRG0XG3D58E6S5H8X2R9",
  "thread_id": "02d6b54c-34e2-4f6a-a29c-65f82dbb2bc0"
}
```

Use this only if mobile is explicitly building a command/run flow separate from the thread chat composer.

### 11. `GET /api/threads/:thread_id/runs`

This route returns run history for one thread and may be useful for future structured/block rendering.

Current behavior:

- paginated with `limit` and optional `cursor`
- includes stdout/stderr tail plus byte counters

It is not required for the first thread list/detail/send slice.

### 12. Terminal and session routes

These are available now but are not required for the first mobile chat slice.

#### Thread-scoped terminal routes

- `POST /api/threads/:thread_id/terminal`
- `POST /api/threads/:thread_id/terminal/ensure`
- `GET /api/threads/:thread_id/terminal`
- `GET /api/threads/:thread_id/terminal/stream`
- `GET /api/threads/:thread_id/terminal/history?bytes=<n>&since_offset=<n>`
- `POST /api/threads/:thread_id/terminal/input`
- `POST /api/threads/:thread_id/terminal/interrupt`
- `POST /api/threads/:thread_id/terminal/resize`

Important behaviors:

- sessions are thread-scoped, not Bud-scoped
- `POST /terminal` is create/get for the database session record only
- `POST /terminal/ensure` actually tries to make the session live on the Bud
- `/terminal/history` supports incremental backfill through `since_offset`

#### Bud-scoped session inventory

- `GET /api/buds/:bud_id/sessions`
- `DELETE /api/buds/:bud_id/sessions/:session_id`

Web-specific behavior:

- the web app exposes this via a modal, not the main chat view
- that modal explicitly treats sessions as "created when you visit a thread"

#### Cancel vs interrupt

These are distinct:

- `POST /api/threads/:thread_id/cancel` stops the active agent turn
- `POST /api/threads/:thread_id/terminal/interrupt` sends Ctrl+C to the terminal session

Mobile should not collapse these into one action unless product explicitly wants that.

## How The Current Web UI Actually Uses The Contract

These details matter because they explain behavior that may look surprising from the raw API alone.

### 1. Web is Bud-first, not thread-first

Current web navigation:

- `/` -> `GET /api/buds` -> redirect to first Bud
- `/$budId` loader -> `GET /api/buds` + `GET /api/threads?bud_id=<bud_id>`
- thread panel only shows threads for the selected Bud

This is a UI choice, not a backend limitation.

### 2. Web sorts threads client-side even though the server already sorts them

`GET /api/threads` is already ordered by `last_activity_at DESC`.

The thread panel sorts again client-side using:

- `last_activity_at`
- fallback to `created_at`

Mobile can rely on server order and skip the extra sort if it wants.

### 3. Web now consumes paged transcript windows

The current web thread route:

- fetches the latest message page with `limit=100`
- renders the returned `messages` array in its existing response order
- can prepend older history with `before=<page.before_cursor>` while preserving scroll anchor
- still keeps a local ascending sort in the timeline because it mixes canonical rows with temporary live SSE rows

For mobile, the simpler rule is:

- render `messages` in API order
- use `before` for older history

### 4. Web treats SSE as advisory, not canonical

For agent streaming, web:

- opens the agent stream on thread mount to catch in-progress turns
- replaces the optimistic user message id with the persisted `message_id` returned by `POST /messages`
- builds a temporary draft assistant row from `agent.message_start` / `agent.message_delta` / `agent.message_done`
- uses backend-provided `call_id`, `message_id`, and canonical `message` payloads to reconcile live tool/assistant rows
- replaces the draft assistant row with the canonical persisted assistant row from `agent.message`
- refetches `/messages` after reconnect

Current web behavior:

- those canonical latest-page refetches now preserve any older canonical pages already loaded in the session
- the remaining limitation is replay/resume behavior, not identifier drift on healthy connected turns

That is the safest model for mobile too.

### 5. New-thread send is two-step

Web does:

1. `POST /api/threads`
2. `POST /api/threads/:thread_id/messages`
3. navigate into the new thread

There is no one-request "new thread + first assistant turn" API today.

### 6. Web filters models to aliases when available

This is a presentation choice, not a backend rule.

### 7. Terminal sessions are created lazily

In web, terminal sessions are not eagerly created for all threads.

The thread view creates or retrieves the session row on entry by calling:

- `POST /api/threads/:thread_id/terminal`

Then it attaches terminal SSE and calls:

- `POST /api/threads/:thread_id/terminal/ensure`

That means:

- "thread exists" does not imply "terminal session exists yet"
- `has_terminal_session` in thread list is a real useful summary field

### 8. Thread delete is not purely local UI cleanup

`DELETE /api/threads/:thread_id` is a soft delete.

If a non-closed terminal session exists and the Bud is offline, the route can return `409`.

That is a real server contract, not just UI state.

## Recommended Mobile DTO Strategy

The current backend contract maps cleanly if mobile keeps a DTO/adaptation layer.

Recommended raw DTOs:

- `BudDTO`
- `ThreadSummaryDTO`
- `ThreadDTO`
- `MessageDTO`
- `AgentEventDTO`
- `ModelDTO`

Recommended app-level mapping:

- `bud` -> filter/picker metadata
- `thread` -> conversation summary/detail unit
- `message` -> canonical transcript rows
- `agent SSE events` -> transient live activity
- `terminal_session` -> later runtime/terminal tranche

## Recommended Mobile Flow

### App bootstrap

1. complete OAuth
2. call `GET /api/me`
3. if successful, fetch `GET /api/buds` and `GET /api/threads`

### Open thread

1. use existing thread summary from the list
2. fetch `GET /api/threads/:thread_id/messages?limit=100`
3. render the returned `messages` array in response order
4. if the user scrolls upward and `page.has_more_before` is true, request `before=<page.before_cursor>`
5. attach `GET /api/threads/:thread_id/agent/stream`

### Send message

1. optimistically render the user message locally if desired
2. `POST /api/threads/:thread_id/messages`
3. replace the optimistic user-row id with the returned `message_id`
4. keep agent stream attached
5. upsert `agent.tool_result.message` and `agent.message.message` as they arrive
6. replace the draft assistant row with `agent.message.message`
7. on reconnect, refetch `/messages`

### New thread

1. choose Bud locally
2. `POST /api/threads`
3. `POST /api/threads/:thread_id/messages`
4. enter the new thread detail screen
5. attach the same agent stream contract

## Known Gaps And Follow-Up Areas

These are known but not blockers for the first mobile chat tranche:

- no single combined thread-detail bootstrap route
- the current stream is a live turn stream, not a durable event journal
- logout/account-switch hosted-session behavior is a separate design topic
- terminal UX semantics are richer than the first mobile chat slice needs

## Related Docs

- [IOS_LOCAL_AUTH_HANDOFF.md](./IOS_LOCAL_AUTH_HANDOFF.md)
- [reference/AGENT_STREAM_EVENT_FIXTURES.md](./reference/AGENT_STREAM_EVENT_FIXTURES.md)
- [design/mobile-chat-thread-first-backend-contract.md](./design/mobile-chat-thread-first-backend-contract.md)
- [reference/IOS_CHAT_BACKEND_HANDOFF.md](./reference/IOS_CHAT_BACKEND_HANDOFF.md)
- [design/mobile-auth-logout-and-account-switch.md](./design/mobile-auth-logout-and-account-switch.md)
