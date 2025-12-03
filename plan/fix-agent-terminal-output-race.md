# Plan: Fix Agent Terminal Output Race Condition & Stale Data

## Problem Statement

The agent doesn't see the actual output from terminal commands due to two related issues:

1. **Race Condition (Issue 3):** The readiness signal fires before terminal output is stored in the database. Agent calls `tailOutput()` immediately after readiness, but the output hasn't been persisted yet.

2. **No Cursor Tracking (Issue 2):** `tailOutput()` always returns the last N rows with no way to track "what I've already seen", causing duplicate/stale data.

## Current Architecture Analysis

### Data Flow (Broken)

```
Bud (Rust)                      Service (Node)                    Agent
    │                               │                                │
    │ tmux pipe-pane >> file        │                                │
    │ watcher reads file            │                                │
    │─── terminal_output (WS) ─────>│                                │
    │                               │ handleTerminalOutput()         │
    │                               │   await db.insert(...) 🐢      │
    │                               │   events.emit(SSE)             │
    │                               │                                │
    │─── terminal_ready (WS) ──────>│                                │
    │                               │ handleTerminalReady()          │
    │                               │   readiness.set() ⚡ (sync)    │
    │                               │────────────────────────────────>│
    │                               │                         waitForReadiness() returns!
    │                               │<────────────────────────────────│
    │                               │                         tailOutput() 🐢
    │                               │                           (reads from DB)
    │                               │────────────────────────────────>│
    │                               │                         STALE DATA!
```

### Key Insight: Output is Stored Twice

1. **Bud writes to temp file** via `tmux pipe-pane >> /tmp/bud-terminal-{session}.log`
2. **Service stores chunks in PostgreSQL** via `terminal_output` table

The file IS the source of truth. We're duplicating it into the database just to read it back—and that duplication creates the race condition.

### Code Locations

**Bud file watcher** (`bud/src/main.rs:1142-1203`):
```rust
fn spawn_output_watcher(...) {
    // Reads from log file, sends terminal_output frames via WebSocket
    loop {
        let size = fs::metadata(&log_path).await?.len();
        if size > current_offset {
            // Read new bytes, send as terminal_output
            let payload = json!({
                "type": "terminal_output",
                "seq": seq_no,
                "data": BASE64_STANDARD.encode(&buf),
                "byte_offset": current_offset,
            });
            send_ws_frame(&sender, payload);
        }
        time::sleep(Duration::from_millis(50)).await;
    }
}
```

**Service stores in DB** (`service/src/runtime/terminal-manager.ts:185-240`):
```typescript
async handleTerminalOutput(budId: string, payload: TerminalOutputPayload) {
    await db.insert(terminalOutputTable).values({
        budId,
        seq: payload.seq,
        data: toStore,
        byteOffset: payload.byte_offset
    });
    this.events.emit(budId, { event: "terminal.output", data: {...} });
}
```

**Agent reads from DB** (`service/src/agent/agent-service.ts:898-902`):
```typescript
const readiness = await this.terminalManager.waitForReadiness(budId, timeout);
const tail = await this.terminalManager.tailOutput(budId, maxBytes);  // DB read - STALE!
```

---

## Solution Options

### ❌ Original Plan: In-Memory Ring Buffer

The previous plan proposed adding an in-memory ring buffer in the Service to cache output before it's written to the DB.

**Problems:**
- Adds complexity (another caching layer)
- Still duplicates storage (file → WS → memory → DB)
- Memory pressure with many terminals
- Doesn't solve the underlying design issue

### ✅ Recommended: Byte Offset Tracking (Minimal Change)

The simplest fix: track the byte offset before sending input, then use that offset to request "output since X".

**Why this works:**
- Bud already sends `byte_offset` in every `terminal_output` frame
- We already store `byte_offset` in the database
- Agent just needs to record offset before command, request offset after

**Changes required:**
1. Add method to get current byte offset from Bud status
2. Agent captures offset before `sendInput()`
3. Agent requests output `sinceOffset` after readiness
4. Add `sinceOffset` parameter to `tailOutput()`

**Flow:**
```
Agent                    TerminalManager              Bud
  │                           │                        │
  │── getLastOffset() ───────>│                        │
  │<── offset=1234 ───────────│                        │
  │                           │                        │
  │── sendInput("ls") ───────>│                        │
  │                           │─── terminal_input ────>│
  │                           │                        │ (executes)
  │                           │<── terminal_output ────│
  │                           │<── terminal_ready ─────│
  │                           │                        │
  │── waitForReadiness() ────>│                        │
  │<── ready! ────────────────│                        │
  │                           │                        │
  │── tailOutput(sinceOffset=1234) ──>│                │
  │<── only NEW output ───────│                        │
```

### 🔮 Future: File-Based Storage (For Scale)

For production with S3, we'd eventually want:

1. **Local dev**: Use the file Bud already writes to (no DB storage needed)
2. **Production**: Stream file to S3, store S3 key in DB

This eliminates the race entirely because the file is always current. But this is a larger refactor for later.

---

## Implementation Plan: Byte Offset Tracking

### Phase 1: Track Last Byte Offset in Memory

**File: `service/src/runtime/terminal-manager.ts`**

Add tracking for the last known byte offset per terminal:

```typescript
class TerminalManager {
  // Add alongside existing readiness map
  private lastOffsets = new Map<string, number>();

  async handleTerminalOutput(budId: string, payload: TerminalOutputPayload) {
    // Track the latest byte offset (sync, before any async work)
    const endOffset = payload.byte_offset + Buffer.from(payload.data, "base64").length;
    this.lastOffsets.set(budId, endOffset);

    // ... rest of existing implementation
  }

  getLastOffset(budId: string): number {
    return this.lastOffsets.get(budId) ?? 0;
  }

  clearOffset(budId: string): void {
    this.lastOffsets.delete(budId);
  }
}
```

### Phase 2: Add `sinceOffset` Parameter to tailOutput

**File: `service/src/runtime/terminal-manager.ts`**

```typescript
async tailOutput(
  budId: string,
  maxBytes: number,
  options?: { sinceOffset?: number }
): Promise<{ data: Buffer; totalBytes: number; startOffset: number }> {

  let query = db
    .select({
      seq: terminalOutputTable.seq,
      data: terminalOutputTable.data,
      byteOffset: terminalOutputTable.byteOffset
    })
    .from(terminalOutputTable)
    .where(eq(terminalOutputTable.budId, budId));

  // If sinceOffset provided, only get rows after that offset
  if (options?.sinceOffset !== undefined) {
    query = query.where(gte(terminalOutputTable.byteOffset, options.sinceOffset));
  }

  const rows = await query
    .orderBy(asc(terminalOutputTable.byteOffset))  // Chronological order
    .limit(200);

  if (rows.length === 0) {
    return {
      data: Buffer.alloc(0),
      totalBytes: 0,
      startOffset: options?.sinceOffset ?? 0
    };
  }

  // For sinceOffset queries, we may need to trim the first chunk
  const buffers: Buffer[] = [];
  let startOffset = rows[0].byteOffset;

  for (const row of rows) {
    let buf = Buffer.from(row.data);

    // If first row starts before sinceOffset, trim it
    if (options?.sinceOffset !== undefined && row.byteOffset < options.sinceOffset) {
      const skip = options.sinceOffset - row.byteOffset;
      buf = buf.subarray(skip);
      startOffset = options.sinceOffset;
    }

    buffers.push(buf);
  }

  const combined = Buffer.concat(buffers);

  // Apply maxBytes limit from the end if needed
  const result = combined.length > maxBytes
    ? combined.subarray(combined.length - maxBytes)
    : combined;

  return {
    data: result,
    totalBytes: combined.length,
    startOffset
  };
}
```

### Phase 3: Update Agent to Use Byte Offset

**File: `service/src/agent/agent-service.ts`**

```typescript
private async executeTerminalCall(
  threadId: string,
  directive: Extract<AgentDirective, { type: "tool_call"; tool: string }>
): Promise<TerminalCallResult> {
  const bud = await this.fetchBudForThread(threadId);
  await this.terminalManager.ensureTerminal(bud.budId);

  if (directive.tool === "terminal.observe") {
    // For observe, just get recent output (no offset tracking)
    const tail = await this.terminalManager.tailOutput(
      bud.budId,
      config.terminalOutputBackfillBytes
    );
    // ... existing handling
  }

  // terminal.run - capture offset BEFORE sending input
  const offsetBeforeInput = this.terminalManager.getLastOffset(bud.budId);

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

  // Get output SINCE we sent the input
  const tail = await this.terminalManager.tailOutput(
    bud.budId,
    config.terminalOutputBackfillBytes,
    { sinceOffset: offsetBeforeInput }
  );

  const decoded = this.decodeTail(tail.data);
  // ... rest of existing handling
}
```

### Phase 4: Cleanup on Disconnect

**File: `service/src/ws/gateway.ts`**

```typescript
// In handleDisconnect or similar:
this.terminalManager.clearOffset(budId);
```

**File: `service/src/runtime/terminal-manager.ts`**

```typescript
async closeTerminal(budId: string, reason: string = "requested") {
  // ... existing code ...

  // Clear cached state
  this.readiness.delete(budId);
  this.lastOffsets.delete(budId);  // Add this

  return { ok: true };
}
```

---

## Why This Is Simpler

| Aspect | Ring Buffer Approach | Byte Offset Approach |
|--------|---------------------|---------------------|
| New data structures | `Map<string, { chunks[], totalBytes }>` | `Map<string, number>` |
| Memory overhead | ~1MB per terminal | 8 bytes per terminal |
| Code changes | ~100 lines | ~30 lines |
| Race condition fix | Avoids DB read | Still reads DB, but correct data |
| Complexity | High | Low |

The byte offset approach is simpler because:
1. We already track `byte_offset` in the data
2. We just need to remember "where were we before the command"
3. DB query filters by offset (existing indexed column)

---

## Testing Plan

### Manual Testing

1. **Basic flow:**
   - Send terminal command
   - Verify agent sees correct output (not stale)
   - Verify no duplicate output

2. **Rapid commands:**
   - Send `echo 1`, `echo 2`, `echo 3` quickly
   - Each should see only its own output

3. **Large output:**
   - Run `cat /usr/share/dict/words` or similar
   - Verify agent gets truncated but recent output

### Unit Tests

```typescript
describe('TerminalManager offset tracking', () => {
  it('tracks byte offset from terminal_output frames', () => {
    manager.handleTerminalOutput(budId, {
      seq: 0,
      data: Buffer.from('hello').toString('base64'),
      byte_offset: 0
    });
    expect(manager.getLastOffset(budId)).toBe(5);

    manager.handleTerminalOutput(budId, {
      seq: 1,
      data: Buffer.from(' world').toString('base64'),
      byte_offset: 5
    });
    expect(manager.getLastOffset(budId)).toBe(11);
  });

  it('tailOutput with sinceOffset returns only new data', async () => {
    // Insert test data with various offsets
    // Query with sinceOffset
    // Verify only data after offset returned
  });
});
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `service/src/runtime/terminal-manager.ts` | Add `lastOffsets` map, `getLastOffset()`, `clearOffset()`, update `tailOutput()` with `sinceOffset` |
| `service/src/agent/agent-service.ts` | Capture offset before `sendInput()`, pass `sinceOffset` to `tailOutput()` |
| `service/src/ws/gateway.ts` | Call `clearOffset()` on disconnect |

---

## Success Criteria

1. ✅ Agent sees only output from its own command (not stale/mixed)
2. ✅ No race condition between readiness and output availability
3. ✅ `tailOutput({ sinceOffset })` returns output after specified offset
4. ✅ Minimal memory overhead (~8 bytes per terminal)
5. ✅ Existing tests pass
6. ✅ UI terminal view still works (no changes to SSE streaming)

---

## Future: File-Based Storage

For production scale, consider:

1. **Eliminate DB storage for output** - Bud's file is the source of truth
2. **Service requests output directly from Bud** via new `terminal_read` frame
3. **S3 streaming** - Bud uploads to S3, Service reads from S3

This would eliminate:
- `terminal_output` table (or use only for metadata)
- Race condition entirely (file is always current)
- WS bandwidth for output streaming

But this is a larger architectural change for a future phase.
