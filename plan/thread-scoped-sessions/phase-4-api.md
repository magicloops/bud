# Phase 4: API Endpoints

_Status: Complete_

## Overview

Replace bud-based terminal endpoints with thread-based endpoints. All terminal operations go through the thread's session.

**Files:**
- `service/src/routes/threads.ts` (update - add terminal endpoints)
- `service/src/routes/terminals.ts` (delete)
- `service/src/routes/buds.ts` (update - add session inventory)

---

## Current Endpoints (to be removed)

```
POST /api/terminals/:budId/ensure
GET  /api/terminals/:budId
GET  /api/terminals/:budId/history
POST /api/terminals/:budId/input
POST /api/terminals/:budId/interrupt
POST /api/terminals/:budId/resize
GET  /api/terminals/:budId/metrics
GET  /api/terminals/metrics

GET  /api/buds/:budId/terminal/stream  (SSE)
```

---

## New Endpoints

### Thread Terminal Endpoints

```
POST   /api/threads/:threadId/terminal           Create/ensure terminal session
GET    /api/threads/:threadId/terminal           Get session info
GET    /api/threads/:threadId/terminal/stream    SSE output stream
POST   /api/threads/:threadId/terminal/input     Send input
POST   /api/threads/:threadId/terminal/interrupt Send Ctrl+C
POST   /api/threads/:threadId/terminal/resize    Resize terminal
GET    /api/threads/:threadId/terminal/history   Get output history
DELETE /api/threads/:threadId                    Soft delete thread (requires session closed)
```

### Bud Session Inventory

```
GET  /api/buds/:budId/sessions     List all active sessions on Bud
```

---

## Implementation

### 1. Thread Terminal Routes

```typescript
// service/src/routes/threads.ts (add to existing file)

import { z } from "zod";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import type { TerminalSessionEventBus } from "../runtime/terminal-session-event-bus.js";

const ensureBodySchema = z.object({
  shell: z.string().optional(),
  cwd: z.string().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
}).partial();

const resizeBodySchema = z.object({
  cols: z.number().int().positive().min(1).max(500),
  rows: z.number().int().positive().min(1).max(200),
});

const inputBodySchema = z.object({
  input: z.string().min(1),
});

export async function registerThreadTerminalRoutes(
  server: FastifyInstance,
  sessionManager: TerminalSessionManager,
  events: TerminalSessionEventBus
): Promise<void> {

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/threads/:threadId/terminal - Create/ensure terminal
  // ─────────────────────────────────────────────────────────────────────────
  server.post("/api/threads/:threadId/terminal", async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const body = ensureBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    // Get thread to find budId
    const thread = await db.query.threadTable.findFirst({
      where: and(
        eq(threadTable.threadId, threadId),
        isNull(threadTable.deletedAt)
      ),
    });
    if (!thread) {
      return reply.code(404).send({ error: "thread_not_found" });
    }

    // Get or create session
    let session = await sessionManager.getSessionForThread(threadId);
    const created = !session;

    if (!session) {
      const sessionId = await sessionManager.createSessionForThread(threadId, thread.budId);
      session = await sessionManager.getSessionForThread(threadId);
    }

    if (!session) {
      return reply.code(500).send({ error: "session_create_failed" });
    }

    // Ensure running on Bud
    const { ok, resumed, error } = await sessionManager.ensureSession(session.sessionId);
    if (!ok) {
      return reply.code(503).send({ error: error ?? "terminal_unavailable" });
    }

    return {
      session_id: session.sessionId,
      bud_id: session.budId,
      state: session.state,
      created,
      resumed,
    };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/threads/:threadId/terminal - Get session info
  // ─────────────────────────────────────────────────────────────────────────
  server.get("/api/threads/:threadId/terminal", async (request, reply) => {
    const { threadId } = request.params as { threadId: string };

    const session = await sessionManager.getSessionForThread(threadId);
    if (!session) {
      return reply.code(404).send({ error: "no_terminal_session" });
    }

    return {
      session_id: session.sessionId,
      thread_id: session.threadId,
      bud_id: session.budId,
      state: session.state,
      cols: session.cols,
      rows: session.rows,
      created_at: session.createdAt?.toISOString(),
      started_at: session.startedAt?.toISOString(),
      last_activity_at: session.lastActivityAt?.toISOString(),
    };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/threads/:threadId/terminal/stream - SSE output stream
  // ─────────────────────────────────────────────────────────────────────────
  server.get("/api/threads/:threadId/terminal/stream", async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const query = request.query as { sinceOffset?: string };
    const sinceOffset = query.sinceOffset ? parseInt(query.sinceOffset, 10) : undefined;

    const session = await sessionManager.getSessionForThread(threadId);
    if (!session) {
      return reply.code(404).send({ error: "no_terminal_session" });
    }

    // Set up SSE
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();

    // Send initial backfill if requested
    if (sinceOffset !== undefined) {
      const { data, totalBytes } = await sessionManager.tailOutput(session.sessionId, 100000, { sinceOffset });
      if (data.length > 0) {
        reply.raw.write(`event: backfill\ndata: ${JSON.stringify({
          data: data.toString("base64"),
          byte_offset: sinceOffset,
          total_bytes: totalBytes,
        })}\n\n`);
      }
    }

    // Subscribe to session events
    const heartbeatMs = process.env.NODE_ENV === "development" ? 1000 : 5000;
    let lastHeartbeat = Date.now();

    const heartbeatInterval = setInterval(() => {
      const now = Date.now();
      if (now - lastHeartbeat >= heartbeatMs) {
        reply.raw.write(`event: heartbeat\ndata: {}\n\n`);
        lastHeartbeat = now;
      }
    }, heartbeatMs);

    const detach = events.attach(session.sessionId, (event) => {
      lastHeartbeat = Date.now();
      reply.raw.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\nid: ${event.id}\n\n`);
    });

    // Cleanup on close
    request.raw.on("close", () => {
      clearInterval(heartbeatInterval);
      detach();
    });

    // Don't end the response - keep streaming
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/threads/:threadId/terminal/input - Send input
  // ─────────────────────────────────────────────────────────────────────────
  server.post("/api/threads/:threadId/terminal/input", async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const body = inputBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "input_required" });
    }

    const session = await sessionManager.getSessionForThread(threadId);
    if (!session) {
      return reply.code(404).send({ error: "no_terminal_session" });
    }

    const result = await sessionManager.sendInput(
      session.sessionId,
      Buffer.from(body.data.input, "utf-8"),
      { source: "user" }
    );

    if (!result.ok) {
      return reply.code(503).send({ error: result.error ?? "terminal_unavailable" });
    }

    return { ok: true };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/threads/:threadId/terminal/interrupt - Send Ctrl+C
  // ─────────────────────────────────────────────────────────────────────────
  server.post("/api/threads/:threadId/terminal/interrupt", async (request, reply) => {
    const { threadId } = request.params as { threadId: string };

    const session = await sessionManager.getSessionForThread(threadId);
    if (!session) {
      return reply.code(404).send({ error: "no_terminal_session" });
    }

    const result = await sessionManager.sendInterrupt(session.sessionId);
    if (!result.ok) {
      return reply.code(503).send({ error: result.error ?? "terminal_unavailable" });
    }

    return { ok: true };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/threads/:threadId/terminal/resize - Resize terminal
  // ─────────────────────────────────────────────────────────────────────────
  server.post("/api/threads/:threadId/terminal/resize", async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const body = resizeBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", details: body.error.message });
    }

    const session = await sessionManager.getSessionForThread(threadId);
    if (!session) {
      return reply.code(404).send({ error: "no_terminal_session" });
    }

    const result = await sessionManager.sendResize(session.sessionId, body.data.cols, body.data.rows);
    if (!result.ok) {
      return reply.code(503).send({ error: result.error ?? "terminal_unavailable" });
    }

    return { ok: true };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/threads/:threadId/terminal/history - Get output history
  // ─────────────────────────────────────────────────────────────────────────
  server.get("/api/threads/:threadId/terminal/history", async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const query = request.query as { bytes?: string; sinceOffset?: string };
    const maxBytes = Math.max(parseInt(query.bytes ?? "4096", 10) || 4096, 0);
    const sinceOffset = query.sinceOffset ? parseInt(query.sinceOffset, 10) : undefined;

    const session = await sessionManager.getSessionForThread(threadId);
    if (!session) {
      return reply.code(404).send({ error: "no_terminal_session" });
    }

    const { data, totalBytes } = await sessionManager.tailOutput(session.sessionId, maxBytes, { sinceOffset });

    return {
      session_id: session.sessionId,
      bytes: data.length,
      total_bytes_available: totalBytes,
      data_base64: data.toString("base64"),
    };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /api/threads/:threadId - Soft delete thread
  // ─────────────────────────────────────────────────────────────────────────
  server.delete("/api/threads/:threadId", async (request, reply) => {
    const { threadId } = request.params as { threadId: string };

    const thread = await db.query.threadTable.findFirst({
      where: and(
        eq(threadTable.threadId, threadId),
        isNull(threadTable.deletedAt)
      ),
    });
    if (!thread) {
      return reply.code(404).send({ error: "thread_not_found" });
    }

    // Check for active session
    const session = await sessionManager.getSessionForThread(threadId);
    if (session && session.state !== "closed") {
      // Try to close the session
      const bud = await getBudConnection(thread.budId);
      if (!bud) {
        return reply.code(409).send({
          error: "session_active_bud_offline",
          message: "Cannot delete thread: terminal session is active but Bud is offline. Wait for Bud to reconnect or try again later.",
        });
      }

      // Close the session
      await sessionManager.closeSession(session.sessionId, "thread_deleted");
    }

    // Soft delete thread
    await db.update(threadTable)
      .set({ deletedAt: new Date() })
      .where(eq(threadTable.threadId, threadId));

    return { ok: true, deleted_at: new Date().toISOString() };
  });
}
```

### 2. Bud Session Inventory

```typescript
// service/src/routes/buds.ts (add to existing file)

// GET /api/buds/:budId/sessions - List active sessions
server.get("/api/buds/:budId/sessions", async (request) => {
  const { budId } = request.params as { budId: string };

  const sessions = await db.query.terminalSessionTable.findMany({
    where: and(
      eq(terminalSessionTable.budId, budId),
      isNull(terminalSessionTable.closedAt)
    ),
    orderBy: [desc(terminalSessionTable.lastActivityAt)],
  });

  return {
    bud_id: budId,
    sessions: sessions.map(s => ({
      session_id: s.sessionId,
      thread_id: s.threadId,
      state: s.state,
      cols: s.cols,
      rows: s.rows,
      created_at: s.createdAt?.toISOString(),
      last_activity_at: s.lastActivityAt?.toISOString(),
    })),
  };
});
```

### 3. Remove Legacy Routes

Delete `service/src/routes/terminals.ts` entirely.

Remove registration in server setup:
```typescript
// Before
await registerTerminalRoutes(server, terminalManager);

// After
// (deleted)
```

---

## Implementation Checklist

- [ ] Add thread terminal routes to `service/src/routes/threads.ts`
  - [ ] `POST /api/threads/:threadId/terminal`
  - [ ] `GET /api/threads/:threadId/terminal`
  - [ ] `GET /api/threads/:threadId/terminal/stream`
  - [ ] `POST /api/threads/:threadId/terminal/input`
  - [ ] `POST /api/threads/:threadId/terminal/interrupt`
  - [ ] `POST /api/threads/:threadId/terminal/resize`
  - [ ] `GET /api/threads/:threadId/terminal/history`
  - [ ] `DELETE /api/threads/:threadId` (soft delete)
- [ ] Add session inventory to `service/src/routes/buds.ts`
  - [ ] `GET /api/buds/:budId/sessions`
- [ ] Delete `service/src/routes/terminals.ts`
- [ ] Update server setup to register new routes
- [ ] Update server setup to remove old routes

---

## Response Schemas

### POST /api/threads/:threadId/terminal

```json
{
  "session_id": "sess_01ABC...",
  "bud_id": "bud_123",
  "state": "ready",
  "created": true,
  "resumed": false
}
```

### GET /api/threads/:threadId/terminal

```json
{
  "session_id": "sess_01ABC...",
  "thread_id": "uuid...",
  "bud_id": "bud_123",
  "state": "ready",
  "cols": 200,
  "rows": 50,
  "created_at": "2025-12-08T...",
  "started_at": "2025-12-08T...",
  "last_activity_at": "2025-12-08T..."
}
```

### GET /api/buds/:budId/sessions

```json
{
  "bud_id": "bud_123",
  "sessions": [
    {
      "session_id": "sess_01ABC...",
      "thread_id": "uuid...",
      "state": "ready",
      "cols": 200,
      "rows": 50,
      "created_at": "...",
      "last_activity_at": "..."
    }
  ]
}
```

---

## Notes

- All terminal operations require an existing session (via `POST /terminal` first)
- SSE stream supports `sinceOffset` query param for reconnection
- Thread deletion requires session to be closeable (Bud online)
- Session inventory is useful for debugging and BudPage UI
