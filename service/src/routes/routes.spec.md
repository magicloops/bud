# routes

HTTP API route handlers using Fastify.

## Purpose

Defines REST API endpoints for managing buds, threads, messages, runs, terminal sessions, the authenticated current-user surface, and browser-mediated Bud device claims. All routes are prefixed with `/api/`.

All browser-facing Bud/thread/run/terminal routes now require an authenticated viewer and resolve resources through ownership checks. Cross-user resource access returns `404`, while `401` is reserved for missing browser auth.

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
| `GET` | `/api/buds` | List the signed-in user's buds with last run info |
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

### `threads.ts`

Thread and message management, plus terminal operations (~900 lines).

**Thread Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/threads` | List the signed-in user's threads (optionally filtered by owned `bud_id`) |
| `POST` | `/api/threads` | Create a new owned thread on an owned bud |
| `GET` | `/api/threads/:thread_id` | Get owned thread details |
| `DELETE` | `/api/threads/:thread_id` | Soft delete an owned thread |

**Message Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/threads/:thread_id/messages` | Get owned messages with cursor pagination (`limit`, optional `before` / `after`) |
| `POST` | `/api/threads/:thread_id/messages` | Send a user-owned message (with context sync), triggers agent |
| `GET` | `/api/threads/:thread_id/agent/state` | Get the owned best-effort in-flight runtime snapshot for the thread |
| `GET` | `/api/threads/:thread_id/agent/stream` | SSE for owned agent events |
| `POST` | `/api/threads/:thread_id/cancel` | Cancel an owned running agent |

**Run Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/threads/:thread_id/runs` | Get owned run history with cursor pagination |

**Terminal Endpoints** (Thread-Scoped):

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/threads/:thread_id/terminal` | Create/get the active owned terminal session (DB only); creates a fresh session if prior ones are closed |
| `POST` | `/api/threads/:thread_id/terminal/ensure` | Ensure the owned terminal is running on bud |
| `GET` | `/api/threads/:thread_id/terminal` | Get owned session info |
| `GET` | `/api/threads/:thread_id/terminal/stream` | SSE output stream for an owned session |
| `POST` | `/api/threads/:thread_id/terminal/input` | Send input as the signed-in human user |
| `POST` | `/api/threads/:thread_id/terminal/interrupt` | Send Ctrl+C to an owned session |
| `POST` | `/api/threads/:thread_id/terminal/resize` | Resize an owned terminal |
| `GET` | `/api/threads/:thread_id/terminal/history` | Get owned output history (`bytes`, optional `since_offset`) |

**Validation Schemas** (Zod):
- `CreateThreadSchema` - `bud_id` required, `title` optional
- `CreateMessageSchema` - `text` required, `client_id` optional UUID, `cwd` and `reasoning_effort` optional
- `ThreadParamsSchema` - UUID validation
- `MessagesQuerySchema` - `limit` plus exclusive `before` / `after` opaque cursors
- `TerminalEnsureBodySchema` - Optional `shell`, `cwd`, `cols`, `rows`
- `TerminalResizeBodySchema` - Required `cols`, `rows`
- `TerminalInputBodySchema` - Required `input`

**Message History Contract**:
- `GET /api/threads/:thread_id/messages` now returns an envelope: `{ messages, page }`
- page results are always ordered oldest-to-newest within the returned window
- cursors are opaque but derived from `(created_at, message_id)` so tied timestamps remain stable
- persisted transcript rows now expose `client_id` alongside `message_id`; during the nullable stage-A rollout, historical rows may briefly return `client_id: null` until the backfill completes
- `before` requests older history than the cursor boundary (exclusive)
- `after` requests newer history than the cursor boundary (exclusive)
- the latest-page request is `GET /api/threads/:thread_id/messages?limit=<n>` with no cursor
- page metadata includes `has_more_before`, `has_more_after`, `before_cursor`, `after_cursor`, `returned`, and `limit`

**Agent Stream Contract**:
- `GET /api/threads/:thread_id/agent/state` returns the current best-effort runtime snapshot with `active`, `turn_id`, `phase`, `can_cancel`, `stream_cursor`, `pending_tool`, `draft_assistant`, and `updated_at`
- `GET /api/threads/:thread_id/agent/stream` emits `agent.message_start`, `agent.message_delta`, `agent.message_done`, `agent.tool_call`, `agent.tool_result`, `agent.message`, `agent.resync_required`, `final`, and `heartbeat`
- agent payloads include a per-turn `turn_id`
- assistant draft events are client-side only; the persisted assistant row still arrives later as `agent.message`
- tool events expose the real `call_id`
- `agent.tool_result` exposes a compact `summary` and explicit `output_truncation_reason` alongside the canonical persisted tool row
- successful `agent.tool_result` / `agent.message` payloads include the persisted canonical transcript row under `message`
- those embedded canonical assistant/tool rows now also expose `message.client_id`; the top-level event identity fields remain `message_id` in this phase
- `agent.message_done` carries the full draft assistant text just before canonical persistence
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
Before creating user message, checks for terminal state changes:
1. If thread has active terminal session and no active agent run
2. Call `contextSyncService.checkAndSync(sessionId, threadId, ownerUserId)`
3. If state changed, a system message is injected before the user message
4. This keeps the agent informed about terminal state transitions (e.g., REPL exit)

**Ownership Enforcement**:
- `requireAuthorizedThreadAccess(...)` gates thread/message/run/terminal routes
- thread lists filter to `thread.created_by_user_id = viewer.userId`
- message and run reads also filter by their row-level owner columns
- new thread/message/session rows are stamped with the acting or owning user id
- terminal input writes `terminal_session_input_log.user_id` for human-originated input
- SSE routes authorize before attaching listeners, so cross-user clients never attach buffered streams
- thread SSE routes send an initial heartbeat frame on empty-buffer/live-only attaches so the HTTP response stays in SSE mode even before the first real event arrives
- `POST /api/threads` now returns `{ thread_id }`
- `POST /api/threads/:thread_id/messages` now accepts optional `client_id`
- duplicate user-message retries with the same owned-thread `client_id` short-circuit with `200 { message_id, client_id }` and do not launch a second agent turn
- fresh user-message writes return `201 { message_id, client_id }`

### `runs.ts`

Standalone command execution (separate from agent flow).

**Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/runs` | Execute a command on an owned bud or owned thread |

**Request Body** (`RunRequestSchema`):
```typescript
{
  bud_id: string,
  cmd: string,
  cwd?: string,
  thread_id?: string,  // Use existing thread or create new
  title?: string       // Title for auto-created thread
}
```

**Response Shape**:
- returns snake_case write identifiers: `{ run_id, thread_id }`

### `me.ts`

Authenticated current-user endpoint backed by shared cookie-or-token auth helpers.

**Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/me` | Return normalized user/session/profile/account-linking state for either cookie or bearer auth |
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

**Auth Notes**:
- now uses the shared `requireViewer(...)` contract instead of remaining public
- returns a normalized snake_case payload so web and mobile share one contract
- top-level response includes `default_model`
- model entries expose `display_name`, `is_alias`, and `alias_target`

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
  "has_terminal_session": true,
  "session_state": "ready",
  "session_id": "string | null"
}
```

**Message Response**:
```json
{
  "message_id": "uuid",
  "client_id": "uuidv7 | null",
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
      "client_id": "uuidv7 | null",
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
