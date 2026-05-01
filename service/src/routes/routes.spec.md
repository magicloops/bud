# routes

HTTP API route handlers using Fastify.

## Purpose

Defines REST API endpoints for managing buds, threads, messages, terminal sessions, the authenticated current-user surface, browser-mediated Bud device claims, and Phase 4 proxy/file sessions. All routes are prefixed with `/api/`.

All browser-facing Bud/thread/message/terminal routes now require an authenticated viewer and resolve resources through ownership checks. Cross-user resource access returns `404`, while `401` is reserved for missing browser auth.

## Files

### `device-auth.ts`

Bud bootstrap endpoints for QR/link device claims.

**Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/device-auth/start` | Start a pending device claim and return claim URL + poll secret |
| `POST` | `/api/device-auth/poll` | Bud-only polling endpoint for claim approval + secret delivery |
| `GET` | `/api/device-auth/flows/:flowId` | Public claim-page read surface with safe device metadata |
| `POST` | `/api/device-auth/flows/:flowId/approve` | Authenticated browser approval endpoint |

**Behavior**:
- `start` persists requested device metadata plus `installation_id`
- `poll` never exposes Bud secrets to the browser; only the daemon can retrieve `device_secret`
- `approve` reuses an existing `bud_id` when `installation_id` already belongs to the same user
- conflicting claims (`installation_id` already owned by another user) are rejected with `installation_claim_conflict`

### `buds.ts`

Bud management and session listing.

**Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/buds` | List the signed-in user's buds |
| `GET` | `/api/buds/:bud_id/sessions` | List active terminal sessions for an owned bud |
| `DELETE` | `/api/buds/:bud_id/sessions/:session_id` | Close a specific session on an owned bud |

**Key Functions**:
- `normalizeCapabilities(raw)` - Ensure capabilities is an object
- `serializeBud(bud)` - Convert DB row to API response format

**Authorization**:
- All Bud routes call `requireViewer(...)`
- Bud-scoped routes resolve ownership through `getAuthorizedBud(...)`
- Session inventory is filtered to `terminal_session.created_by_user_id = viewer.userId`
- Closing a session marks that specific row closed; revisiting the thread later creates a new active session row

### `buds.test.ts`

Direct registration coverage for the Bud route family.

**Current Coverage**:
- the Bud inventory and Bud-session routes still register after the legacy `last_run` dependency removal

### `threads.ts`

Thin composition root for the split thread-route family.

Registers the route groups now implemented under [threads/threads.spec.md](./threads/threads.spec.md).

### `me.test.ts`

Focused route-handler coverage for the current-user notification and push-endpoint routes.

**Current Coverage**:
- notifications summary returns badge-ready unseen-thread counts
- push endpoint upsert writes owned defaults and returns the normalized registration payload
- push endpoint upsert accepts the production and staging Bud APNs topics and rejects unknown APNs topics
- deleting an unknown owned push endpoint returns the expected `404 push_endpoint_not_found`

### `threads/` → [threads/threads.spec.md](./threads/threads.spec.md)

Ownership-focused thread submodules:
- core thread CRUD
- message history/create
- read-watermark updates for unread-attention state
- agent state/stream/cancel
- terminal create/ensure/input/history/stream
- user-clicked file viewer session creation

**Thread Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/threads` | List the signed-in user's threads (optionally filtered by owned `bud_id`) |
| `POST` | `/api/threads` | Create a new owned thread on an owned bud |
| `GET` | `/api/threads/:thread_id` | Get owned thread details |
| `PATCH` | `/api/threads/:thread_id/model-preference` | Persist the owned thread's concrete model/reasoning selection |
| `DELETE` | `/api/threads/:thread_id` | Soft delete an owned thread |

**Message Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/threads/:thread_id/messages` | Get owned messages with cursor pagination (`limit`, optional `before` / `after`) |
| `POST` | `/api/threads/:thread_id/messages` | Send a user-owned message (with context sync), triggers agent |
| `POST` | `/api/threads/:thread_id/read` | Advance the viewer's read watermark to a specific owned transcript row |
| `GET` | `/api/threads/:thread_id/agent/state` | Get the owned best-effort in-flight runtime snapshot for the thread |
| `GET` | `/api/threads/:thread_id/agent/stream` | SSE for owned agent events |
| `POST` | `/api/threads/:thread_id/cancel` | Cancel an owned running agent |

**Thread File Viewer Endpoint**:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/threads/:thread_id/files/open` | Create a short-lived owned file session from a user-clicked relative path in the thread transcript |

**Terminal Endpoints** (Thread-Scoped):

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/threads/:thread_id/terminal` | Create/get the active owned terminal session (DB only); creates a fresh session if prior ones are closed |
| `POST` | `/api/threads/:thread_id/terminal/ensure` | Ensure the owned terminal is running on bud |
| `GET` | `/api/threads/:thread_id/terminal` | Get owned session info |
| `GET` | `/api/threads/:thread_id/terminal/stream` | SSE output stream for an owned session |
| `POST` | `/api/threads/:thread_id/terminal/input` | Send input as the signed-in human user |
| `POST` | `/api/threads/:thread_id/terminal/interrupt` | Send human Ctrl+C, reject older pending terminal waits as interrupted, and return dispatch metadata |
| `POST` | `/api/threads/:thread_id/terminal/resize` | Resize an owned terminal |
| `GET` | `/api/threads/:thread_id/terminal/history` | Get owned output history (`bytes`, optional `since_offset`) |

**Validation Schemas** (Zod):
- `CreateThreadSchema` - `bud_id` required, `title` optional, optional `model` / `reasoning_effort` accepted for initial thread preference persistence
- `CreateMessageSchema` - `text` required, `client_id` optional UUID, `cwd`, `model`, and broad `reasoning_effort` optional; selected model/reasoning semantics are validated against the LLM catalog before an agent turn starts
- `UpdateThreadModelPreferenceSchema` - optional raw `model` / `reasoning_effort` fields parsed before catalog validation; the route requires a non-null model and persists the resolved concrete pair
- `MarkThreadReadSchema` - `last_seen_message_id` required UUID
- `ThreadParamsSchema` - UUID validation
- `MessagesQuerySchema` - `limit` plus exclusive `before` / `after` opaque cursors
- `TerminalEnsureBodySchema` - Optional `shell`, `cwd`, `cols`, `rows`
- `TerminalResizeBodySchema` - Required `cols`, `rows`
- `TerminalInputBodySchema` - Required `input`
- `OpenThreadFileBodySchema` - Required relative `path`, optional source metadata, optional line/column, and first-pass `viewer_intent: "preview"`

**Message History Contract**:
- `GET /api/threads/:thread_id/messages` now returns an envelope: `{ messages, page }`
- page results are always ordered oldest-to-newest within the returned window
- cursors are opaque but derived from `(created_at, message_id)` so tied timestamps remain stable
- persisted transcript rows now expose required `client_id` alongside `message_id`
- `before` requests older history than the cursor boundary (exclusive)
- `after` requests newer history than the cursor boundary (exclusive)
- the latest-page request is `GET /api/threads/:thread_id/messages?limit=<n>` with no cursor
- page metadata includes `has_more_before`, `has_more_after`, `before_cursor`, `after_cursor`, `returned`, and `limit`

**Agent Stream Contract**:
- `GET /api/threads/:thread_id/agent/state` returns the current best-effort runtime snapshot with `active`, `turn_id`, `phase`, `can_cancel`, `stream_cursor`, `pending_tool`, `draft_assistant`, and `updated_at`
- `pending_tool` now carries `client_id` and `started_at` in addition to `call_id`, `name`, and `args`
- `draft_assistant` now carries `client_id` in addition to `text` and `updated_at`
- `GET /api/threads/:thread_id/agent/stream` emits `agent.message_start`, `agent.message_delta`, `agent.message_done`, `agent.tool_call`, `agent.tool_result`, `agent.message`, `thread.title`, `agent.resync_required`, `final`, and `heartbeat`
- agent payloads include a per-turn `turn_id`
- assistant draft events now include top-level `client_id`
- assistant draft events are client-side only; the persisted assistant row still arrives later as `agent.message`
- tool events expose the real `call_id` plus top-level `client_id`
- `agent.tool_call` now includes service-side `started_at`
- `agent.tool_result` exposes a compact `summary` and explicit `output_truncation_reason` alongside the canonical persisted tool row
- `agent.tool_result` now also exposes `started_at`, `finished_at`, and `duration_ms`
- successful `agent.tool_result` / `agent.message` payloads include the persisted canonical transcript row under `message`
- those embedded canonical assistant/tool rows reuse the same `client_id` already exposed by the earlier runtime and stream payloads
- embedded canonical tool rows now expose the same timing fields under `message.metadata`, while tool `message.content` remains the replay payload without timing-only fields
- `agent.message_done` carries the full draft assistant text just before canonical persistence
- `agent.message` may now arrive for an intermediate visible assistant text segment before later tool calls; the embedded `message.metadata.segment_kind` distinguishes `intermediate` from `final`
- `final` still marks completion, but the stream remains attached; the route no longer relies on attach-time replay to bootstrap the next turn
- no-cursor attaches are live-only; they do not replay buffered `agent.*` or `final`
- bounded replay can resume from `after=<cursor>`, the standard `Last-Event-ID` header, or the optional `last_event_id` query parameter
- the SSE frame `id:` is the opaque runtime cursor used for bounded replay
- when the provided resume cursor is still in the bounded in-memory window, only newer buffered events replay
- when the resume cursor is missing, the route emits `agent.resync_required` and the client should refetch `/messages` plus `/agent/state`

**Message History Examples**:

Latest page:
```json
{
  "messages": [
    {
      "message_id": "6c06d627-9043-4d71-a9cc-8b35ef3f7c59",
      "client_id": "0195d4d2-3ef4-74a7-9a40-9c4bb0b7fd1c",
      "role": "assistant",
      "display_role": "Assistant",
      "content": "Latest reply",
      "metadata": {},
      "created_at": "2026-03-22T20:15:04.000Z"
    },
    {
      "message_id": "4b6d4e04-c407-49b0-9738-80985d95cf9b",
      "client_id": "0195d4d2-42ef-7266-99ff-2fa4d4dc2ff2",
      "role": "user",
      "display_role": "User",
      "content": "Newest prompt",
      "metadata": {},
      "created_at": "2026-03-22T20:15:09.000Z"
    }
  ],
  "page": {
    "limit": 2,
    "returned": 2,
    "has_more_before": true,
    "has_more_after": false,
    "before_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wMy0yMlQyMDoxNTowNC4wMDBaIiwibWVzc2FnZV9pZCI6IjZjMDZkNjI3LTkwNDMtNGQ3MS1hOWNjLThiMzVlZjNmN2M1OSJ9",
    "after_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wMy0yMlQyMDoxNTowOS4wMDBaIiwibWVzc2FnZV9pZCI6IjRiNmQ0ZTA0LWM0MDctNDliMC05NzM4LTgwOTg1ZDk1Y2Y5YiJ9"
  }
}
```

Older page via `before`:
```json
{
  "messages": [
    {
      "message_id": "d7d8f7e8-2947-4ba4-91d9-c5f2966d661f",
      "client_id": "0195d4d2-1f15-7095-9cfe-0b87a8b6fd3d",
      "role": "user",
      "display_role": "User",
      "content": "Older prompt",
      "metadata": {},
      "created_at": "2026-03-22T20:14:01.000Z"
    }
  ],
  "page": {
    "limit": 2,
    "returned": 1,
    "has_more_before": false,
    "has_more_after": true,
    "before_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wMy0yMlQyMDoxNDowMS4wMDBaIiwibWVzc2FnZV9pZCI6ImQ3ZDhmN2U4LTI5NDctNGJhNC05MWQ5LWM1ZjI5NjZkNjYxZiJ9",
    "after_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wMy0yMlQyMDoxNDowMS4wMDBaIiwibWVzc2FnZV9pZCI6ImQ3ZDhmN2U4LTI5NDctNGJhNC05MWQ5LWM1ZjI5NjZkNjYxZiJ9"
  }
}
```

Empty response at the beginning of history:
```json
{
  "messages": [],
  "page": {
    "limit": 2,
    "returned": 0,
    "has_more_before": false,
    "has_more_after": true,
    "before_cursor": null,
    "after_cursor": null
  }
}
```

**Context Sync Flow** (POST /messages):
Before creating user message, validates the selected LLM model/reasoning pair and then checks for terminal state changes:
1. Resolve explicit `model` / `reasoning_effort`, otherwise use the stored thread selection, otherwise the service default (`gpt-5.5` + `low`)
2. Return `400 invalid_model` or `400 invalid_reasoning_effort` before duplicate handling, context sync, message insert, thread preference persistence, or agent start when the submitted selection is unsupported
3. Duplicate owned `client_id` retries return the existing user message without mutating the thread preference
4. Fresh explicit selections, missing old thread selections, and invalid stored selections update `thread.model_id` / `thread.reasoning_effort` to the resolved concrete pair
5. If thread has active terminal session and no active agent run
6. Call `contextSyncService.checkAndSync(sessionId, threadId, ownerUserId)`
7. If state changed, a system message is injected before the user message
8. This keeps the agent informed about terminal state transitions (e.g., REPL exit)

**First-Message Title Flow** (POST /messages):
- after the durable user row is written and the agent turn is successfully started, the route launches a fire-and-forget thread-title task
- the task only proceeds when the just-written row is still the canonical first user message on the thread and `thread.title` is still `NULL`
- successful title writes emit `thread.title` on the same `/agent/stream` channel and use the same bounded replay cursor space as the agent events

**Ownership Enforcement**:
- `requireAuthorizedThreadAccess(...)` gates thread/message/terminal routes
- thread lists filter to `thread.created_by_user_id = viewer.userId`
- message reads also filter by their row-level owner columns
- new thread/message/session rows are stamped with the acting or owning user id
- terminal input writes `terminal_session_input_log.user_id` for human-originated input
- SSE routes authorize before attaching listeners, so cross-user clients never attach buffered streams
- terminal interrupt is authorized at the same thread boundary as terminal input/stream/history and returns `404 no_terminal_session` when no active owned session exists
- thread file-open is authorized at the same thread boundary, derives the Bud from the owned thread, creates `file_session.created_by_user_id` for the acting viewer, and returns `404 thread_not_found` for signed-in non-owners
- thread SSE routes send an initial heartbeat frame on empty-buffer/live-only attaches so the HTTP response stays in SSE mode even before the first real event arrives
- `POST /api/threads` now returns `{ thread_id }`
- `POST /api/threads/:thread_id/messages` now accepts optional `client_id`
- duplicate user-message retries with the same owned-thread `client_id` short-circuit with `200 { message_id, client_id }` and do not launch a second agent turn
- fresh user-message writes return `201 { message_id, client_id }`
- `POST /api/threads/:thread_id/read` only advances the watermark forward and ignores stale or duplicate rewinds
- `GET /api/threads/:thread_id/agent/stream` may also emit `thread.title { thread_id, title, source, updated_at }`

### `me.ts`

Authenticated current-user endpoint backed by shared cookie-or-token auth helpers.

**Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/me` | Return normalized user/session/profile/account-linking state for either cookie or bearer auth |
| `GET` | `/api/me/notifications/summary` | Return the current unseen-thread badge count for the signed-in user |
| `PUT` | `/api/me/push/endpoints/:installation_id` | Upsert an owned push endpoint registration |
| `DELETE` | `/api/me/push/endpoints/:installation_id` | Delete an owned push endpoint registration |
| `PATCH` | `/api/me/profile` | Update the signed-in user's Bud-owned profile fields for either cookie or bearer auth |
| `GET` | `/api/me/accounts` | Return linked-provider account inventory for either cookie or bearer auth |
| `GET` | `/api/me/sessions` | Return Better Auth browser-session inventory for the current user |
| `POST` | `/api/me/account-links/:provider/start` | Start a provider-link flow for GitHub/Google and return the authorization URL |
| `POST` | `/api/me/logout` | Sign out the current Better Auth browser session |
| `POST` | `/api/me/oauth/revoke` | Revoke an OAuth access or refresh token through Bud's auth surface |

**Response Shape**:
- `user` - Better Auth user identity (`id`, `email`, `email_verified`, `name`, `image`)
- `auth_type` - `cookie` or `bearer`
- `session` - Current session/token metadata (`id`, `expires_at`); bearer mode reports `id: null`
- `profile` - Bud-owned profile metadata (`username`, timestamps)
- `linked_accounts` / `linked_providers` - Provider-linking summary for settings/account UI

**Profile Updates**:
- `PATCH /api/me/profile` currently supports `username`
- input is validated and normalized through `auth/session.ts`
- invalid usernames return `400 invalid_username`
- uniqueness conflicts return `409 username_taken`

**Native Account Surface**:
- `GET /api/me/accounts` returns linked account rows from `auth.account` with snake_case metadata, scopes, and token-presence flags
- `GET /api/me/notifications/summary` returns `{ unseen_thread_count, updated_at }`, where the count is the number of owned threads whose latest attention-worthy output is newer than the viewer's read watermark
- `PUT /api/me/push/endpoints/:installation_id` upserts one owned device-install registration with provider metadata, endpoint token, and per-kind delivery preferences
- APNs endpoint registration only accepts configured Bud topics, defaulting to `chat.bud.app` and `chat.bud.app.staging`; unknown APNs `app_id` values return `400 invalid_app_id`
- push endpoint registration removes stale rows for the same provider token or installation id when they belong to another user, so account switches cannot leave the prior account with a deliverable endpoint
- `DELETE /api/me/push/endpoints/:installation_id` removes one owned device-install registration and returns `404` for unknown install ids owned by the signed-in user
- `GET /api/me/sessions` returns the user's Better Auth browser sessions with `is_current` and `is_active` markers
- `POST /api/me/account-links/:provider/start` returns a snake_case Bud-owned payload:
  - cookie auth uses Better Auth `linkSocialAccount` (`strategy: "session_link"`)
  - bearer auth uses Better Auth `signInSocial` with `requestSignUp: false` to rely on implicit same-email linking (`strategy: "implicit_sign_in"`)
- bearer-mode provider-link starts are therefore limited to existing-account / same-email linking semantics; they are not a replacement for explicit cookie-session account-linking
- `POST /api/me/logout` currently signs out cookie-backed browser sessions only
- `POST /api/me/oauth/revoke` wraps Better Auth's `/oauth2/revoke` endpoint behind a Bud route so mobile clients do not need to call Better Auth directly
- mobile/public-client revoke callers must send `client_id`; bearer logout is revocation + local token clearing rather than cookie-session sign-out

**Dependencies**:
- `../auth/session.js` - Shared viewer resolution and `user_profile` bootstrap
- `./device-auth.ts` - Uses the same browser session model for claim approval

### `models.ts`

Available LLM model listing for authenticated product clients.

**Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/models` | Return model inventory for the authenticated viewer |

### `models.test.ts`

Route-level coverage for the catalog-backed model inventory.

**Current Coverage**:
- configured Anthropic/OpenAI providers return the sorted product catalog
- response includes `service_default_model`, `default_model`, and `default_reasoning_effort`
- response includes per-model `reasoning` metadata
- response omits a public `available` flag

**Auth Notes**:
- now uses the shared `requireViewer(...)` contract instead of remaining public
- returns a normalized snake_case payload so web and mobile share one contract
- top-level response includes `service_default_model`, `default_model`, and `default_reasoning_effort`
- model entries are sourced from `service/src/llm/model-catalog.ts` and filtered to configured providers
- model entries expose product `id`, `provider`, `provider_model`, `display_name`, `is_default`, capability limits, and model-specific `reasoning`
- `reasoning.levels` is the client source of truth for valid `reasoning_effort` values
- no `available` flag is emitted; configured catalog entries are treated as live

### `proxy.ts`

Phase 4.2 localhost proxy session and edge routes.

**Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/buds/:budId/proxy-sessions` | Create a short-lived owned proxy session for `http://127.0.0.1:<port>` |
| `GET` | `/api/buds/:budId/proxy-sessions` | List owned proxy sessions for an owned Bud |
| `GET` | `/api/proxy-sessions/:proxySessionId` | Read one owned proxy session |
| `DELETE` | `/api/proxy-sessions/:proxySessionId` | Revoke one owned proxy session |
| `GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS` | `/api/proxy/:proxySessionId/*` | Authorize the owned proxy session; stream `GET`/`HEAD` through the daemon over the selected WebSocket/HTTP2 data-plane carrier; fail closed for unsupported methods, missing transport, or service limits |

**Security Notes**:
- all routes call `requireViewer(...)`
- Bud-scoped create/list routes resolve ownership through `getAuthorizedBud(...)`
- optional `thread_id` on create must belong to the same viewer and Bud
- session reads/revokes filter by `proxy_session.created_by_user_id` in SQL
- proxy targets are limited to explicit `127.0.0.1` plus an explicit port
- proxy sessions report degraded state when no active carrier has `localhost_http_proxy` support; the edge returns `424` instead of opening daemon work
- proxy transport payloads include selected-carrier health and skipped candidate reasons so operators can diagnose WebSocket/H2/QUIC fallback without route-specific branches
- the edge route supports `GET` and `HEAD` in Phase 4.2; other allowed methods still return `501 proxy_method_not_implemented`
- each proxied request creates durable `bud_operation` / `bud_stream` rows before sending daemon `proxy_open`
- proxied requests enforce owner checks before stream registration plus per-Bud concurrency, max response bytes, chunk/credit, idle, and TTL limits

### `proxy.test.ts`

Route-registration and route-auth coverage for the Phase 4.2 proxy session and edge route family, including unauthenticated `401`, signed-in non-owner `404`, and owned session serialization.

### `files.ts`

Phase 4.4 file session and daemon-backed file edge routes.

**Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/buds/:budId/file-sessions` | Create a short-lived owned file session for a workspace-relative path |
| `GET` | `/api/buds/:budId/file-sessions` | List owned file sessions for an owned Bud |
| `GET` | `/api/file-sessions/:fileSessionId` | Read one owned file session |
| `DELETE` | `/api/file-sessions/:fileSessionId` | Revoke one owned file session |
| `GET/HEAD` | `/api/files/:fileSessionId` | Authorize an owned file session and selected stat/read/range permission, then stream stat/read/range work through daemon `file_open` over the selected WebSocket/HTTP2 data-plane carrier |

**Security Notes**:
- all routes call `requireViewer(...)`
- Bud-scoped create/list routes resolve ownership through `getAuthorizedBud(...)`
- optional `thread_id` on create must belong to the same viewer and Bud
- session reads/revokes filter by `file_session.created_by_user_id` in SQL
- file sessions are limited to the `workspace` root key and POSIX-style root-relative paths with no traversal segments
- permissions default to `stat`, `read`, and `range`; `range` implies `read`, and `read` implies `stat`
- file sessions report degraded state when no active carrier has `file_read` support
- file transport payloads include selected-carrier health and skipped candidate reasons so operators can diagnose WebSocket/H2/QUIC fallback without route-specific branches
- ready sessions support `HEAD`, full `GET`, and single-byte-range `GET` by sending `file_open` over the selected control side and streaming bytes from the selected data-plane carrier
- file reads enforce owner checks before stream registration plus per-Bud concurrency, max bytes, chunk/credit, idle, and TTL limits
- daemon re-checks workspace root/path, symlink, regular-file, max-byte, and content-identity policy before sending bytes

### `files.test.ts`

Route-registration and route-auth coverage for the Phase 4 file session and edge route family, including unauthenticated `401`, signed-in non-owner `404`, and owned session serialization.

**Model Response Shape**:
```json
{
  "models": [
    {
      "id": "claude-opus-4-7",
      "provider": "anthropic",
      "provider_model": "claude-opus-4-7",
      "display_name": "Claude Opus 4.7",
      "is_default": false,
      "capabilities": {
        "vision": true,
        "tools": true,
        "streaming": true,
        "structured_outputs": false,
        "context_window_tokens": 1000000,
        "max_output_tokens": 128000
      },
      "reasoning": {
        "kind": "anthropic_output_effort",
        "levels": [
          { "value": "low", "label": "Low" },
          { "value": "medium", "label": "Medium" },
          { "value": "high", "label": "High" },
          { "value": "xhigh", "label": "Extra high" },
          { "value": "max", "label": "Max" }
        ],
        "default_level": "xhigh"
      }
    }
  ],
  "service_default_model": "gpt-5.5",
  "default_model": "gpt-5.5",
  "default_reasoning_effort": "low"
}
```

## Response Formats

**Thread Response**:
```json
{
  "thread_id": "uuid",
  "bud_id": "string",
  "title": "string | null",
  "created_at": "ISO date",
  "last_activity_at": "ISO date",
  "last_message_preview": "string | null",
  "message_count": 0,
  "pinned": false,
  "archived": false,
  "model": "gpt-5.5",
  "reasoning_effort": "low",
  "effective_model": "gpt-5.5",
  "effective_reasoning_effort": "low",
  "model_selection_source": "thread",
  "has_unseen_attention": true,
  "last_attention_kind": "assistant_completed | human_input_requested | null",
  "has_terminal_session": true,
  "session_state": "ready",
  "session_id": "string | null"
}
```

**Message Response**:
```json
{
  "message_id": "uuid",
  "client_id": "uuidv7",
  "role": "user | assistant | tool | system",
  "display_role": "string",
  "content": "string",
  "metadata": {},
  "created_at": "ISO date"
}
```

**Create Message Response**:
```json
{
  "message_id": "uuid",
  "client_id": "uuidv7"
}
```

**Message Page Response**:
```json
{
  "messages": [
    {
      "message_id": "uuid",
      "client_id": "uuidv7",
      "role": "user | assistant | tool | system",
      "display_role": "string",
      "content": "string",
      "metadata": {},
      "created_at": "ISO date"
    }
  ],
  "page": {
    "limit": 100,
    "returned": 100,
    "has_more_before": true,
    "has_more_after": false,
    "before_cursor": "opaque cursor",
    "after_cursor": "opaque cursor"
  }
}
```

## Dependencies

| Import | Purpose |
|--------|---------|
| `fastify` | Request/reply types |
| `zod` | Request validation |
| `drizzle-orm` | Query helpers |
| `../db/client.js` | Database access |
| `../db/message-client-id.js` | UUIDv7 generation for persisted user-message `client_id` values |
| `../db/schema.js` | Table schemas |
| `../agent/index.js` | Agent service |
| `../runtime/*.js` | Manager classes |
| `../ws/gateway.js` | Bud status helpers |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
