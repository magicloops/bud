# iOS Feature-Complete Prototype Handoff

**Status:** Current consolidated handoff  
**Audience:** iOS, backend, web platform, product  
**Last updated:** 2026-03-22

## Purpose

This is the new primary handoff doc for the iOS team.

It consolidates and supersedes the mobile/backend contract material that was previously split across:

- [IOS_MOBILE_BACKEND_HANDOFF.md](./IOS_MOBILE_BACKEND_HANDOFF.md)
- [IOS_THREAD_MESSAGE_UX_BACKEND_RESPONSE.md](./IOS_THREAD_MESSAGE_UX_BACKEND_RESPONSE.md)

Use this document as the main reference for building a feature-complete iOS prototype against the current web/service stack.

Companion docs:

- [IOS_LOCAL_AUTH_HANDOFF.md](./IOS_LOCAL_AUTH_HANDOFF.md) for the local OAuth bundle and client setup
- [IOS_CHAT_STREAMING_DEBUG_HANDOFF.md](./IOS_CHAT_STREAMING_DEBUG_HANDOFF.md) for the earlier native SSE debugging conclusions
- [reference/AGENT_STREAM_EVENT_FIXTURES.md](./reference/AGENT_STREAM_EVENT_FIXTURES.md) for checked-in agent-stream examples
- [design/web-app-overview-and-ios-feature-parity.md](./design/web-app-overview-and-ios-feature-parity.md) for the broader product-parity framing

## Executive Summary

The backend now supports the core contract needed for a serious iOS prototype:

- bearer-authenticated mobile access via the Better Auth OAuth provider surface
- global thread-first list loading with `GET /api/threads`
- real cursor-paged message history with `before` / `after`
- true assistant text streaming with `agent.message_start`, `agent.message_delta`, and `agent.message_done`
- stable stream identifiers for transcript reconciliation (`turn_id`, `call_id`, `message_id`)
- thread-scoped terminal session creation, ensure, history, live SSE, input, interrupt, and resize
- Bud-level session inventory and close-session actions
- settings/account endpoints for profile, linked providers, and token revoke
- Bud claim endpoints that can support link-based phone approval

The current backend is therefore no longer the blocker for a feature-complete iOS prototype. The remaining major mobile-specific decisions are mostly UI decisions:

- thread-first home versus Bud-first navigation
- how to render draft assistant rows before canonical persistence
- how much of terminal interaction should be exposed on iPhone versus behind a dedicated tab/sheet

Known backend/product gaps still matter:

- bearer-mode sign-out is revoke plus local token clearing; it does not clear the hosted Better Auth browser session
- agent-stream replay is process-local and at-least-once, not a durable exactly-once resume protocol
- `system` transcript rows can appear even though the current web UI usually hides them
- the desktop `web` view is still a placeholder and is not parity-critical for iOS

## Product Model

Bud is not just a chat app.

The core model is:

1. a user owns one or more Buds
2. each Bud has many threads
3. each thread owns its own persistent terminal session
4. the message timeline can contain `user`, `assistant`, `tool`, and `system` rows

The mobile app may absolutely be thread-first in navigation, but it should not erase Bud context. A thread always belongs to one Bud, and the terminal session belongs to the thread, not to the Bud globally.

Important product truths:

- stopping an agent turn is not the same as interrupting the remote terminal
- canonical transcript history lives in `GET /api/threads/:thread_id/messages`
- live SSE is an augmentation layer, not the only source of truth
- terminal state and Bud online/offline state are first-class product signals, not debug-only metadata

## What iOS Can Change Versus Web

The current web UI is Bud-first in navigation because it is a desktop three-pane workspace.

iOS does not need to copy that layout.

Recommended translation for mobile:

- default home: global thread-first list from `GET /api/threads`
- keep Bud labels and Bud filtering available on that list
- keep a separate Bud inventory screen
- open each thread into a detail view with distinct `Chat` and `Terminal` modes
- keep settings, claim-link handling, and session management as secondary surfaces rather than permanent desktop chrome

iOS should preserve the product model, not the web shell.

## Core Contract Rules

### 1. Auth mode

The mobile app should use bearer auth as the canonical mode.

- send `Authorization: Bearer <access_token>` on REST and SSE requests
- use `GET /api/me` as the authenticated bootstrap request
- use `POST /api/me/oauth/revoke` plus local token clearing for bearer-mode sign-out

`POST /api/me/logout` is cookie-session-only and is mainly for the web app.

### 2. Ownership and errors

All Bud/thread/message/run/terminal routes are ownership-scoped.

- `401` means unauthenticated
- `404` means either not found or not owned by the current user
- list endpoints are already filtered server-side

### 3. Casing

Bud-owned request and response payloads are `snake_case`.

This includes:

- REST request bodies
- REST responses
- SSE payload fields
- Bud-session payloads

### 4. Transcript truth versus live stream

The current intended client model is:

- canonical transcript history from `GET /api/threads/:thread_id/messages`
- live in-flight augmentation from `GET /api/threads/:thread_id/agent/stream`
- canonical history refetch after reconnect or suspected drift

Do not treat SSE as a durable ledger.

### 5. Stop versus interrupt

These are different actions and should remain different in the UI.

- `POST /api/threads/:thread_id/cancel`
  Stops the current agent turn.
- `POST /api/threads/:thread_id/terminal/interrupt`
  Sends `Ctrl+C` to the thread terminal.

### 6. Known sign-out/account-switch limitation

Bearer-mode sign-out today is:

- revoke tokens
- clear local session state

It does not guarantee that the hosted browser session used during OAuth is cleared. That means account-switch testing can still reuse the last web-authenticated identity. This is a known product gap, not an iOS-only bug.

## Recommended iOS Prototype Scope

The iOS prototype is feature-complete when a signed-in user can do all of the following without returning to the web app:

| Area | Backend support now | Notes |
|---|---|---|
| Auth bootstrap | yes | `GET /api/me` |
| Bud inventory | yes | `GET /api/buds` |
| Thread-first home | yes | `GET /api/threads` across all owned Buds |
| Bud-filtered threads | yes | `GET /api/threads?bud_id=...` |
| Thread creation | yes | `POST /api/threads` then first message |
| Message history | yes | paged `GET /api/threads/:thread_id/messages` |
| Live assistant/tool activity | yes | `GET /api/threads/:thread_id/agent/stream` |
| Assistant token streaming | yes | `agent.message_delta` |
| Stop current turn | yes | `POST /api/threads/:thread_id/cancel` |
| Terminal visibility | yes | thread terminal REST + SSE surfaces |
| Terminal control | yes | input, interrupt, resize |
| Session management | yes | Bud-level session inventory + close |
| Settings/profile | yes | `/api/me/profile`, `/api/me/accounts`, `/api/me/sessions` |
| Provider-link start | yes | `/api/me/account-links/:provider/start` |
| Sign out | partial | revoke/local clear works; hosted-session logout gap remains |
| Device claim links | yes | claim-flow endpoints and web claim page exist |

## Recommended App Flows

### 1. App bootstrap

After sign-in:

1. `GET /api/me`
2. `GET /api/buds`
3. `GET /api/threads`
4. optionally `GET /api/models`

Use `/api/me` for auth gating, `/api/buds` for Bud labels/status/filtering, and `/api/threads` for the actual thread-first home UI.

### 2. Opening an existing thread

Recommended sequence:

1. start from the cached thread summary from `GET /api/threads`
2. `GET /api/threads/:thread_id/messages?limit=100`
3. attach `GET /api/threads/:thread_id/agent/stream`
4. if the thread exposes terminal UI immediately:
   - `POST /api/threads/:thread_id/terminal`
   - `POST /api/threads/:thread_id/terminal/ensure`
   - `GET /api/threads/:thread_id/terminal/history?bytes=4096`
   - attach `GET /api/threads/:thread_id/terminal/stream`

### 3. Loading older history

Use:

- `GET /api/threads/:thread_id/messages?limit=100&before=<page.before_cursor>`

The returned `messages` array is always oldest-to-newest inside the page. Prepend older pages above the existing timeline.

### 4. Sending a message

Recommended sequence:

1. optimistic local user row if desired
2. `POST /api/threads/:thread_id/messages`
3. render tool and assistant activity from the agent stream
4. replace draft/canonical rows using the backend-provided identifiers
5. on reconnect or suspected drift, refetch the latest `/messages` page

### 5. Creating a new thread

Current backend flow is two-step:

1. `POST /api/threads`
2. `POST /api/threads/:thread_id/messages`

There is no combined create-and-send endpoint.

### 6. Reconnect / recovery

For the agent stream and terminal stream:

- send `Last-Event-ID` or `last_event_id=<sse_id>` on reconnect when possible
- if the server still has that event in memory, only newer buffered events are replayed
- if the event is missing, the server falls back to live-only delivery
- after reconnect or any suspected mismatch, refetch canonical transcript history

### 7. Sign out

Current bearer-mode flow:

1. `POST /api/me/oauth/revoke`
2. clear locally stored access/refresh tokens
3. clear any iOS app session state

Do not assume this also clears the hosted web auth session.

## Primary Route Reference

### Auth And Settings

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/me` | current user bootstrap for cookie or bearer auth |
| `PATCH` | `/api/me/profile` | currently supports `username` |
| `GET` | `/api/me/accounts` | linked provider inventory |
| `GET` | `/api/me/sessions` | Better Auth browser-session inventory |
| `POST` | `/api/me/account-links/:provider/start` | returns provider authorization URL |
| `POST` | `/api/me/oauth/revoke` | bearer/public-client token revoke |
| `POST` | `/api/me/logout` | cookie-session logout only |

Important notes:

- bearer mode reports `session.id = null` in `GET /api/me`
- provider-link start behaves differently by auth mode:
  - cookie auth uses session-based linking
  - bearer auth uses same-email implicit sign-in/linking semantics

### Bud Inventory And Session Management

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/buds` | owned Bud list with `last_run` summary |
| `GET` | `/api/buds/:bud_id/sessions` | active thread terminal sessions for one Bud |
| `DELETE` | `/api/buds/:bud_id/sessions/:session_id` | closes one session |

`GET /api/buds` is for Bud labels, status, filter chips, and Bud-specific screens. It does not need to drive the default home layout.

`GET /api/buds/:bud_id/sessions` returns:

- `sessions[]` with `session_id`, `state`, `thread_id`, `thread_title`, `thread_deleted`, timestamps, and output byte counts
- `bud_online` at the top level

### Threads And Transcript History

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/threads` | global owned thread list |
| `GET` | `/api/threads?bud_id=<bud_id>` | Bud-filtered thread list |
| `POST` | `/api/threads` | create thread |
| `GET` | `/api/threads/:thread_id` | thread metadata |
| `DELETE` | `/api/threads/:thread_id` | soft delete thread |
| `GET` | `/api/threads/:thread_id/messages` | paged canonical transcript |
| `POST` | `/api/threads/:thread_id/messages` | create user message and start agent turn |
| `POST` | `/api/threads/:thread_id/cancel` | stop running agent turn |
| `GET` | `/api/threads/:thread_id/runs` | secondary run history surface |

### Thread list contract

`GET /api/threads` already supports thread-first mobile use.

Each row includes:

- `thread_id`
- `bud_id`
- `title`
- `created_at`
- `last_activity_at`
- `last_message_preview`
- `message_count`
- `pinned`
- `archived`
- `has_terminal_session`
- `session_state`
- `session_id`

That is enough to build a thread-first home UI with Bud badges and terminal-state chips.

### Message-history contract

`GET /api/threads/:thread_id/messages` supports:

```http
GET /api/threads/:thread_id/messages?limit=<1..200>
GET /api/threads/:thread_id/messages?limit=<1..200>&before=<opaque_cursor>
GET /api/threads/:thread_id/messages?limit=<1..200>&after=<opaque_cursor>
```

Rules:

- default `limit` is `100`
- max `limit` is `200`
- each returned page is ordered oldest-to-newest
- boundaries are exclusive
- cursors are opaque and derived from `(created_at, message_id)`
- response envelope is `{ messages, page }`

Important transcript facts:

- roles can be `user`, `assistant`, `tool`, or `system`
- `system` rows are real persisted rows and may appear during normal usage
- the current web UI hides `system` rows by default, but iOS does not need to
- tool rows can contain rich `metadata` that should be preserved in the DTO layer

### Agent Stream Contract

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/threads/:thread_id/agent/stream` | thread-scoped live agent SSE |

Current event family:

- `heartbeat`
- `agent.tool_call`
- `agent.tool_result`
- `agent.message_start`
- `agent.message_delta`
- `agent.message_done`
- `agent.message`
- `final`

### Current intended client model

- use `turn_id` as the per-turn draft key
- use `call_id` to correlate tool-call lifecycle
- use `message_id` and the embedded canonical `message` row to reconcile transcript state
- treat `agent.message_delta.delta` as a real assistant text chunk
- replace the draft assistant row with `agent.message.message` when it arrives
- treat `final` as the turn-completion signal; do not wait for EOF

### Success-path semantics

Typical successful order:

1. zero or more `agent.tool_call`
2. zero or more `agent.tool_result`
3. `agent.message_start`
4. one or more `agent.message_delta`
5. `agent.message_done`
6. `agent.message`
7. `final`

### Failure/cancel semantics

- failure and cancel still emit `final`
- failed/canceled turns may not emit `agent.message`
- if a draft assistant row exists and `final.status != "succeeded"`, clear or mark the draft appropriately

### Replay semantics

Replay is currently:

- process-local
- in-memory
- at-least-once
- not durable across restarts

Resume behavior:

- if `Last-Event-ID` or `last_event_id` hits an event still in the buffer, only newer events replay
- if the cursor is missing, the server falls back to live-only delivery
- the next turn clears the prior turn buffer at turn start

The stream is therefore useful for live UX and short reconnects, but canonical history is still the durable source of truth.

### Tool payload polish

Successful `agent.tool_result` payloads now include:

- `turn_id`
- `call_id`
- `message_id`
- `summary`
- `output`
- `output_bytes`
- `truncated`
- `output_truncation_reason`
- `message` with the canonical persisted tool row

Important truncation semantics:

- `terminal.run`
  `output_truncation_reason = "bud_runtime_limit"` when the Bud runtime truncated tool output
- `terminal.interrupt`
  `output_truncation_reason = "service_backfill_limit"` when the service-side backfill window truncated the tail
- `terminal.capture`
  currently reports `truncated: false` and `output_truncation_reason: null`

Use `summary` for compact UI. Do not derive collapsed tool labels from raw payloads unless you need a custom presentation.

### Terminal Contract

The terminal is thread-scoped and first-class.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/threads/:thread_id/terminal` | create or fetch session record |
| `POST` | `/api/threads/:thread_id/terminal/ensure` | ensure tmux session is running |
| `GET` | `/api/threads/:thread_id/terminal` | session metadata |
| `GET` | `/api/threads/:thread_id/terminal/history?bytes=<n>&since_offset=<n>` | output backfill |
| `GET` | `/api/threads/:thread_id/terminal/stream` | live terminal SSE |
| `POST` | `/api/threads/:thread_id/terminal/input` | send input |
| `POST` | `/api/threads/:thread_id/terminal/interrupt` | send `Ctrl+C` |
| `POST` | `/api/threads/:thread_id/terminal/resize` | send terminal size |

### Recommended thread-terminal bootstrap

1. `POST /api/threads/:thread_id/terminal`
2. `POST /api/threads/:thread_id/terminal/ensure`
3. `GET /api/threads/:thread_id/terminal/history?bytes=4096`
4. attach `GET /api/threads/:thread_id/terminal/stream`

### Important terminal behaviors

- `POST /terminal` can succeed even if the Bud is offline because it creates/fetches the DB row
- `POST /terminal/ensure` can return `503 terminal_unavailable` if the Bud is offline or not ready
- terminal history is separate from the live stream and is the recovery path for missed output
- `since_offset` is the current HTTP query contract for incremental history fetches

### Terminal-history response

`GET /api/threads/:thread_id/terminal/history` returns:

```json
{
  "session_id": "sess_01...",
  "bytes": 4096,
  "total_bytes_available": 16384,
  "data_base64": "..."
}
```

### Terminal SSE event family

`GET /api/threads/:thread_id/terminal/stream` emits:

- `terminal.output`
- `terminal.status`
- `terminal.ready`
- `terminal.bud_offline`
- `terminal.bud_online`
- `heartbeat`

Important payload notes:

- `terminal.output` carries `seq`, `data`, and `byte_offset`
- `terminal.ready` carries `{ assessment }`
- `terminal.status` carries `{ state, info }`
- `terminal.bud_offline` and `terminal.bud_online` use `bud_id` in snake_case

This is enough to build a real terminal tab or a lighter “terminal status plus recent output” view on iPhone.

### Models And Secondary Run Surface

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/models` | authenticated model inventory |
| `POST` | `/api/runs` | secondary standalone command flow |

`GET /api/models` returns:

- `default_model`
- `models[]`

Each model row includes:

- `id`
- `provider`
- `display_name`
- `capabilities.vision`
- `capabilities.tools`
- `capabilities.streaming`
- `capabilities.reasoning`
- `capabilities.thinking`
- optional `is_alias`
- optional `alias_target`

For the current prototype, `/api/models` matters more than `/api/runs`. The thread chat flow is the primary product surface.

### Device Claim Flow

The web/service stack already supports phone-friendly Bud claiming.

Daemon-facing endpoints:

- `POST /api/device-auth/start`
- `POST /api/device-auth/poll`

Public/browser-facing endpoints:

- `GET /api/device-auth/flows/:flow_id`
- `POST /api/device-auth/flows/:flow_id/approve`

Current product model:

1. the daemon starts the flow
2. the service returns a claim URL and QR payload
3. the human opens the claim link on phone
4. the phone authenticates if needed
5. the approval endpoint links or creates the Bud
6. the daemon polls until it receives the issued `device_secret`

For the iOS prototype, acceptable approaches are:

- open the existing hosted claim URL and let the web claim page handle the UX
- or implement a native claim screen using the public flow read/approve endpoints

Either way, the app should treat claim-link handling as part of feature-complete product scope.

## Web Behavior That Matters To iOS

These are current web behaviors worth preserving conceptually:

- the home experience is authenticated even when the user has zero Buds
- thread rows surface terminal/session state, not just message text
- tool rows render in compact collapsed form by default
- long assistant output is streamed and then reconciled to canonical persisted history
- terminal and chat are peer surfaces inside a thread workspace
- session management exists as a secondary Bud-level control surface

These current web details are not parity-critical:

- the desktop three-pane layout
- the left Bud rail
- the placeholder `web` tab/view
- the neobrutalist styling itself
- dev-only debug UI

## Known Gaps And Gotchas

### 1. Hosted logout/account switching is still incomplete

Mobile revoke/local-clear does not guarantee hosted-session logout. This mainly affects repeated provider/account-switch testing and should be treated as a known limitation for now.

### 2. Agent replay is not durable

Replay works best for short reconnects against the same live service process. It is not a durable stream-resume protocol across restarts.

### 3. `system` rows can appear unexpectedly

Pre-flight terminal context sync can insert `system` rows into transcript history even though the current web UI often hides them.

### 4. Thread titles do not auto-update on send

Current automatic metadata updates affect:

- `last_activity_at`
- `last_message_preview`
- `message_count`

Do not expect normal send/stream completion to rewrite `thread.title`.

### 5. Deleting a thread can fail while a Bud is offline

If the thread still has an active terminal session and the Bud is offline, delete can return a conflict instead of forcing server-side cleanup blindly.

## Recommended Implementation Order For iOS

1. auth bootstrap
2. Bud inventory + thread-first home list
3. thread detail with paged transcript
4. agent stream draft/canonical reconciliation
5. send + cancel
6. terminal tab with history + live SSE + interrupt
7. Bud session management
8. settings/profile/provider surfaces
9. claim-link handling

That order matches the current backend maturity and should get the mobile team to a feature-complete prototype without depending on unresolved product gaps.
