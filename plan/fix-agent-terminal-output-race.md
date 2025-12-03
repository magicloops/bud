# Plan: Fix Agent Terminal Output Race Condition & Stale Data

## Problem Statement

The agent doesn't see the actual output from terminal commands due to two related issues:

1. **Race Condition (Issue 3):** The readiness signal fires before terminal output is stored in the database. Agent calls `tailOutput()` immediately after readiness, but the output hasn't been persisted yet.

2. **No Cursor Tracking (Issue 2):** `tailOutput()` always returns the last N rows with no way to track "what I've already seen", causing duplicate/stale data.

## Current Architecture (Broken)

```
Bud                    Gateway                      TerminalManager              Agent
 │                        │                               │                        │
 │                        │                               │<── sendInput("ls") ────│
 │<── terminal_input ─────│                               │                        │
 │                        │                               │                        │
 │ (executes)             │                               │                        │
 │                        │                               │                        │
 │── terminal_output(1) ──>│                               │                        │
 │── terminal_output(2) ──>│── handleTerminalOutput() ───>│ async DB insert...     │
 │── terminal_ready ──────>│── handleTerminalReady() ────>│ readiness.set() ───────>│
 │                        │                               │                        │ waitForReadiness()
 │                        │                               │                        │ returns!
 │                        │                               │                        │
 │                        │                               │<── tailOutput() ───────│
 │                        │                               │                        │
 │                        │                    (DB insert still in progress!)      │
 │                        │                               │── stale data ─────────>│
 │                        │                               │                        │
 │                        │                               │                    [wrong response]
```

## Root Cause Analysis

### Race Condition

1. `handleTerminalReady()` updates in-memory cache synchronously:
   ```typescript
   // terminal-manager.ts:242-249
   async handleTerminalReady(budId: string, assessment: unknown) {
     this.readiness.set(budId, { assessment, updatedAt: Date.now() });  // Instant
     this.events.emit(budId, { event: "terminal.ready", data: { assessment } });
   }
   ```

2. `handleTerminalOutput()` does async DB insert:
   ```typescript
   // terminal-manager.ts:185-240
   async handleTerminalOutput(budId: string, frame: TerminalOutputFrame) {
     await db.insert(terminalOutputTable).values({ ... });  // Slow!
     this.events.emit(budId, { event: "terminal.output", data: { ... } });
   }
   ```

3. Agent reads from DB immediately after readiness:
   ```typescript
   // agent-service.ts:898-902
   const readiness = await this.terminalManager.waitForReadiness(budId, timeout);
   const tail = await this.terminalManager.tailOutput(budId, maxBytes);  // DB read
   ```

### No Cursor Tracking

`tailOutput()` has no way to request "output since sequence X":
```typescript
// terminal-manager.ts:296-326
async tailOutput(budId: string, maxBytes: number) {
  const rows = await db
    .select({ seq, data })
    .from(terminalOutputTable)
    .where(eq(terminalOutputTable.budId, budId))
    .orderBy(desc(terminalOutputTable.seq))
    .limit(200);  // Always returns same last 200 rows
  // ...
}
```

## Proposed Solution

### Approach: In-Memory Output Ring Buffer

Instead of relying on the database for recent output, maintain an in-memory ring buffer per terminal. This provides:

1. **Instant availability** - Output is available immediately when readiness fires
2. **Sequence tracking** - Can request "output since seq X"
3. **Consistent ordering** - Ring buffer maintains insertion order
4. **DB as backup** - Database still used for persistence/history, but not for real-time reads

### Design

```
Bud                    Gateway                      TerminalManager              Agent
 │                        │                               │                        │
 │                        │                               │<── sendInput("ls") ────│
 │<── terminal_input ─────│                               │ lastSeqBeforeInput=N   │
 │                        │                               │                        │
 │ (executes)             │                               │                        │
 │                        │                               │                        │
 │── terminal_output(1) ──>│── handleTerminalOutput() ───>│                        │
 │                        │                               │ ringBuffer.push(1)     │
 │                        │                               │ async DB insert...     │
 │── terminal_output(2) ──>│── handleTerminalOutput() ───>│                        │
 │                        │                               │ ringBuffer.push(2)     │
 │── terminal_ready ──────>│── handleTerminalReady() ────>│                        │
 │                        │                               │ readiness.set() ───────>│
 │                        │                               │                        │ waitForReadiness()
 │                        │                               │                        │ returns!
 │                        │                               │                        │
 │                        │                               │<── getOutputSince(N) ──│
 │                        │                               │                        │
 │                        │                               │── chunks 1,2 ─────────>│
 │                        │                               │   (from ring buffer!)  │
 │                        │                               │                        │
 │                        │                               │                    [correct response]
```

## Implementation Plan

### Phase 1: Add In-Memory Ring Buffer

**File: `service/src/runtime/terminal-manager.ts`**

1. Add ring buffer data structure:
   ```typescript
   interface OutputChunk {
     seq: number;
     data: Buffer;
     timestamp: number;
   }

   interface TerminalBuffer {
     chunks: OutputChunk[];
     totalBytes: number;
     maxBytes: number;  // e.g., 1MB per terminal
   }

   // Add to TerminalManager class
   private outputBuffers = new Map<string, TerminalBuffer>();
   ```

2. Update `handleTerminalOutput()` to write to ring buffer first:
   ```typescript
   async handleTerminalOutput(budId: string, frame: TerminalOutputFrame) {
     const data = Buffer.from(frame.data, "base64");

     // Write to ring buffer immediately (sync)
     this.appendToBuffer(budId, {
       seq: frame.seq,
       data,
       timestamp: Date.now()
     });

     // Emit SSE event immediately (from buffer)
     this.events.emit(budId, {
       event: "terminal.output",
       data: { data: frame.data, seq: frame.seq }
     });

     // Async DB insert (for persistence)
     await db.insert(terminalOutputTable).values({
       budId,
       seq: frame.seq,
       data: frame.data,
       byteOffset: frame.offset ?? 0
     }).onConflictDoNothing();  // Handle duplicates
   }
   ```

3. Add buffer management methods:
   ```typescript
   private appendToBuffer(budId: string, chunk: OutputChunk): void {
     let buffer = this.outputBuffers.get(budId);
     if (!buffer) {
       buffer = { chunks: [], totalBytes: 0, maxBytes: 1024 * 1024 };  // 1MB
       this.outputBuffers.set(budId, buffer);
     }

     buffer.chunks.push(chunk);
     buffer.totalBytes += chunk.data.length;

     // Trim old chunks if over limit
     while (buffer.totalBytes > buffer.maxBytes && buffer.chunks.length > 1) {
       const removed = buffer.chunks.shift()!;
       buffer.totalBytes -= removed.data.length;
     }
   }

   getLastSeq(budId: string): number {
     const buffer = this.outputBuffers.get(budId);
     if (!buffer || buffer.chunks.length === 0) return 0;
     return buffer.chunks[buffer.chunks.length - 1].seq;
   }
   ```

### Phase 2: Add `getOutputSince()` Method

**File: `service/src/runtime/terminal-manager.ts`**

```typescript
getOutputSince(budId: string, sinceSeq: number, maxBytes: number): {
  data: Buffer;
  lastSeq: number;
  totalBytes: number;
} {
  const buffer = this.outputBuffers.get(budId);
  if (!buffer) {
    return { data: Buffer.alloc(0), lastSeq: 0, totalBytes: 0 };
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let lastSeq = sinceSeq;

  for (const chunk of buffer.chunks) {
    if (chunk.seq > sinceSeq) {
      if (totalBytes + chunk.data.length > maxBytes) break;
      chunks.push(chunk.data);
      totalBytes += chunk.data.length;
      lastSeq = chunk.seq;
    }
  }

  return {
    data: Buffer.concat(chunks),
    lastSeq,
    totalBytes
  };
}
```

### Phase 3: Update Agent to Use New Method

**File: `service/src/agent/agent-service.ts`**

```typescript
private async executeTerminalCall(
  threadId: string,
  directive: Extract<AgentDirective, { type: "tool_call"; tool: string }>
): Promise<TerminalCallResult> {
  const bud = await this.fetchBudForThread(threadId);

  // Capture current sequence before sending input
  const seqBeforeInput = this.terminalManager.getLastSeq(bud.budId);

  await this.terminalManager.ensureTerminal(bud.budId);

  if (directive.tool === "terminal.run") {
    const input = directive.input ?? directive.command ?? "";
    const sent = await this.terminalManager.sendInput(
      bud.budId,
      Buffer.from(input, "utf-8"),
      { source: "agent" }
    );
    if (!sent.ok) {
      throw new Error(sent.error ?? "terminal_input_failed");
    }

    // Wait for terminal to be ready
    const readiness = await this.terminalManager.waitForReadiness(
      bud.budId,
      directive.timeoutMs ?? 5000
    );

    // Get output SINCE we sent the input (from ring buffer - instant!)
    const output = this.terminalManager.getOutputSince(
      bud.budId,
      seqBeforeInput,
      config.terminalOutputBackfillBytes
    );

    const decoded = this.decodeTail(output.data);
    // ... rest of method
  }
  // ... handle other tools
}
```

### Phase 4: Update `tailOutput()` for History/Backfill

Keep `tailOutput()` for historical data but add optional `sinceSeq` parameter:

```typescript
async tailOutput(
  budId: string,
  maxBytes: number,
  options?: { sinceSeq?: number; useBuffer?: boolean }
): Promise<{ data: Buffer; totalBytes: number; lastSeq: number }> {
  // For real-time reads, use buffer
  if (options?.useBuffer) {
    return this.getOutputSince(budId, options.sinceSeq ?? 0, maxBytes);
  }

  // For history/backfill, use database
  let query = db
    .select({ seq: terminalOutputTable.seq, data: terminalOutputTable.data })
    .from(terminalOutputTable)
    .where(eq(terminalOutputTable.budId, budId));

  if (options?.sinceSeq !== undefined) {
    query = query.where(gt(terminalOutputTable.seq, options.sinceSeq));
  }

  const rows = await query
    .orderBy(asc(terminalOutputTable.seq))  // Chronological order
    .limit(200);

  // ... rest of implementation
}
```

### Phase 5: Handle Terminal Reset/Clear

When terminal is reset or bud reconnects:

```typescript
clearBuffer(budId: string): void {
  this.outputBuffers.delete(budId);
}

// Call from appropriate places:
// - When terminal is closed
// - When bud disconnects
// - When terminal is explicitly cleared
```

## Testing Plan

### Unit Tests

1. **Ring buffer append and trim:**
   - Append chunks, verify order preserved
   - Exceed maxBytes, verify oldest chunks removed
   - Verify seq tracking

2. **getOutputSince():**
   - Empty buffer returns empty
   - sinceSeq=0 returns all
   - sinceSeq=N returns only chunks after N
   - maxBytes limit respected

3. **Race condition simulation:**
   - Send output chunks
   - Fire readiness before DB insert completes
   - Verify getOutputSince() returns correct data

### Integration Tests

1. **Agent terminal.run flow:**
   - Agent sends command
   - Bud executes and returns output
   - Agent receives correct output (not stale)

2. **Multiple rapid commands:**
   - Send several commands quickly
   - Each command sees only its own output

3. **Large output handling:**
   - Command produces >1MB output
   - Buffer trims correctly
   - Agent still gets recent output

## Rollback Plan

If issues arise:
1. Revert to DB-only reads
2. Add configurable delay after readiness as stopgap:
   ```typescript
   const readiness = await this.terminalManager.waitForReadiness(budId, timeout);
   await new Promise(r => setTimeout(r, 200));  // Wait for DB flush
   const tail = await this.terminalManager.tailOutput(budId, maxBytes);
   ```

## Files to Modify

| File | Changes |
|------|---------|
| `service/src/runtime/terminal-manager.ts` | Add ring buffer, `getOutputSince()`, update `handleTerminalOutput()` |
| `service/src/agent/agent-service.ts` | Use `getLastSeq()` before input, `getOutputSince()` after readiness |
| `service/src/ws/gateway.ts` | Call `clearBuffer()` on terminal close/disconnect |

## Success Criteria

1. Agent sees correct output for commands it executes
2. No race condition between readiness and output availability
3. `getOutputSince()` returns only new output since specified sequence
4. Performance: Output available to agent within 10ms of readiness signal
5. Memory: Ring buffer stays under 1MB per terminal

## Open Questions

1. Should we keep the DB insert synchronous (await) or fire-and-forget for better performance?
2. What's the right maxBytes for the ring buffer? 1MB? 512KB?
3. Should we expose `sinceSeq` in the REST API for client use?
