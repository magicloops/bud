# Phase 10: UI Polish & Cleanup

_Status: Planning_

## Overview

Final polish and cleanup phase for the thread-scoped sessions feature. Includes:

- Thread panel UX improvements (new thread indicator, session dots)
- Terminal overlay improvements
- Code cleanup (legacy App.tsx removal, debug log cleanup)
- Debug documentation cleanup

---

## Thread Panel Improvements

### 1. "New Thread" Visual Indicator

When no thread is selected (`/:budId` route), the thread panel should clearly indicate the user is in "new thread" mode.

**Current behavior:** Thread list shows threads, but nothing indicates "new thread" is selected.

**Target behavior:**
- Add a "New Thread" item at the top of the thread list
- Style it differently (dashed border, plus icon)
- Highlight when in new thread mode

**Implementation:**
```typescript
// thread-panel.tsx

// Before thread list
<button
  onClick={() => navigate({ to: '/$budId', params: { budId } })}
  className={cn(
    "w-full flex items-center gap-2 px-3 py-2 rounded-lg border-2 border-dashed",
    !activeThreadId
      ? "border-accent bg-accent/10 text-accent"
      : "border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/50"
  )}
>
  <Plus className="h-4 w-4" />
  <span className="text-sm font-medium">New Thread</span>
</button>
```

### 2. Session Dot Indicator on Threads

Show a small dot next to threads that have an active terminal session.

**Data source:** Client-side only (no API changes needed).

When terminal SSE connects for a thread, we know that thread has an active session. Store this in context or local state.

**Alternative:** Extend `GET /api/threads` to include session info (LEFT JOIN). This was planned in Phase 8b but may be overkill if client-side tracking suffices.

**Implementation (client-side):**
```typescript
// thread-panel.tsx

// Map of threadId → has session (populated by terminal connection)
const [sessionsMap, setSessionsMap] = useState<Record<string, boolean>>({})

// In thread item
{sessionsMap[thread.thread_id] && (
  <span
    className="w-2 h-2 rounded-full bg-green-500"
    title="Active terminal session"
  />
)}
```

**Implementation (API-based, optional):**
See Phase 8b document for LEFT JOIN approach on `GET /api/threads`.

### 3. Thread Delete Confirmation Dialog

Currently uses `window.confirm()`. Upgrade to a proper modal dialog.

**Implementation:**
- Use Shadcn AlertDialog or similar
- Show thread title in confirmation
- Mention session will be closed if active

---

## Terminal Overlay Improvements

### 1. Null ThreadId Message

When `threadId` is null (new thread mode), terminal overlay should show appropriate message.

**Current:** "Terminal awaiting activity…" (misleading)

**Target:** "Start a conversation to create a terminal session"

**Implementation:**
```typescript
const terminalOverlayMessage = useMemo(() => {
  if (!threadId) {
    return 'Start a conversation to create a terminal session'
  }
  if (terminalHasOutput) return null
  if (!terminalSupported) return 'Terminal unavailable for this Bud.'
  if (terminalState === 'creating') return 'Creating terminal…'
  if (terminalState === 'ready' || terminalState === 'active') return 'Terminal ready — start typing.'
  return 'Terminal awaiting activity…'
}, [threadId, terminalHasOutput, terminalState, terminalSupported])
```

### 2. Session Deleted State

When a session is deleted (via Bud Sessions modal), the terminal should show:
- "Session closed" message
- Option to reconnect (manual) or auto-reconnect on next message

**Implementation:** Terminal SSE will error when session closes. Handle gracefully.

---

## Code Cleanup

### 1. Delete Legacy App.tsx

**File:** `web/src/App.tsx`

**Status:** Dead code. Main.tsx uses TanStack Router's `RouterProvider`.

**Action:** Delete file.

**Verification:**
1. Run `pnpm build` - should succeed
2. Run `pnpm dev` - should work
3. Grep for imports of App.tsx - should find none

### 2. Console Log Cleanup

**File:** `web/src/routes/$budId/$threadId.tsx`

**Issue:** ~50 console.log/warn/error statements.

**Options:**
1. **Keep as-is:** Logs are namespaced (`[terminal]`, `[agent-sse]`), useful for debugging
2. **Add dev flag:** Wrap in `if (import.meta.env.DEV)` or custom debug flag
3. **Remove info logs:** Keep warn/error, remove log

**Recommendation:** Option 3 - Keep warn/error (actionable), remove info-level logs.

**Implementation:**
```bash
# Find and review console.log (info level)
grep -n "console.log" web/src/routes/\$budId/\$threadId.tsx

# Keep:
# - console.warn (warnings user might care about)
# - console.error (errors that need attention)

# Remove or wrap in dev flag:
# - console.log (verbose debugging)
```

### 3. Debug Panel Cleanup

**File:** `web/src/components/debug-panel.tsx`

**Status:** Has a console.log on line 80 for "Copy to clipboard".

**Action:** Remove or make it actually useful (copy to clipboard, not just log).

---

## Debug Documentation Cleanup

### Files to Archive/Delete

These debug docs describe issues that have been resolved:

| File | Resolution |
|------|------------|
| `debug/terminal-reload-input.md` | Fixed by SSE reconnection improvements |
| `debug/terminal-stale-after-service-restart.md` | Fixed by bud_offline/bud_online events |
| `debug/terminal-envelope-mismatch.md` | Fixed in Phase 2 |
| `debug/terminal-thread-routes-not-registered.md` | Fixed in Phase 4 |
| `debug/terminal-heartbeat-not-received.md` | Fixed by SSE heartbeat |

**Action:** Move to `debug/archive/` or delete.

### Files to Keep

| File | Reason |
|------|--------|
| `debug/interactive-session-input.md` | Session input flow documentation |
| `debug/interactive-session-ws.md` | WebSocket protocol documentation |

---

## Implementation Checklist

### Thread Panel
- [ ] Add "New Thread" button/indicator at top of list
- [ ] Style "New Thread" as selected when in new thread mode
- [ ] Add session dot indicator to threads (client-side)
- [ ] Upgrade thread delete to use AlertDialog
- [ ] Add confirmation message mentioning session closure

### Terminal Overlay
- [ ] Update message when threadId is null
- [ ] Handle session deleted state gracefully

### Code Cleanup
- [ ] Delete `web/src/App.tsx`
- [ ] Remove or gate console.log statements in thread route
- [ ] Fix debug-panel.tsx console.log
- [ ] Verify build succeeds after cleanup

### Documentation
- [ ] Archive resolved debug docs
- [ ] Update PR_PROGRESS.md

---

## Testing Scenarios

### Scenario A: New Thread Indicator
1. Navigate to Bud (no thread selected)
2. Verify "New Thread" button is highlighted
3. Select a thread
4. Verify "New Thread" button is not highlighted
5. Click "New Thread" button
6. Verify navigation to `/:budId`

### Scenario B: Session Dot Indicator
1. Open a thread with active session
2. Verify green dot appears next to thread
3. Delete session (via Bud Sessions modal)
4. Verify dot disappears (may need refresh)

### Scenario C: Terminal Null Thread
1. Navigate to `/:budId` (new thread mode)
2. Verify terminal shows "Start a conversation..."
3. Send a message
4. Verify terminal connects to new session

### Scenario D: Post-Cleanup Build
1. Delete App.tsx
2. Run `pnpm build`
3. Verify no errors
4. Run `pnpm dev`
5. Verify app works correctly

---

## Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `web/src/App.tsx` | Delete | Legacy dead code |
| `web/src/routes/$budId/$threadId.tsx` | Modify | Remove console.log statements |
| `web/src/components/workbench/thread-panel.tsx` | Modify | Add new thread indicator, session dots, AlertDialog |
| `web/src/components/debug-panel.tsx` | Modify | Fix console.log |
| `debug/*.md` | Archive | Move resolved docs to archive folder |

---

## Dependencies

- Phase 9 (Bud Session Management) for session deletion flow
- Shadcn AlertDialog component
