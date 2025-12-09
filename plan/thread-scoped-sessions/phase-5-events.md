# Phase 5: Event Bus & Gateway

_Status: Complete_

## Overview

Update event routing to use session-keyed channels instead of bud-keyed channels. The gateway routes incoming terminal frames by `session_id`.

**Files:**
- `service/src/runtime/event-bus.ts` (update)
- `service/src/ws/gateway.ts` (update)

---

## Current State

### TerminalEventBus

```typescript
// Current: bud-keyed channels
export class TerminalEventBus extends SseEventBus {}

// Usage: emit(budId, event)
this.events.emit(budId, { event: "terminal.output", data: {...} });
```

### Gateway Terminal Frame Handling

```typescript
// Current: no session_id in frames
const TerminalOutputSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_output"),
  seq: z.number(),
  data: z.string(),
  byte_offset: z.number(),
  // Missing: session_id
});

// Handler uses budId
async handleTerminalOutput(raw: unknown) {
  // ...
  await this.terminalManager.handleTerminalOutput(this.state.budId, {
    seq: result.data.seq,
    data: result.data.data,
    byte_offset: result.data.byte_offset,
  });
}
```

---

## Target State

### TerminalSessionEventBus

```typescript
// New: session-keyed channels (rename for clarity)
export class TerminalSessionEventBus extends SseEventBus {}

// Usage: emit(sessionId, event)
this.events.emit(sessionId, { event: "terminal.output", data: {...} });
```

### Gateway with session_id

```typescript
// New: session_id required in all terminal frames
const TerminalOutputSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_output"),
  session_id: z.string(),  // REQUIRED
  seq: z.number(),
  data: z.string(),
  byte_offset: z.number(),
});

// Handler uses sessionId
async handleTerminalOutput(raw: unknown) {
  // ...
  await this.sessionManager.handleTerminalOutput(result.data.session_id, {
    seq: result.data.seq,
    data: result.data.data,
    byte_offset: result.data.byte_offset,
  });
}
```

---

## Implementation

### 1. Update Event Bus

```typescript
// service/src/runtime/event-bus.ts

// Rename for clarity (session-keyed)
export class TerminalSessionEventBus extends SseEventBus {
  // Add callback-style attach for use in routes
  attach(sessionId: string, callback: (event: SseEvent) => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(callback);
    this.listeners.set(sessionId, listeners);

    // Replay buffer
    const buffer = this.buffers.get(sessionId) ?? [];
    for (const event of buffer) {
      callback(event);
    }

    return () => {
      const set = this.listeners.get(sessionId);
      if (!set) return;
      set.delete(callback);
      if (set.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }
}

// Keep old name as alias during transition (remove later)
export { TerminalSessionEventBus as TerminalEventBus };
```

### 2. Update Gateway Schemas

```typescript
// service/src/ws/gateway.ts

// Add session_id to all terminal frame schemas
const TerminalStatusSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_status"),
  session_id: z.string(),
  state: z.string(),
  info: z.record(z.unknown()).optional(),
});

const TerminalOutputSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_output"),
  session_id: z.string(),
  seq: z.number().int().nonnegative(),
  data: z.string(),
  byte_offset: z.number().int().nonnegative(),
});

const TerminalReadySchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_ready"),
  session_id: z.string(),
  assessment: z.record(z.unknown()),
});

const TerminalCaptureResponseSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_capture_response"),
  session_id: z.string(),
  request_id: z.string(),
  output: z.string(),
  output_bytes: z.number(),
  lines_captured: z.number(),
  error: z.string().nullable(),
});
```

### 3. Update Gateway Handlers

```typescript
// service/src/ws/gateway.ts

// Replace terminalManager with sessionManager
private readonly sessionManager: TerminalSessionManager;

constructor(
  server: FastifyInstance,
  socket: WebSocket,
  sessionManager: TerminalSessionManager,  // Changed
  // ...
) {
  this.sessionManager = sessionManager;
  // ...
}

// Update handlers to use session_id
private async handleTerminalStatus(raw: unknown) {
  if (!config.terminalEnabled) return;
  if (this.state.kind !== "connected") return;

  const result = TerminalStatusSchema.safeParse(raw);
  if (!result.success) {
    this.server.log.warn({ error: result.error.message }, "Invalid terminal_status frame");
    return;
  }

  const sessionId = result.data.session_id;
  await this.sessionManager.handleTerminalStatus(sessionId, {
    state: result.data.state,
    info: result.data.info,
  });
}

private async handleTerminalOutput(raw: unknown) {
  if (!config.terminalEnabled) return;
  if (this.state.kind !== "connected") return;

  const result = TerminalOutputSchema.safeParse(raw);
  if (!result.success) {
    this.server.log.warn({ error: result.error.message }, "Invalid terminal_output frame");
    return;
  }

  const sessionId = result.data.session_id;
  this.server.log.info({
    sessionId,
    seq: result.data.seq,
    byte_offset: result.data.byte_offset,
  }, "terminal_output frame received");

  await this.sessionManager.handleTerminalOutput(sessionId, {
    seq: result.data.seq,
    data: result.data.data,
    byte_offset: result.data.byte_offset,
  });
}

private async handleTerminalReady(raw: unknown) {
  if (!config.terminalEnabled) return;
  if (this.state.kind !== "connected") return;

  const result = TerminalReadySchema.safeParse(raw);
  if (!result.success) {
    this.server.log.warn({ error: result.error.message }, "Invalid terminal_ready frame");
    return;
  }

  const sessionId = result.data.session_id;
  await this.sessionManager.handleTerminalReady(sessionId, result.data.assessment);
}

private async handleTerminalCaptureResponse(raw: unknown) {
  if (!config.terminalEnabled) return;
  if (this.state.kind !== "connected") return;

  const result = TerminalCaptureResponseSchema.safeParse(raw);
  if (!result.success) {
    this.server.log.warn({ error: result.error.message }, "Invalid terminal_capture_response");
    return;
  }

  const sessionId = result.data.session_id;
  this.sessionManager.handleCaptureResponse(sessionId, {
    requestId: result.data.request_id,
    output: result.data.output,
    outputBytes: result.data.output_bytes,
    linesCaptured: result.data.lines_captured,
    error: result.data.error,
  });
}
```

### 4. Update Gateway Construction

```typescript
// service/src/server.ts or wherever gateway is instantiated

// Before
const gateway = new BudGateway(server, socket, terminalManager, ...);

// After
const gateway = new BudGateway(server, socket, sessionManager, ...);
```

### 5. Update Instance ID on Connection

When a Bud connects, update any pending sessions with the instance_id:

```typescript
// service/src/ws/gateway.ts - in handleHello or similar

private async onBudConnected(budId: string, wsSessionId: string) {
  // Update any pending sessions for this Bud with the instance_id
  await db.update(terminalSessionTable)
    .set({ instanceId: wsSessionId })
    .where(and(
      eq(terminalSessionTable.budId, budId),
      eq(terminalSessionTable.state, "pending"),
    ));
}
```

---

## Implementation Checklist

- [ ] Update `service/src/runtime/event-bus.ts`
  - [ ] Rename `TerminalEventBus` to `TerminalSessionEventBus`
  - [ ] Add callback-style `attach()` method
- [ ] Update `service/src/ws/gateway.ts`
  - [ ] Add `session_id` to all terminal frame schemas
  - [ ] Update handlers to extract and use `session_id`
  - [ ] Replace `terminalManager` with `sessionManager`
  - [ ] Update `handleTerminalStatus` to use sessionId
  - [ ] Update `handleTerminalOutput` to use sessionId
  - [ ] Update `handleTerminalReady` to use sessionId
  - [ ] Update `handleTerminalCaptureResponse` to use sessionId
- [ ] Update gateway instantiation in server setup
- [ ] Add instance_id update on Bud connection

---

## Frame Changes Summary

| Frame | Before | After |
|-------|--------|-------|
| `terminal_status` | No session_id | `session_id: string` required |
| `terminal_output` | No session_id | `session_id: string` required |
| `terminal_ready` | No session_id | `session_id: string` required |
| `terminal_capture_response` | No session_id | `session_id: string` required |

---

## Notes

- All terminal frames now require `session_id`
- Event bus channels are keyed by `sessionId` (not `budId`)
- Gateway extracts `session_id` from frame and routes to session manager
- Instance ID is set when Bud connects (tracks which WS connection owns which sessions)
