# Design: Terminal Connection Status UI

## Problem Statement

When the backend service restarts (e.g., during development with hot-reload), there's a period where:
1. The Bud daemon is disconnected/reconnecting to the service
2. The frontend SSE stream is disconnected/reconnecting
3. The terminal appears functional but input may be lost or output may not display

Users have no visual indication that the connection is degraded, leading to confusion when typing doesn't produce visible results.

## Goals

- Clearly communicate connection state to users
- Prevent user frustration from "silent failures"
- Gracefully handle reconnection without losing context
- Minimize visual disruption during brief disconnects

## Current Architecture

```
Frontend (React)                    Service (Fastify)                 Bud (Rust)
     |                                    |                               |
     |-- SSE: /api/terminals/:budId/stream -->|                           |
     |                                    |<-- WebSocket ----------------->|
     |-- POST: /api/terminals/:budId/input -->|                           |
     |                                    |-- terminal_input frame ------->|
     |                                    |<-- terminal_output frame ------|
     |<-- SSE: terminal.output -----------|                               |
```

### Current State Tracking

**Frontend (App.tsx):**
- `terminalState`: string - terminal lifecycle state (`idle`, `creating`, `ready`, `active`)
- SSE EventSource with reconnect logic (exponential backoff)
- No explicit "disconnected" or "reconnecting" state

**Service:**
- WebSocket connection to Bud tracked in `sessions` Map
- SSE connections tracked via `TerminalEventBus` listeners

**Bud:**
- WebSocket connection state (connected/disconnected)
- Automatic reconnect with backoff

## Design Options

### Option A: Overlay Banner with Reconnecting State

Add a prominent overlay banner when the connection is lost.

**UI Changes:**
- Add `connectionState: 'connected' | 'reconnecting' | 'disconnected'` to frontend state
- Show a banner overlay on the terminal pane:
  - Reconnecting: Yellow/orange banner "Reconnecting to terminal..." with spinner
  - Disconnected: Red banner "Terminal disconnected. Retrying..." with retry count
- Terminal remains visible but dimmed underneath
- Input is buffered or disabled during disconnect

**Pros:**
- Very clear indication of connection state
- User knows to wait before typing
- Terminal history remains visible

**Cons:**
- Visually disruptive for brief disconnects
- May cause anxiety if shown too eagerly

**Implementation Complexity:** Low

---

### Option B: Subtle Status Indicator in Terminal Status Bar

Enhance the existing terminal status bar with connection state.

**UI Changes:**
- Extend the existing status bar (currently shows "Terminal: {state}")
- Add connection indicator icon/text:
  - Connected: Green dot or checkmark (or just hide indicator)
  - Reconnecting: Yellow pulsing dot + "Reconnecting..."
  - Disconnected: Red dot + "Disconnected"
- Keep terminal fully interactive (optimistic UI)
- Queue input during disconnect, replay on reconnect

**Pros:**
- Non-intrusive for brief disconnects
- Matches existing UI patterns
- Terminal remains usable

**Cons:**
- Users might miss the indicator
- Input queuing adds complexity
- Could lose input if reconnect fails

**Implementation Complexity:** Medium

---

### Option C: Progressive Disclosure with Timeout

Start subtle, escalate visibility based on disconnect duration.

**UI Changes:**
- 0-2 seconds: No visual change (handles brief blips)
- 2-5 seconds: Status bar shows "Reconnecting..." with subtle pulse
- 5+ seconds: Overlay appears with more detail and manual retry option
- 30+ seconds: Show "Connection lost" with option to reload page

**Behavior:**
- Input buffered during first 5 seconds
- Input disabled after 5 seconds (show toast explaining why)
- Clear visual feedback when connection restores

**Pros:**
- Doesn't overreact to brief disconnects
- Escalates appropriately for longer outages
- Balances UX for different scenarios

**Cons:**
- More complex state machine
- Multiple UI states to design/test
- Thresholds may need tuning

**Implementation Complexity:** High

---

### Option D: Toast Notifications Only

Use toast/snackbar notifications instead of inline UI changes.

**UI Changes:**
- Show toast when SSE disconnects: "Terminal connection lost, reconnecting..."
- Show success toast when reconnected: "Terminal reconnected"
- Terminal UI unchanged during disconnect
- Input continues to be sent (may fail silently)

**Pros:**
- Minimal UI changes
- Non-blocking
- Easy to implement

**Cons:**
- Toasts can be missed or dismissed
- No persistent indication of state
- Input may be lost without clear feedback

**Implementation Complexity:** Very Low

---

### Option E: Terminal Freeze with Visual Indicator

Freeze the terminal display and show a reconnection state.

**UI Changes:**
- On disconnect:
  - Add CSS filter (grayscale/dim) to terminal
  - Show small floating badge: "Reconnecting..."
  - Disable input (show cursor as "not-allowed")
- On reconnect:
  - Remove filter
  - Flash green border briefly
  - Re-enable input

**Pros:**
- Clear that terminal is non-functional
- Prevents wasted typing
- Visual "thaw" when reconnected is satisfying

**Cons:**
- May feel jarring
- Grayscale might be hard to read
- Loses "always on" feel

**Implementation Complexity:** Low-Medium

---

## Recommendation

**Option C (Progressive Disclosure)** provides the best user experience but has high implementation complexity.

For an initial implementation, consider **Option B (Status Indicator)** combined with elements of **Option E (Visual Dimming)**:

1. Add connection state to terminal status bar (always visible)
2. After 2 seconds of disconnect, dim the terminal slightly
3. Disable input during disconnect with clear cursor feedback
4. Show brief "Reconnected" indicator when connection restores

This balances:
- Clear communication of state
- Non-disruptive for brief disconnects
- Reasonable implementation effort
- Good foundation to build toward Option C later

## Technical Implementation Notes

### State to Track

```typescript
type TerminalConnectionState =
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

// In App.tsx
const [terminalConnection, setTerminalConnection] = useState<TerminalConnectionState>('connected');
const [disconnectTime, setDisconnectTime] = useState<number | null>(null);
```

### SSE Event Handling

```typescript
source.addEventListener('open', () => {
  setTerminalConnection('connected');
  setDisconnectTime(null);
});

source.onerror = () => {
  setTerminalConnection('reconnecting');
  setDisconnectTime(prev => prev ?? Date.now());
  // existing reconnect logic...
};
```

### Bud Online Status

Consider also tracking whether the Bud itself is online via the existing bud status. If the Bud is offline, show a different message ("Bud offline" vs "Reconnecting to service").

## Open Questions

1. Should we buffer/queue input during brief disconnects, or just disable?
2. How do we handle the case where Bud is offline vs service is restarting?
3. Should we add a manual "Reconnect" button for stuck states?
4. Do we need to refresh terminal history after reconnect to catch missed output?
