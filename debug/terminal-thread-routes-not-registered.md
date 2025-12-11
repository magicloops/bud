# Debug: Thread Terminal Routes Not Registered

**Date:** 2025-12-08
**Status:** Active Investigation
**Symptoms:**
- `POST /api/threads/:threadId/terminal/resize` returns 404
- Terminal not showing up in frontend
- No visible errors from Bud

---

## Root Cause Identified

**The `registerThreadTerminalRoutes()` function is defined in `threads.ts` but is NEVER called in `server.ts`.**

### Evidence

In `service/src/routes/threads.ts`, there are TWO exported registration functions:

```typescript
// Line 139 - Called in server.ts
export async function registerThreadRoutes(
  server: FastifyInstance,
  _runManager: RunManager,
  agentService: AgentService,
  sessionManager: SessionManager
): Promise<void> { ... }

// Line 357 - NEVER CALLED
export async function registerThreadTerminalRoutes(
  server: FastifyInstance,
  terminalSessionManager: TerminalSessionManager,
  terminalEvents: TerminalEventBus
): Promise<void> { ... }
```

In `service/src/server.ts`:

```typescript
// Line 11 - Only registerThreadRoutes is imported
import { registerThreadRoutes } from "./routes/threads.js";

// Line 71 - Only registerThreadRoutes is called
await registerThreadRoutes(server, runManager, agentService, sessionManager);

// MISSING: registerThreadTerminalRoutes is never imported or called
```

### Routes NOT Registered

The following routes are defined in `registerThreadTerminalRoutes()` but never registered:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/threads/:threadId/terminal` | Create/ensure terminal session |
| GET | `/api/threads/:threadId/terminal` | Get session info |
| GET | `/api/threads/:threadId/terminal/stream` | SSE output stream |
| POST | `/api/threads/:threadId/terminal/input` | Send input |
| POST | `/api/threads/:threadId/terminal/interrupt` | Send Ctrl+C |
| POST | `/api/threads/:threadId/terminal/resize` | Resize terminal |
| GET | `/api/threads/:threadId/terminal/history` | Get output history |
| DELETE | `/api/threads/:threadId` | Soft delete thread |

---

## Fix Required

In `service/src/server.ts`:

1. Import `registerThreadTerminalRoutes`:
   ```typescript
   import { registerThreadRoutes, registerThreadTerminalRoutes } from "./routes/threads.js";
   ```

2. Call it after existing route registrations:
   ```typescript
   await registerThreadTerminalRoutes(server, terminalSessionManager, terminalEvents);
   ```

---

## Cold Start Scenarios Analysis

### Scenario 1: New Thread for Existing Bud
1. User selects a Bud
2. User types message without selecting a thread
3. Frontend sends `POST /api/threads` with `{ bud_id: "..." }` - creates thread
4. Frontend sends `POST /api/threads/:threadId/messages` - sends message
5. Frontend effect triggers on `threadId` change
6. Frontend sends `POST /api/threads/:threadId/terminal` - **404 because route not registered**
7. Terminal connection fails silently

### Scenario 2: Existing Thread Resume
1. User selects existing thread from sidebar
2. Frontend effect triggers on `threadId` change
3. Frontend sends `POST /api/threads/:threadId/terminal` - **404**
4. Terminal connection fails

### Scenario 3: After Route Fix (Expected Flow)
1. User selects thread
2. Frontend sends `POST /api/threads/:threadId/terminal`
3. Service calls `terminalSessionManager.getSessionForThread(threadId)`
4. If no session exists: `terminalSessionManager.createSessionForThread(threadId, budId)`
5. Service calls `terminalSessionManager.ensureSession(sessionId)`
6. Service sends `terminal_ensure` to Bud via WebSocket
7. Returns `{ session_id, bud_id, state, created: true/false, resumed: true/false }`
8. Frontend connects to SSE stream `/api/threads/:threadId/terminal/stream`
9. Frontend fetches history `/api/threads/:threadId/terminal/history?bytes=131072`
10. Terminal displays content

---

## Secondary Issue: "New" Button Not Working

User reported clicking "new" doesn't do anything. This is a separate frontend issue but worth noting:

- The frontend creates threads lazily when sending a message (line 1027-1039 in App.tsx)
- There doesn't appear to be a dedicated "create new thread" action
- This is existing behavior, not related to the terminal refactor

---

## Verification Steps After Fix

1. Start service: `pnpm dev`
2. Watch logs for route registration
3. Open frontend, select a Bud
4. Select or create a thread
5. Verify logs show:
   - `POST /api/threads/:threadId/terminal` - 200
   - `GET /api/threads/:threadId/terminal/stream` - 200 (SSE)
   - `POST /api/threads/:threadId/terminal/resize` - 200
6. Verify terminal shows content
7. Test input (type command, press Enter)
8. Test reconnect (refresh page, verify session resumes with history)

---

## Files Involved

| File | Status |
|------|--------|
| `service/src/server.ts` | **Needs fix** - missing import and call |
| `service/src/routes/threads.ts` | OK - routes defined correctly |
| `service/src/runtime/terminal-session-manager.ts` | OK - logic implemented |
| `web/src/App.tsx` | OK - calling correct endpoints |
