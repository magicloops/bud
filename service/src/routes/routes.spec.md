# routes

HTTP API route handlers using Fastify.

## Purpose

Defines REST API endpoints for managing buds, threads, messages, runs, terminal sessions, the authenticated current-user surface, and browser-mediated Bud device claims. All routes are prefixed with `/api/`.

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
| `GET` | `/api/buds` | List all buds with last run info |
| `GET` | `/api/buds/:budId/sessions` | List active terminal sessions for a bud |
| `DELETE` | `/api/buds/:budId/sessions/:sessionId` | Close a specific session |

**Key Functions**:
- `normalizeCapabilities(raw)` - Ensure capabilities is an object
- `serializeBud(bud)` - Convert DB row to API response format

### `threads.ts`

Thread and message management, plus terminal operations (~650 lines).

**Thread Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/threads` | List threads (optionally filtered by `bud_id`) |
| `POST` | `/api/threads` | Create new thread |
| `GET` | `/api/threads/:threadId` | Get thread details |
| `DELETE` | `/api/threads/:threadId` | Soft delete thread |

**Message Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/threads/:threadId/messages` | Get messages (limit configurable) |
| `POST` | `/api/threads/:threadId/messages` | Send user message (with context sync), triggers agent |
| `GET` | `/api/threads/:threadId/agent/stream` | SSE for agent events |
| `POST` | `/api/threads/:threadId/cancel` | Cancel running agent |

**Run Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/threads/:threadId/runs` | Get run history with cursor pagination |

**Terminal Endpoints** (Thread-Scoped):

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/threads/:threadId/terminal` | Create/get terminal session (DB only) |
| `POST` | `/api/threads/:threadId/terminal/ensure` | Ensure terminal running on bud |
| `GET` | `/api/threads/:threadId/terminal` | Get session info |
| `GET` | `/api/threads/:threadId/terminal/stream` | SSE output stream |
| `POST` | `/api/threads/:threadId/terminal/input` | Send input |
| `POST` | `/api/threads/:threadId/terminal/interrupt` | Send Ctrl+C |
| `POST` | `/api/threads/:threadId/terminal/resize` | Resize terminal |
| `GET` | `/api/threads/:threadId/terminal/history` | Get output history |

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
2. Call `contextSyncService.checkAndSync(sessionId, threadId)`
3. If state changed, a system message is injected before the user message
4. This keeps the agent informed about terminal state transitions (e.g., REPL exit)

### `runs.ts`

Standalone command execution (separate from agent flow).

**Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/runs` | Execute command on bud |

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

**Response Shape**:
- `user` - Better Auth user identity (`id`, `email`, `email_verified`, `name`, `image`)
- `session` - Current session metadata (`id`, `expires_at`)
- `profile` - Bud-owned profile metadata (`username`, timestamps)
- `linked_accounts` / `linked_providers` - Provider-linking summary for settings/account UI

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
