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
| `GET` | `/api/buds/:budId/sessions` | List active terminal sessions for an owned bud |
| `DELETE` | `/api/buds/:budId/sessions/:sessionId` | Close a specific session on an owned bud |

**Key Functions**:
- `normalizeCapabilities(raw)` - Ensure capabilities is an object
- `serializeBud(bud)` - Convert DB row to API response format

**Authorization**:
- All Bud routes call `requireViewer(...)`
- Bud-scoped routes resolve ownership through `getAuthorizedBud(...)`
- Session inventory is filtered to `terminal_session.created_by_user_id = viewer.userId`

### `threads.ts`

Thread and message management, plus terminal operations (~650 lines).

**Thread Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/threads` | List the signed-in user's threads (optionally filtered by owned `bud_id`) |
| `POST` | `/api/threads` | Create a new owned thread on an owned bud |
| `GET` | `/api/threads/:threadId` | Get owned thread details |
| `DELETE` | `/api/threads/:threadId` | Soft delete an owned thread |

**Message Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/threads/:threadId/messages` | Get owned messages (limit configurable) |
| `POST` | `/api/threads/:threadId/messages` | Send a user-owned message (with context sync), triggers agent |
| `GET` | `/api/threads/:threadId/agent/stream` | SSE for owned agent events |
| `POST` | `/api/threads/:threadId/cancel` | Cancel an owned running agent |

**Run Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/threads/:threadId/runs` | Get owned run history with cursor pagination |

**Terminal Endpoints** (Thread-Scoped):

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/threads/:threadId/terminal` | Create/get an owned terminal session (DB only) |
| `POST` | `/api/threads/:threadId/terminal/ensure` | Ensure the owned terminal is running on bud |
| `GET` | `/api/threads/:threadId/terminal` | Get owned session info |
| `GET` | `/api/threads/:threadId/terminal/stream` | SSE output stream for an owned session |
| `POST` | `/api/threads/:threadId/terminal/input` | Send input as the signed-in human user |
| `POST` | `/api/threads/:threadId/terminal/interrupt` | Send Ctrl+C to an owned session |
| `POST` | `/api/threads/:threadId/terminal/resize` | Resize an owned terminal |
| `GET` | `/api/threads/:threadId/terminal/history` | Get owned output history |

**Validation Schemas** (Zod):
- `CreateThreadSchema` - `bud_id` required, `title` optional
- `CreateMessageSchema` - `text` required, `cwd` and `reasoning_effort` optional
- `ThreadParamsSchema` - UUID validation
- `TerminalEnsureBodySchema` - Optional `shell`, `cwd`, `cols`, `rows`
- `TerminalResizeBodySchema` - Required `cols`, `rows`
- `TerminalInputBodySchema` - Required `input`

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

### `me.ts`

Authenticated current-user endpoint backed by Better Auth session helpers.

**Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/me` | Return normalized user/session/profile/account-linking state |
| `PATCH` | `/api/me/profile` | Update the signed-in user's Bud-owned profile fields |

**Response Shape**:
- `user` - Better Auth user identity (`id`, `email`, `email_verified`, `name`, `image`)
- `session` - Current session metadata (`id`, `expires_at`)
- `profile` - Bud-owned profile metadata (`username`, timestamps)
- `linked_accounts` / `linked_providers` - Provider-linking summary for settings/account UI

**Profile Updates**:
- `PATCH /api/me/profile` currently supports `username`
- input is validated and normalized through `auth/session.ts`
- invalid usernames return `400 invalid_username`
- uniqueness conflicts return `409 username_taken`

**Dependencies**:
- `../auth/session.js` - Session lookup and `user_profile` bootstrap
- `./device-auth.ts` - Uses the same browser session model for claim approval

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
  "role": "user | assistant | tool",
  "display_role": "string",
  "content": "string",
  "metadata": {},
  "created_at": "ISO date"
}
```

## Dependencies

| Import | Purpose |
|--------|---------|
| `fastify` | Request/reply types |
| `zod` | Request validation |
| `drizzle-orm` | Query helpers |
| `../db/client.js` | Database access |
| `../db/schema.js` | Table schemas |
| `../agent/index.js` | Agent service |
| `../runtime/*.js` | Manager classes |
| `../ws/gateway.js` | Bud status helpers |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
