# Design: Terminal Input Latency & Buffering

## Problem Statement

The current terminal architecture routes all user input through a multi-hop path:

```
Browser → Backend Service → WebSocket → Bud Agent → tmux
```

And output follows the reverse:

```
tmux → Bud Agent → WebSocket → Backend Service → SSE → Browser
```

**Local development**: This works well with sub-millisecond latency between hops.

**Production deployment**: With geographically distributed components, each hop adds latency:
- Browser ↔ Backend: 20-100ms (depending on region)
- Backend ↔ Bud: 10-200ms (depending on Bud location)
- Round-trip for a single keystroke: 60-600ms

This latency manifests as:
1. **Typing lag**: Characters appear delayed after keypress
2. **Echo delay**: In raw/character mode (e.g., vim, less), each keystroke waits for server echo
3. **Interactive command issues**: Tab completion, arrow keys, Ctrl+C feel sluggish
4. **Scroll lag**: Scrolling through output (e.g., in less) feels unresponsive

## Current Implementation

### Input Flow
1. User types in xterm.js
2. `term.onData()` fires immediately
3. `sendTerminalInput()` POSTs to `/api/terminals/:budId/input`
4. Backend dispatches `terminal_input` frame to Bud via WebSocket
5. Bud writes to tmux stdin
6. tmux echoes character (if echo enabled)
7. Output flows back via pipe-pane → Bud → Backend → SSE → xterm

### Output Flow
1. tmux writes to pipe-pane log file
2. Bud watches file, reads new bytes
3. Bud sends `terminal_output` frame via WebSocket
4. Backend persists to DB, emits SSE event
5. Browser receives SSE, writes to xterm

### Latency Characteristics
- **Input**: Every keystroke is a separate HTTP POST (no batching)
- **Output**: Streamed via SSE with chunking at Bud level (~16KB max per frame)
- **No local echo**: xterm waits for server response to display typed characters

---

## Potential Solutions

### Solution 1: Local Echo with Reconciliation

**Concept**: xterm.js immediately echoes user input locally, then reconciles when server response arrives.

**How it works**:
1. User types character
2. xterm.js immediately writes character to terminal (local echo)
3. Input is sent to backend as usual
4. When server echo arrives, detect and suppress duplicate
5. If server response differs (e.g., password field), correct the display

**Pros**:
- Zero perceived input latency for normal typing
- No backend changes required
- Works with existing architecture

**Cons**:
- Complex reconciliation logic
- Breaks for raw mode applications (vim, less) where echo behavior varies
- Password prompts would show characters briefly before masking
- Difficult to handle control sequences (arrow keys, Ctrl+*)

**Implementation complexity**: High

---

### Solution 2: WebSocket Direct Connection (Browser ↔ Bud)

**Concept**: Browser connects directly to Bud for terminal I/O, bypassing backend for data plane.

**How it works**:
1. Browser requests terminal session from backend
2. Backend returns Bud's direct WebSocket URL + auth token
3. Browser opens WebSocket directly to Bud
4. All terminal I/O flows Browser ↔ Bud
5. Backend only handles control plane (create, destroy, auth)

**Pros**:
- Eliminates one network hop (potentially 50% latency reduction)
- Bud can implement optimized terminal protocols
- Backend not bottlenecked by terminal traffic

**Cons**:
- Requires Bud to be directly accessible from browser (NAT/firewall issues)
- Security: exposing Bud's WebSocket to internet
- Loses backend's ability to log/audit terminal traffic
- Requires significant protocol changes

**Implementation complexity**: Very High

---

### Solution 3: Input Batching with Debounce

**Concept**: Batch rapid keystrokes into single requests to reduce HTTP overhead.

**How it works**:
1. User types characters
2. Accumulate input in buffer for 10-50ms
3. Send batched input in single POST
4. Bud writes entire buffer to tmux at once

**Pros**:
- Reduces HTTP request count significantly
- Simple to implement
- Works with existing architecture

**Cons**:
- Adds artificial latency (debounce delay)
- Doesn't help with single keystroke latency
- May feel laggy for slow typists (each character waits for batch window)
- Doesn't address output latency

**Implementation complexity**: Low

**Variant**: Adaptive batching that adjusts debounce based on typing speed.

---

### Solution 4: Predictive Input with Speculative Execution

**Concept**: Send input immediately but also predict likely outputs for instant feedback.

**How it works**:
1. User types character
2. Send to server immediately (no batching)
3. For common patterns (printable chars in shell), predict echo
4. Display prediction immediately, mark as "unconfirmed"
5. When server responds, confirm or correct

**Pros**:
- Instant feedback for most typing
- Graceful degradation for unpredictable scenarios

**Cons**:
- Very complex prediction logic
- Many edge cases (prompts, editors, etc.)
- Visual artifacts when prediction is wrong
- Requires understanding shell state

**Implementation complexity**: Very High

---

### Solution 5: MOSH-style Protocol (SSP)

**Concept**: Implement State Synchronization Protocol like Mosh for terminal state.

**How it works**:
1. Both client and server maintain terminal state (screen buffer)
2. Client sends input + predicted state hash
3. Server applies input, sends state diff if client prediction wrong
4. Client speculatively renders predicted state
5. Server state is authoritative; client corrects on mismatch

**Reference**: [Mosh paper](https://mosh.org/mosh-paper.pdf)

**Pros**:
- Excellent perceived latency
- Handles packet loss gracefully
- Works well over high-latency connections
- Proven approach (Mosh is widely used)

**Cons**:
- Requires complete protocol redesign
- Both client and server need terminal emulator state
- Significant implementation effort
- May not work well with existing tmux integration

**Implementation complexity**: Very High

---

## Recommendation

For the PoC, I recommend **Solution 3 (Input Batching)** as a low-effort improvement:

1. **Immediate**: Add 20ms debounce to input batching
2. **Measure**: Instrument actual latency in production environment
3. **Iterate**: Based on real measurements, decide if more complex solutions are needed

If latency remains problematic after measurement, **Solution 1 (Local Echo)** could be partially implemented for printable characters in the shell prompt (not in applications like vim).

Long-term, if terminal becomes a core product feature, **Solution 5 (MOSH-style)** would provide the best user experience but requires significant investment.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| TBD | | |

---

## Open Questions

1. What is acceptable latency for typing? (<100ms feels instant, <200ms acceptable)
2. Should we measure real production latency before optimizing?
3. Is direct Bud connectivity feasible given typical deployment environments?
4. Do we need to support raw-mode applications (vim, etc.) with low latency?
