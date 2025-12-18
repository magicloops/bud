# Debug: Terminal Resize Event Spam Investigation

**Date:** 2025-12-17
**Status:** 🔍 Investigated - Ready for Fix
**Symptom:** Tons of resize events firing in Network tab for every terminal stream event, even when browser window isn't resizing

---

## Root Cause

**`fitTerminal()` is called on every terminal output SSE event.**

**File:** `web/src/routes/$budId/$threadId.tsx:630-646`

```typescript
const handleOutput = (event: MessageEvent) => {
  try {
    lastSseEventTimeRef.current = Date.now()
    const raw = event.data ?? ''
    const payload = JSON.parse(raw) as { data?: string }
    if (payload.data) {
      const decoded = decodeTerminalData(payload.data)
      if (decoded && terminalRef.current) {
        terminalRef.current.write(decoded)
        setTerminalHasOutput(true)
        fitTerminal()  // ← PROBLEM: Called on EVERY terminal output event!
      }
    }
  } catch (err) {
    console.error('Failed to parse terminal.output SSE', err)
  }
}
```

Since the bud daemon polls for terminal output every **50ms** (`bud/src/main.rs:1369`), this can trigger resize up to **20 times per second** during active terminal output.

---

## Full Event Chain

```
Bud Daemon (polls every 50ms)
    │
    ▼ WebSocket: terminal_output
Service Gateway (gateway.ts:378-409)
    │
    ▼ SSE: terminal.output
Frontend handleOutput() ($threadId.tsx:630-646)
    │
    ├─► terminalRef.current.write(decoded)
    │
    └─► fitTerminal()  ← TRIGGERS RESIZE
            │
            ├─► fitAddon.fit()
            │
            └─► sendTerminalResize(cols, rows)
                    │
                    ▼ HTTP POST: /api/threads/:threadId/terminal/resize
            Backend Resize Endpoint (threads.ts:615-637)
                    │
                    ▼ terminalSessionManager.sendResize()
            Terminal Session Manager (terminal-session-manager.ts:415-445)
                    │
                    ├─► Updates database with cols/rows
                    │
                    └─► WebSocket: terminal_resize → Bud Daemon
```

---

## All Places Where fitTerminal() is Called

| Line | Location | Trigger | Appropriate? |
|------|----------|---------|--------------|
| 168 | `resetTerminal()` | Manual reset | ✅ Yes |
| 247 | Terminal init | After xterm ready | ✅ Yes |
| 254 | `window.resize` handler | Browser window resize | ✅ Yes |
| 284 | Thread panel effect | Panel toggle changes layout | ✅ Yes |
| **640** | **`handleOutput()`** | **Every terminal output chunk** | ❌ **NO** |
| 830 | History load | After restoring history | ✅ Yes |

---

## Why This Happens

The `fitTerminal()` function does two things:
1. Calls `fitAddon.fit()` - resizes xterm to fit its container
2. Calls `sendTerminalResize(cols, rows)` - sends dimensions to backend

The problem is that `fitTerminal()` is called unconditionally in `handleOutput()`, likely added to ensure the terminal stays properly sized. But:

1. **The container size hasn't changed** - only the content has
2. **xterm handles content rendering internally** - no `fit()` needed for writes
3. **Backend resize is completely unnecessary** when dimensions haven't changed

---

## Impact

During heavy terminal output (e.g., `npm install`, `cat` large file):

| Metric | Impact |
|--------|--------|
| HTTP requests | Up to 20 POST /resize per second |
| Database writes | Update cols/rows on every call |
| WebSocket messages | terminal_resize sent to bud daemon |
| Network overhead | Unnecessary traffic |
| Backend CPU | Processing redundant requests |

---

## No Debouncing Exists

Searched entire `web/` directory for "debounce" and "throttle" - **none found**. The codebase has no rate-limiting for resize operations.

---

## Proposed Solutions

### Option 1: Remove fitTerminal() from handleOutput (Simplest)

```typescript
const handleOutput = (event: MessageEvent) => {
  try {
    lastSseEventTimeRef.current = Date.now()
    const raw = event.data ?? ''
    const payload = JSON.parse(raw) as { data?: string }
    if (payload.data) {
      const decoded = decodeTerminalData(payload.data)
      if (decoded && terminalRef.current) {
        terminalRef.current.write(decoded)
        setTerminalHasOutput(true)
        // fitTerminal() ← REMOVE THIS
      }
    }
  } catch (err) {
    console.error('Failed to parse terminal.output SSE', err)
  }
}
```

**Pros:**
- Simplest fix
- Eliminates all unnecessary resize calls
- xterm handles content rendering internally

**Cons:**
- Need to verify no edge cases where fit was needed

**Risk:** Low - xterm doesn't need fit() for content writes

---

### Option 2: Only Send Resize if Dimensions Changed

```typescript
const fitTerminal = useCallback(() => {
  if (!terminalReadyRef.current) return
  const addon = fitAddonRef.current
  const term = terminalRef.current
  const pane = terminalPaneRef.current
  if (!addon || !term || !pane || !pane.isConnected || !term.element) return

  const prevCols = term.cols
  const prevRows = term.rows

  try {
    addon.fit()

    // Only send resize to backend if dimensions actually changed
    if (term.cols !== prevCols || term.rows !== prevRows) {
      if (term.cols > 0 && term.rows > 0) {
        sendTerminalResizeRef.current(term.cols, term.rows)
      }
    }
  } catch (err) {
    console.warn('Failed to fit terminal', err)
  }
}, [])
```

**Pros:**
- Still calls `fit()` locally (safe)
- Only sends network request when dimensions actually change
- Handles all call sites, not just `handleOutput`

**Cons:**
- Slightly more complex
- Still calling `fit()` unnecessarily (minor CPU cost)

**Risk:** Very low - just adds a guard condition

---

### Option 3: Debounce Backend Resize Call

```typescript
const sendTerminalResizeDebounced = useMemo(() => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let lastCols = 0
  let lastRows = 0

  return (cols: number, rows: number) => {
    // Skip if dimensions haven't changed
    if (cols === lastCols && rows === lastRows) return
    lastCols = cols
    lastRows = rows

    if (timeoutId) clearTimeout(timeoutId)
    timeoutId = setTimeout(() => {
      sendTerminalResize(cols, rows)
    }, 100)  // 100ms debounce
  }
}, [sendTerminalResize])
```

**Pros:**
- Rate-limits backend calls
- Handles rapid consecutive changes
- Combines dimension check with debounce

**Cons:**
- More complex
- Adds 100ms delay to legitimate resizes

**Risk:** Low, but introduces delay

---

### Option 4: Remove fit() from handleOutput + Guard in fitTerminal (Recommended)

Combine Options 1 and 2:
1. Remove `fitTerminal()` from `handleOutput()` - it's not needed there
2. Add dimension check in `fitTerminal()` as a safety net for all other call sites

This is the most robust solution.

---

## Files to Modify

| File | Change |
|------|--------|
| `web/src/routes/$budId/$threadId.tsx` | Remove `fitTerminal()` from `handleOutput()` and/or add dimension guard |

---

## Testing Checklist

After fix, verify:
- [ ] Network tab shows no resize requests during normal terminal output
- [ ] Resize still works when browser window is resized
- [ ] Resize still works when thread panel is toggled
- [ ] Terminal displays correctly after receiving output
- [ ] Terminal history loads correctly (uses fit on line 830)

---

## Related Code Locations

**Frontend:**
- `web/src/routes/$budId/$threadId.tsx:139-155` - `fitTerminal()` function
- `web/src/routes/$budId/$threadId.tsx:254` - Window resize handler
- `web/src/routes/$budId/$threadId.tsx:284` - Panel toggle effect
- `web/src/routes/$budId/$threadId.tsx:340-354` - `sendTerminalResize()` function
- `web/src/routes/$budId/$threadId.tsx:630-646` - `handleOutput()` SSE handler

**Backend:**
- `service/src/routes/threads.ts:615-637` - Resize endpoint
- `service/src/runtime/terminal-session-manager.ts:415-445` - `sendResize()` method

**Bud Daemon:**
- `bud/src/main.rs:1369` - 50ms polling interval for terminal output

---

*Created: 2025-12-17*
