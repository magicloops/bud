# Terminal Resize Sync Spec

**Date:** 2025-12-03
**Status:** ✅ Implemented
**Issue:** Claude Code and other TUI applications render incorrectly in the web terminal

## Problem Statement

When running Claude Code (or other terminal UI applications) in the Bud web terminal, the interface renders incorrectly. The application appears to be rendering for a wider terminal than what's displayed, causing text wrapping issues and broken layouts.

### Root Cause

Terminal dimensions are not synchronized between the frontend (xterm.js) and the backend (tmux session on Bud):

1. **Bud creates tmux with fixed defaults**: 200 columns x 50 rows (`bud/src/main.rs` lines 93-97)
2. **Frontend fits xterm.js to container**: Uses `FitAddon.fit()` which calculates actual cols/rows from container size (typically 80-120 cols)
3. **No resize messages are sent**: The frontend never tells the backend what size the terminal actually is
4. **Result**: Applications query terminal size via TIOCGWINSZ, get 200 cols, and render for that width

### Evidence

- `BUD_TERMINAL_COLS` defaults to 200 (`bud/src/main.rs:93`)
- `BUD_TERMINAL_ROWS` defaults to 50 (`bud/src/main.rs:97`)
- tmux is created with these dimensions (`bud/src/main.rs:1051-1060`)
- No resize endpoint exists in `service/src/routes/terminals.ts`
- Frontend has no code to send resize after `fitAddon.fit()`

## Existing Infrastructure

### Types Already Defined

**`service/src/terminal/types.ts`** (lines 56-60):
```typescript
export interface TerminalResizeMessage extends TerminalEnvelope {
  type: "terminal_resize";
  cols: number;
  rows: number;
}
```

### Bud Already Handles Resize

**`bud/src/main.rs`** (lines 887-912):
```rust
async fn handle_resize(&self, frame: TerminalResizeFrame) -> Result<()> {
    // ...
    let status = Command::new("tmux")
        .args([
            "resize-window",
            "-t",
            &handle.session_name,
            "-x",
            &frame.cols.to_string(),
            "-y",
            &frame.rows.to_string(),
        ])
        .status()
        .await
        // ...
}
```

And the frame type is handled in the message dispatch (`bud/src/main.rs:2011-2013`):
```rust
"terminal_resize" => {
    let frame: TerminalResizeFrame = serde_json::from_str(text)?;
    self.terminal_manager.handle_resize(frame).await?;
}
```

### What's Missing

1. **REST endpoint** to receive resize from frontend
2. **TerminalManager method** to forward resize to Bud via WebSocket
3. **Frontend code** to send resize after fit and on window resize

## Implementation Plan

### 1. Add `sendResize` Method to TerminalManager

**File:** `service/src/runtime/terminal-manager.ts`

Add a new method similar to `sendInput`:

```typescript
async sendResize(budId: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> {
  const payload = {
    proto: TERMINAL_PROTO_VERSION,
    type: "terminal_resize",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    cols,
    rows
  };
  const sent = sendFrameToBud(budId, payload);
  if (!sent) {
    this.logger.warn({ budId }, "Failed to send terminal_resize (bud offline)");
    return { ok: false, error: "bud_offline" };
  }

  // Update DB with new dimensions
  await db
    .update(budTerminalTable)
    .set({ cols, rows, lastActivityAt: new Date() })
    .where(eq(budTerminalTable.budId, budId));

  this.debug("terminal_resize forwarded", { budId, cols, rows });
  return { ok: true };
}
```

### 2. Add REST Endpoint

**File:** `service/src/routes/terminals.ts`

Add new endpoint after the existing ones:

```typescript
const resizeBodySchema = z.object({
  cols: z.number().int().positive().min(1).max(500),
  rows: z.number().int().positive().min(1).max(200)
});

server.post("/api/terminals/:budId/resize", async (request, reply) => {
  const budId = (request.params as { budId: string }).budId;
  const body = resizeBodySchema.safeParse(request.body);
  if (!body.success) {
    return reply.code(400).send({ error: "invalid_body", details: body.error.message });
  }
  request.log.info(
    { budId, cols: body.data.cols, rows: body.data.rows, component: "terminal_routes" },
    "terminal resize requested"
  );
  const result = await terminalManager.sendResize(budId, body.data.cols, body.data.rows);
  if (!result.ok) {
    return reply.code(503).send({ error: result.error ?? "terminal_unavailable" });
  }
  return { ok: true };
});
```

### 3. Add Frontend Resize Sync

**File:** `web/src/App.tsx`

#### 3a. Add resize function

Add a new function to send resize to backend:

```typescript
const sendTerminalResize = useCallback(
  async (cols: number, rows: number) => {
    if (!budId) return
    try {
      const resp = await apiFetch(`/api/terminals/${budId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows })
      })
      if (!resp.ok) {
        console.warn('[terminal] resize request failed', { status: resp.status })
      }
    } catch (err) {
      console.error('Failed to send terminal resize', err)
    }
  },
  [budId]
)
```

#### 3b. Modify `fitTerminal` to send resize after fit

Update the `fitTerminal` callback to send resize after successful fit:

```typescript
const fitTerminal = useCallback(() => {
  if (!terminalReadyRef.current) {
    return
  }
  const addon = fitAddonRef.current
  const term = terminalRef.current
  const pane = terminalPaneRef.current
  if (!addon || !term || !pane || !pane.isConnected || !term.element) {
    return
  }
  try {
    addon.fit()
    // Send resize to backend after fit
    const cols = term.cols
    const rows = term.rows
    if (cols > 0 && rows > 0) {
      sendTerminalResize(cols, rows)
    }
  } catch (err) {
    console.warn('Failed to fit terminal', err)
  }
}, [sendTerminalResize])
```

**Note:** This creates a dependency cycle issue since `fitTerminal` is used in the terminal initialization effect. We need to handle this carefully - see "Implementation Notes" below.

#### 3c. Alternative: Use ref for sendTerminalResize

To avoid the dependency cycle, use a ref pattern similar to `sendTerminalInputRef`:

```typescript
const sendTerminalResizeRef = useRef<(cols: number, rows: number) => void>(() => {})

// Update ref when function changes
useEffect(() => {
  sendTerminalResizeRef.current = sendTerminalResize
}, [sendTerminalResize])

// In fitTerminal, use the ref
const fitTerminal = useCallback(() => {
  // ... existing guards ...
  try {
    addon.fit()
    const cols = term.cols
    const rows = term.rows
    if (cols > 0 && rows > 0) {
      sendTerminalResizeRef.current(cols, rows)
    }
  } catch (err) {
    console.warn('Failed to fit terminal', err)
  }
}, []) // No dependencies needed since we use ref
```

### 4. Pass Initial Size in terminal_ensure

**Optional enhancement:** Include initial dimensions when ensuring terminal.

**File:** `web/src/App.tsx`

When calling `/api/terminals/${budId}/ensure`, include initial dimensions:

```typescript
// After terminal is ready and fit, ensure with correct dimensions
const cols = term.cols
const rows = term.rows
apiFetch(`/api/terminals/${budId}/ensure`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ cols, rows })
}).catch((err) => {
  console.error('Failed to ensure terminal', err)
})
```

This ensures the tmux session is created with the correct dimensions from the start, avoiding a resize immediately after creation.

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                        │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────────────────┐   │
│  │   xterm.js  │────▶│  FitAddon   │────▶│ sendTerminalResize(cols,rows)│   │
│  │  (renders)  │     │   .fit()    │     │                              │   │
│  └─────────────┘     └─────────────┘     └──────────────┬───────────────┘   │
│                                                          │                   │
└──────────────────────────────────────────────────────────┼───────────────────┘
                                                           │
                                              POST /api/terminals/:budId/resize
                                                           │
                                                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SERVICE                                         │
│  ┌─────────────────────┐     ┌─────────────────────────────────────────┐   │
│  │  terminals.ts       │────▶│  TerminalManager.sendResize()           │   │
│  │  POST /resize       │     │  - Sends WS frame to Bud                │   │
│  └─────────────────────┘     │  - Updates DB with new cols/rows        │   │
│                              └──────────────────┬──────────────────────┘   │
│                                                  │                          │
└──────────────────────────────────────────────────┼──────────────────────────┘
                                                   │
                                        WebSocket: terminal_resize frame
                                                   │
                                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                BUD                                           │
│  ┌─────────────────────┐     ┌─────────────────────────────────────────┐   │
│  │  Message dispatch   │────▶│  TerminalManager.handle_resize()        │   │
│  │  "terminal_resize"  │     │  - tmux resize-window -t $session       │   │
│  └─────────────────────┘     │    -x $cols -y $rows                    │   │
│                              └─────────────────────────────────────────┘   │
│                                                  │                          │
│                                                  ▼                          │
│                              ┌─────────────────────────────────────────┐   │
│                              │  tmux session                           │   │
│                              │  - TIOCGWINSZ returns new size          │   │
│                              │  - SIGWINCH sent to foreground process  │   │
│                              └─────────────────────────────────────────┘   │
│                                                  │                          │
│                                                  ▼                          │
│                              ┌─────────────────────────────────────────┐   │
│                              │  Claude Code / TUI app                  │   │
│                              │  - Receives SIGWINCH                    │   │
│                              │  - Re-queries terminal size             │   │
│                              │  - Re-renders for correct dimensions    │   │
│                              └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Resize Events

Resize should be sent in these scenarios:

1. **Initial terminal ready**: After `tryFit()` succeeds and terminal is first displayed
2. **Window resize**: When browser window is resized (already triggers `fitTerminal()`)
3. **Panel toggle**: When session panel opens/closes (already triggers `fitTerminal()`)
4. **Tab switch**: If terminal tab is shown after being hidden

## Debouncing

Consider debouncing resize requests to avoid flooding the backend during window drag-resize:

```typescript
const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

const sendTerminalResizeDebounced = useCallback(
  (cols: number, rows: number) => {
    if (resizeTimeoutRef.current) {
      clearTimeout(resizeTimeoutRef.current)
    }
    resizeTimeoutRef.current = setTimeout(() => {
      resizeTimeoutRef.current = null
      sendTerminalResize(cols, rows)
    }, 100) // 100ms debounce
  },
  [sendTerminalResize]
)
```

## Implementation Notes

1. **Dependency cycle**: `fitTerminal` is used in the terminal init effect. Adding `sendTerminalResize` as a dependency would cause the effect to re-run on every budId change. Use a ref pattern to avoid this.

2. **Race condition**: The initial `ensure` call happens before terminal is fully initialized. We should ensure the terminal first, then send resize once dimensions are known.

3. **Reconnection**: On SSE reconnect, terminal dimensions should be re-sent to ensure consistency.

4. **Error handling**: Resize failures should not block terminal usage - log and continue.

## Files Modified

| File | Changes |
|------|---------|
| `service/src/runtime/terminal-manager.ts` | Added `sendResize()` method (lines 192-215) |
| `service/src/routes/terminals.ts` | Added `POST /api/terminals/:budId/resize` endpoint (lines 81-96) |
| `web/src/App.tsx` | Added `sendTerminalResizeRef`, `sendTerminalResize`, modified `fitTerminal` |

## Testing

1. **Manual test**: Run `claude` in terminal, verify UI renders correctly
2. **Resize test**: Drag browser window, verify terminal re-renders
3. **Panel toggle test**: Open/close session panel, verify terminal adjusts
4. **Reconnection test**: Restart service, verify terminal dimensions persist after reconnect

## Future Considerations

- **Initial size from Bud**: Consider having Bud report actual tmux size in `terminal_status` so frontend can verify sync
- **Size mismatch detection**: Log warning if xterm.js size differs significantly from Bud-reported size
- **Terminal tabs**: If multiple terminals are supported, each needs independent resize tracking
