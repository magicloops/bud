# routes

HTTP API route handlers using Fastify.

## Purpose

Defines REST API endpoints for managing buds, threads, messages, runs, and terminal sessions. All routes are prefixed with `/api/`.

## Files

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
| `POST` | `/api/threads/:threadId/messages` | Send user message, triggers agent |
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
