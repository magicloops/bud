# Phase 9: Bud Session Management Modal

_Status: Implemented_

## Overview

Add a modal accessible from the thread panel settings gear that provides visibility and control over terminal sessions at the Bud level. Users can:

- View all active terminal sessions for the selected Bud
- See which threads each session is linked to
- Delete sessions without deleting the associated thread
- Identify orphaned or stale sessions

This enables users to manage resources (tmux sessions on the Bud) independently from conversation history.

---

## Motivation

Currently, terminal sessions are tightly coupled to threads:
- Creating a thread → creates a session
- Deleting a thread → closes the session

But users may want to:
1. **Free up resources** on the Bud without losing conversation history
2. **Clean up stale sessions** that are consuming memory/processes
3. **Debug session issues** by seeing all sessions in one place
4. **Handle edge cases** like sessions tied to deleted threads

---

## User Flow

### Opening the Modal

1. User is on the main workspace view with a Bud selected
2. User clicks the settings gear icon (⚙️) in the thread panel header
3. Modal opens showing all terminal sessions for that Bud

### Viewing Sessions

The modal displays:
- Session count and Bud online status
- Each session with:
  - State indicator (ready/active/idle/pending/creating)
  - Session ID (truncated)
  - Linked thread title (or "No thread" / "(deleted)")
  - Timestamps (created, last active)
  - Output size in bytes
  - Delete button

### Deleting a Session

1. User clicks "Delete" on a session
2. Confirmation dialog appears explaining:
   - The tmux session on the Bud will be closed
   - The thread will remain intact
   - Output history is preserved in DB
   - A new session will be created when they return to the thread
3. User confirms
4. Session is closed (if Bud online) and marked as closed in DB
5. Modal updates to show remaining sessions

### Thread Re-Activation

When a user visits a thread whose session was deleted:
1. Terminal pane shows "disconnected" or placeholder
2. On first message send, a new session is created via `ensureSession()`
3. Terminal reconnects to the new session

This already works via the existing POST `/api/threads/:threadId/terminal` endpoint.

---

## API Design

### GET /api/buds/:budId/sessions

List all non-closed sessions for a Bud.

**Response:**
```typescript
{
  sessions: Array<{
    session_id: string
    state: "pending" | "creating" | "ready" | "active" | "idle"
    thread_id: string | null
    thread_title: string | null
    thread_deleted: boolean
    created_at: string              // ISO timestamp
    started_at: string | null       // ISO timestamp
    last_activity_at: string | null // ISO timestamp
    output_bytes: number            // Stored output (capped)
    total_output_bytes: number      // Total output (may exceed stored)
  }>
  bud_online: boolean
}
```

**Implementation:**
```typescript
// service/src/routes/buds.ts

server.get("/api/buds/:budId/sessions", async (request, reply) => {
  const { budId } = request.params as { budId: string }

  // Verify bud exists
  const bud = await db.query.budTable.findFirst({
    where: eq(budTable.budId, budId)
  })
  if (!bud) {
    return reply.status(404).send({ error: "bud_not_found" })
  }

  // Get sessions with thread info
  const sessions = await db
    .select({
      session_id: terminalSessionTable.sessionId,
      state: terminalSessionTable.state,
      thread_id: terminalSessionTable.threadId,
      thread_title: threadTable.title,
      thread_deleted_at: threadTable.deletedAt,
      created_at: terminalSessionTable.createdAt,
      started_at: terminalSessionTable.startedAt,
      last_activity_at: terminalSessionTable.lastActivityAt,
      output_bytes: terminalSessionTable.outputLogBytes,
      total_output_bytes: terminalSessionTable.totalOutputBytes,
    })
    .from(terminalSessionTable)
    .leftJoin(
      threadTable,
      eq(terminalSessionTable.threadId, threadTable.threadId)
    )
    .where(
      and(
        eq(terminalSessionTable.budId, budId),
        isNull(terminalSessionTable.closedAt)
      )
    )
    .orderBy(desc(terminalSessionTable.lastActivityAt))

  const budOnline = isBudOnline(budId)

  return {
    sessions: sessions.map(s => ({
      session_id: s.session_id,
      state: s.state,
      thread_id: s.thread_id,
      thread_title: s.thread_title,
      thread_deleted: s.thread_deleted_at !== null,
      created_at: s.created_at.toISOString(),
      started_at: s.started_at?.toISOString() ?? null,
      last_activity_at: s.last_activity_at?.toISOString() ?? null,
      output_bytes: s.output_bytes ?? 0,
      total_output_bytes: s.total_output_bytes ?? 0,
    })),
    bud_online: budOnline
  }
})
```

### DELETE /api/buds/:budId/sessions/:sessionId

Close a specific session.

**Response:**
```typescript
{
  ok: boolean
  session_id: string
  closed_on_bud: boolean  // Was the close message sent to bud?
  error?: string
}
```

**Implementation:**
```typescript
server.delete("/api/buds/:budId/sessions/:sessionId", async (request, reply) => {
  const { budId, sessionId } = request.params as { budId: string; sessionId: string }

  // Verify session exists and belongs to this bud
  const session = await terminalSessionManager.getSession(sessionId)
  if (!session) {
    return reply.status(404).send({ error: "session_not_found" })
  }
  if (session.budId !== budId) {
    return reply.status(403).send({ error: "session_bud_mismatch" })
  }
  if (session.state === "closed") {
    return reply.status(409).send({ error: "session_already_closed" })
  }

  // Close the session
  await terminalSessionManager.closeSession(sessionId, "user_requested")

  // Check if close was sent to bud
  const budOnline = isBudOnline(budId)

  return {
    ok: true,
    session_id: sessionId,
    closed_on_bud: budOnline
  }
})
```

---

## UI Design

The modal follows the app's **minimal neobrutalist** design language:
- **Bold black borders** (`border-3 border-black`)
- **Hard drop shadows** (`shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]`)
- **Uppercase mono labels** (`font-mono text-[11px] uppercase`)
- **Interactive lift on hover** (`hover:-translate-y-0.5`)
- **Card backgrounds** using CSS vars (`var(--card)`, `var(--chat-bg)`)

### Modal Layout

```
┌─────────────────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────────────┐ │
│ │  TERMINAL SESSIONS                                  ✕  │ │
│ │  {BUD_NAME} • ● Online                                 │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│   3 active sessions                                         │
│                                                             │
│   ┌───────────────────────────────────────────────────────┐ │
│   │ ● READY   sess_01HX...a1b2                            │ │
│   │ ↗ Debug login flow                                    │ │
│   │ 2h ago • Active 5m ago • 12.4 KB              [CLOSE] │ │
│   └───────────────────────────────────────────────────────┘ │
│                                                             │
│   ┌───────────────────────────────────────────────────────┐ │
│   │ ● IDLE    sess_01HY...c3d4                            │ │
│   │ ↗ Refactor auth                                       │ │
│   │ 1d ago • Active 4h ago • 45.2 KB              [CLOSE] │ │
│   └───────────────────────────────────────────────────────┘ │
│                                                             │
│   ┌───────────────────────────────────────────────────────┐ │
│   │ ○ PENDING sess_01HZ...e5f6                            │ │
│   │ ⚠ (deleted thread)                                    │ │
│   │ 3d ago • Never active • 0 B                   [CLOSE] │ │
│   └───────────────────────────────────────────────────────┘ │
│                                                             │
│   ─────────────────────────────────────────────────────     │
│   Sessions auto-cleanup after 24h idle.                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Tailwind Classes Reference

**Modal container:**
```tsx
<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
  <div
    className="w-full max-w-lg rounded-xl border-4 border-black bg-background shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]"
  >
```

**Modal header:**
```tsx
<div
  className="flex items-center justify-between border-b-4 border-black px-4 py-3"
  style={{ backgroundColor: 'var(--chat-bg)' }}
>
  <div>
    <h2 className="font-mono text-sm font-bold uppercase tracking-wide">
      Terminal Sessions
    </h2>
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      {budName}
      <span className={cn(
        "h-2 w-2 rounded-full",
        budOnline ? "bg-green-500" : "bg-orange-500"
      )} />
      <span>{budOnline ? "Online" : "Offline"}</span>
    </p>
  </div>
  <button className="rounded-md border-2 border-black p-1.5 hover:-translate-y-0.5 transition-transform">
    <X className="h-4 w-4" />
  </button>
</div>
```

**Session card:**
```tsx
<div
  className="rounded-xl border-3 border-black bg-card px-3 py-2 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]"
>
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-2">
      <span className={cn(
        "h-2 w-2 rounded-full",
        getSessionStateColor(state)
      )} />
      <span className="font-mono text-[10px] font-bold uppercase">
        {state}
      </span>
      <span className="font-mono text-xs text-muted-foreground">
        {truncateSessionId(sessionId)}
      </span>
    </div>
  </div>
  <p className="mt-1 text-sm font-semibold line-clamp-1">
    {threadTitle ?? "(deleted thread)"}
  </p>
  <div className="mt-1 flex items-center justify-between">
    <span className="font-mono text-[11px] text-muted-foreground uppercase">
      {relativeTime(createdAt)} • Active {relativeTime(lastActivityAt)} • {formatBytes(outputBytes)}
    </span>
    <button
      className="rounded-md border-2 border-black bg-destructive px-2 py-1 font-mono text-[10px] font-bold uppercase text-destructive-foreground shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
      disabled={!budOnline}
      title={!budOnline ? "Cannot close while Bud offline" : "Close session"}
    >
      Close
    </button>
  </div>
</div>
```

### State Colors (matching thread-panel.tsx)

| State | Color Class | Visual |
|-------|-------------|--------|
| active | `bg-green-500` | ● |
| ready | `bg-blue-400` | ● |
| idle | `bg-blue-400` | ● |
| creating | `bg-yellow-500 animate-pulse` | ○ (pulsing) |
| pending | `bg-yellow-500 animate-pulse` | ○ (pulsing) |
| closed | `bg-gray-400` | ○ |

### Delete Confirmation Dialog

Uses the same neobrutalist style:

```tsx
<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
  <div className="w-full max-w-sm rounded-xl border-4 border-black bg-background p-4 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
    <h3 className="font-mono text-sm font-bold uppercase">Close Session?</h3>
    <p className="mt-2 text-sm text-muted-foreground">
      This will close the tmux session on the Bud.
    </p>
    <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
      <li>• Thread "{threadTitle}" remains intact</li>
      <li>• Session output preserved in history</li>
      <li>• New session created when you return</li>
    </ul>
    <div className="mt-4 flex justify-end gap-2">
      <button
        className="rounded-md border-2 border-black px-3 py-1.5 font-mono text-[11px] font-bold uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-0.5"
      >
        Cancel
      </button>
      <button
        className="rounded-md border-2 border-black bg-destructive px-3 py-1.5 font-mono text-[11px] font-bold uppercase text-destructive-foreground shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-0.5"
      >
        Close Session
      </button>
    </div>
  </div>
</div>
```

### Empty State

```tsx
<div className="flex flex-col items-center justify-center py-12 text-center">
  <Terminal className="h-12 w-12 text-muted-foreground/50" />
  <p className="mt-4 font-mono text-sm font-semibold uppercase">
    No active sessions
  </p>
  <p className="mt-1 text-sm text-muted-foreground">
    Sessions are created when you visit a thread.
  </p>
</div>
```

### Settings Gear Button (existing)

The settings gear is already styled in `thread-panel.tsx`:
```tsx
<Button
  type="button"
  variant="ghost"
  size="icon"
  className="h-10 w-10 rounded-lg border-3 border-black text-foreground transition-all hover:-translate-y-0.5"
  style={{ boxShadow: '3px 3px 0px rgba(0,0,0,1)' }}
>
  <Settings className="h-5 w-5" />
</Button>
```

Just need to wire up `onClick` to open the modal.

### Bud Offline State

When Bud is offline:
- Status indicator shows orange dot with "Offline" text
- Close buttons have `disabled:opacity-50 disabled:cursor-not-allowed`
- Tooltip explains: "Cannot close while Bud offline"

---

## Edge Cases

### 1. Bud is Offline

**Behavior:**
- Sessions are displayed from database
- Delete buttons are disabled
- Tooltip explains: "Cannot close session while Bud is offline"

**Alternative considered:** "Mark for closure" that closes when Bud reconnects. Deferred to future enhancement.

### 2. Orphaned Session (No Thread)

**When it happens:**
- Bug in session creation
- Thread was hard-deleted (shouldn't happen with soft delete)

**Behavior:**
- Display "No thread" in gray
- Allow deletion (cleanup)

### 3. Session's Thread Was Deleted

**When it happens:**
- User deleted the thread but session wasn't closed (e.g., Bud was offline)
- Possible bug in thread deletion flow

**Behavior:**
- Display "(deleted thread)" with ⚠️ warning icon
- Allow deletion (cleanup)
- Thread link is not clickable

### 4. Session in "creating" State

**When it happens:**
- Bud is still spinning up the tmux session
- Network delay in receiving `terminal_status`

**Behavior:**
- Allow deletion
- Note: May leave orphaned tmux session on Bud if timing is unlucky
- Acceptable edge case for MVP

### 5. Concurrent Users

**When it happens:**
- User A deletes session while User B is using it

**Behavior:**
- User B's SSE stream will error/close
- User B sees terminal go offline
- User B's next action triggers session recreation

**Mitigation:** None needed for MVP. Users expect sessions to be shared resources.

### 6. Thread Re-Activation

**When it happens:**
- Session was deleted
- User visits the thread again

**Behavior:**
- Terminal shows disconnected state
- On first message or manual reconnect, new session is created
- Already handled by existing `POST /api/threads/:threadId/terminal`

**Verification needed:** Ensure terminal SSE reconnection triggers `ensureSession`.

---

## Open Questions

### Resolved

1. **Should we auto-close sessions for deleted threads?**
   - **Decision:** No. User might want to inspect session output. Show warning instead.

2. **Should we show closed sessions?**
   - **Decision:** No. Keep modal focused on actionable items.

3. **Batch delete?**
   - **Decision:** Not for MVP. Can add "Delete All Idle" later.

4. **Navigate to thread from session?**
   - **Decision:** Yes. Thread title is a link (if thread exists and not deleted).

### Deferred

5. **Session output preview in modal?**
   - Could show last few lines of output
   - Adds complexity; defer to future enhancement

6. **Mark for closure when Bud offline?**
   - Queue closure for when Bud reconnects
   - Adds complexity; defer to future enhancement

---

## Implementation Plan

### Step 1: Backend API

1. Add `GET /api/buds/:budId/sessions` endpoint
2. Add `DELETE /api/buds/:budId/sessions/:sessionId` endpoint
3. Add `isBudOnline()` export from gateway if not already available
4. Test endpoints via curl/Postman

### Step 2: Modal Component

1. Create `BudSessionsModal` component
2. Implement session list with cards
3. Implement state indicators
4. Add loading state and error handling
5. Add empty state

### Step 3: Delete Functionality

1. Add delete button to session cards
2. Implement confirmation dialog
3. Handle delete API call
4. Update modal state after delete
5. Disable delete when Bud offline

### Step 4: Settings Gear Integration

1. Add settings gear icon to thread panel header
2. Wire up modal open/close
3. Pass budId to modal

### Step 5: Thread Navigation

1. Make thread titles clickable links
2. Navigate to thread on click
3. Close modal on navigation

### Step 6: Testing

1. Verify session list displays correctly
2. Test delete flow end-to-end
3. Test edge cases (offline, deleted thread, orphaned)
4. Test thread re-activation after session delete

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `service/src/routes/buds.ts` | Modify | Add session endpoints |
| `web/src/components/bud-sessions-modal.tsx` | Create | Modal component |
| `web/src/components/workbench/thread-panel.tsx` | Modify | Add settings gear + modal trigger |
| `web/src/components/ui/confirmation-dialog.tsx` | Create (if needed) | Reusable confirmation dialog |

---

## Testing Scenarios

### Scenario A: View Sessions
1. Select a Bud with active threads
2. Click settings gear in thread panel
3. Verify modal shows all sessions
4. Verify correct states, timestamps, output sizes
5. Verify thread titles are correct

### Scenario B: Delete Session
1. Open sessions modal
2. Click Delete on a session
3. Verify confirmation dialog appears
4. Confirm deletion
5. Verify session removed from list
6. Verify session marked as closed in DB
7. Visit the thread
8. Verify terminal shows disconnected
9. Send a message
10. Verify new session is created

### Scenario C: Bud Offline
1. Disconnect Bud daemon
2. Open sessions modal
3. Verify sessions are shown
4. Verify delete buttons are disabled
5. Verify tooltip explains why

### Scenario D: Deleted Thread Session
1. Create a thread with session
2. Delete the thread
3. Open sessions modal
4. Verify session shows "(deleted thread)" warning
5. Delete the session
6. Verify cleanup successful

### Scenario E: Navigate to Thread
1. Open sessions modal
2. Click on a thread title
3. Verify modal closes
4. Verify navigated to that thread

---

## Dependencies

- Phase 1-8 complete (thread-scoped sessions working)
- TanStack Router (for navigation from modal)
- Shadcn Dialog component (or similar)
