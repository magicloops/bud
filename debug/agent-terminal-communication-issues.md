# Debug: Agent-Terminal Communication Issues

## Environment
- Branch: `adam/interactive-sessions`
- Date: 2025-12-02

## Symptoms Observed

1. **Agent messages not streaming to web client** - Messages only visible after page refresh
2. **Terminal shows old output mixed with new** - Old session data appears mixed with recent commands
3. **Agent doesn't see actual terminal output** - Responds with stale/guessed data, executes duplicate commands like `pwd` twice

## Example Log Output
```
bash-3.2$ pwd
/Users/adam/code/bud
bash-3.2$ pwd
/Users/adam/code/bud
bash-3.2$
The default interactive shell is now zsh.
To update your account to use zsh, please run `chsh -s /bin/zsh`.
For more details, please visit https://support.apple.com/kb/HT208050.
```

The agent's response showed output from a previous `ls` in a different directory, suggesting it didn't see the actual terminal output.

---

## ISSUE 1: Agent Messages Not Streaming to Web Client

### Root Cause: No SSE Connection for Agent Messages

**Problem:** The web client never establishes an SSE connection to receive agent messages in real-time.

**Current Flow (BROKEN):**
```
Web Client                  Server                          Agent
    |                          |                              |
    |----POST /messages-------->|                              |
    |                          |---runAgentFlow(sessionId)---->|
    |  status='streaming'       |                              |
    |  (NO SSE connected!)      |                          [Processing...]
    |                          |<--emit(sessionId, 'agent.message')
    |  (nothing received)       |                              |
    |                          |                              |
    |----GET /messages (refresh)|                              |
    |<---Returns messages-------|                              |
```

**Key Code Locations:**

1. **Web client never opens SSE for agent messages:**
   - `web/src/App.tsx:772-789`
   ```typescript
   const messageResp = await fetch(`/api/threads/${currentThreadId}/messages`, {
     method: 'POST',
     // ... triggers agent
   })
   await fetchMessages(currentThreadId)  // Only polls via GET
   setStatus('streaming')  // Misleading - not actually streaming!
   ```

2. **Agent emits to sessionId, not threadId:**
   - `service/src/agent/agent-service.ts:226-227`
   ```typescript
   this.events.emit(sessionId, {  // Emitting to SESSION ID
     event: "agent.tool_call",
     data: { ... }
   });
   ```

3. **Missing SSE endpoint for threads:**
   - `service/src/server.ts:87-97` has:
     - `/api/runs/:runId/stream`
     - `/api/sessions/:sessionId/stream`
     - `/api/terminals/:budId/stream`
     - **MISSING: `/api/threads/:threadId/stream`**

### Impact
- User doesn't see agent responses in real-time
- Must refresh page to see agent's messages
- No feedback while agent is processing

---

## ISSUE 2: Terminal Output Shows Old Data Mixed With New

### Root Cause: `tailOutput()` Has No Cursor/Sequence Tracking

**Problem:** Every call to `tailOutput()` returns the last N rows from the database with no way to track "what I've already seen".

**Key Code:**
- `service/src/runtime/terminal-manager.ts:296-326`
```typescript
async tailOutput(budId: string, maxBytes: number) {
  const rows = await db
    .select({
      seq: terminalOutputTable.seq,
      data: terminalOutputTable.data
    })
    .from(terminalOutputTable)
    .where(eq(terminalOutputTable.budId, budId))
    .orderBy(desc(terminalOutputTable.seq))  // Newest first
    .limit(200);  // Always returns last 200 rows

  // Problem: No "sinceSeq" parameter!
  // Every call returns the same rows

  const buffers: Buffer[] = [];
  for (const row of rows) {
    buffers.push(Buffer.from(row.data, "base64"));
  }
  buffers.reverse();  // Reverse to chronological order
  const combined = Buffer.concat(buffers);

  // BUG: totalBytes only counts selected rows, not actual total
  const totalBytes = rows.reduce((acc, row) =>
    acc + Buffer.from(row.data, "base64").length, 0
  );

  return { data: combined, totalBytes };
}
```

**Data Flow Issue:**
```
Database has: [seq=1, seq=2, seq=3, seq=4, seq=5, ...]

Call 1: tailOutput() → returns [seq=5,4,3,2,1] (reversed to 1,2,3,4,5)
Call 2: tailOutput() → returns [seq=5,4,3,2,1] again (SAME DATA)

No way to ask for "rows after seq=5"
```

**Additional Problem - Out of Order Arrivals:**
```
Bud sends: seq=100, data=chunk1
Bud sends: seq=101, data=chunk2
Bud sends: seq=99, data=chunk0  (arrives late due to network)

All stored in DB. But when tailOutput() called:
- Returns rows ordered by DESC seq
- Reversing gives: chunk0, chunk1, chunk2 (correct order if all arrived)
- BUT if seq=99 arrives AFTER agent already read output, agent missed it
```

### Impact
- Old terminal output appears mixed with new
- Duplicate output shown to user
- History doesn't reflect actual terminal state

---

## ISSUE 3: Agent Sees Stale/Incomplete Terminal Output

### Root Cause: Race Condition Between Readiness and Output Storage

**Problem:** Agent reads output immediately after readiness signal, but output may not be stored in DB yet.

**Sequence of Events:**
```
T0.0: Agent sends "ls -la" via sendInput()
T0.1: Frame sent to Bud via WebSocket
T0.5: Bud receives command, executes
T1.0: Bud starts sending terminal_output frames
T1.5: Bud sends terminal_ready frame (command finished)
T1.6: Gateway receives terminal_ready, updates in-memory cache
T1.7: Agent's waitForReadiness() returns (readiness detected!)
T1.8: Agent calls tailOutput() to get output
T1.9: **PROBLEM**: Output frames still being stored in DB (async insert)
T2.0: tailOutput() returns STALE data (output from T1.0 not yet in DB)
```

**Key Code - Agent Flow:**
- `service/src/agent/agent-service.ts:888-902`
```typescript
// terminal.run
const sent = await this.terminalManager.sendInput(
  bud.budId,
  Buffer.from(input, "utf-8"),
  { source: "agent" }
);

// Wait for terminal to be ready
const readiness = await this.terminalManager.waitForReadiness(
  bud.budId,
  directive.timeoutMs ?? 5000
);

// Get output - BUT OUTPUT MAY NOT BE IN DB YET!
const tail = await this.terminalManager.tailOutput(
  bud.budId,
  config.terminalOutputBackfillBytes
);
```

**Key Code - Readiness Detection (Fast Path):**
- `service/src/runtime/terminal-manager.ts:242-249`
```typescript
async handleTerminalReady(budId: string, assessment: unknown) {
  // Immediately updates in-memory cache
  this.readiness.set(budId, { assessment, updatedAt: Date.now() });
  // Emits event - agent's waitForReadiness() wakes up
  this.events.emit(budId, {
    event: "terminal.ready",
    data: { assessment }
  });
  // But handleTerminalOutput() may still be inserting to DB!
}
```

**Key Code - Output Storage (Slow Path):**
- `service/src/runtime/terminal-manager.ts:185-240`
```typescript
async handleTerminalOutput(budId: string, frame: TerminalOutputFrame) {
  // ... validation ...

  // Async DB insert - may take time!
  await db.insert(terminalOutputTable).values({
    budId,
    seq: frame.seq,
    data: frame.data,
    byteOffset: frame.offset ?? 0
  });

  // SSE emit happens AFTER DB insert
  this.events.emit(budId, {
    event: "terminal.output",
    data: { data: frame.data, seq: frame.seq }
  });
}
```

### Impact
- Agent reads incomplete/stale output from previous commands
- Agent makes decisions based on wrong terminal state
- Agent may repeat commands (like `pwd` twice) because it didn't see the output
- Agent's responses don't match actual terminal state

---

## Architecture Diagrams

### Current (Broken) Agent Message Flow
```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│  Web Client  │         │    Server    │         │    Agent     │
└──────┬───────┘         └──────┬───────┘         └──────┬───────┘
       │                        │                        │
       │ POST /messages         │                        │
       │───────────────────────>│                        │
       │                        │ runAgentFlow()         │
       │                        │───────────────────────>│
       │                        │                        │
       │ status='streaming'     │                        │
       │ (no SSE!)              │                    [process]
       │                        │                        │
       │                        │<─ emit(sessionId)──────│
       │                        │   (no listener!)       │
       │                        │                        │
       │ (waits, refreshes)     │<─ insert to DB ────────│
       │                        │                        │
       │ GET /messages          │                        │
       │───────────────────────>│                        │
       │<──────────────────────│                        │
       │   (finally sees msgs)  │                        │
```

### Current (Broken) Terminal Output Flow
```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│     Bud      │         │   Gateway    │         │    Agent     │
└──────┬───────┘         └──────┬───────┘         └──────┬───────┘
       │                        │                        │
       │                        │<── sendInput("ls") ────│
       │<── terminal_input ─────│                        │
       │                        │                        │
       │ (executes command)     │                        │
       │                        │                        │
       │── terminal_output(1) ──>│                        │
       │── terminal_output(2) ──>│ async DB insert...    │
       │── terminal_ready ──────>│                        │
       │                        │ readiness.set()        │
       │                        │────────────────────────>│ waitForReadiness()
       │                        │                        │ returns immediately!
       │                        │                        │
       │                        │<── tailOutput() ───────│
       │                        │                        │
       │ (DB insert completes)  │                        │
       │                        │── stale data ─────────>│
       │                        │   (missing recent!)    │
       │                        │                        │
       │                        │                    [agent responds
       │                        │                     with wrong info]
```

---

## Summary Table

| Issue | Root Cause | Key Files | Impact |
|-------|-----------|-----------|--------|
| 1. Messages not streaming | No SSE for threads; agent emits to sessionId | `server.ts`, `agent-service.ts:226`, `App.tsx:772` | Must refresh to see agent responses |
| 2. Old output mixed | No cursor tracking in tailOutput() | `terminal-manager.ts:296-326` | Duplicate/stale terminal content |
| 3. Agent sees stale data | Race: readiness fires before output stored | `terminal-manager.ts:242,185`, `agent-service.ts:898` | Agent makes wrong decisions |

---

## Recommended Fixes

### Fix 1: Add Thread SSE Streaming
```typescript
// server.ts - Add new SSE endpoint
server.get("/api/threads/:threadId/stream", (request, reply) => {
  const { threadId } = request.params;
  // Stream agent events to client
});

// agent-service.ts - Emit to threadId instead of sessionId
this.events.emit(threadId, {
  event: "agent.message",
  data: { ... }
});

// App.tsx - Connect SSE before posting message
const eventSource = new EventSource(`/api/threads/${threadId}/stream`);
eventSource.onmessage = (e) => { /* update UI */ };
await fetch(`/api/threads/${threadId}/messages`, { method: 'POST' });
```

### Fix 2: Add Cursor/Sequence Tracking to tailOutput()
```typescript
// terminal-manager.ts
async tailOutput(budId: string, maxBytes: number, sinceSeq?: number) {
  let query = db
    .select({ seq, data })
    .from(terminalOutputTable)
    .where(eq(terminalOutputTable.budId, budId));

  if (sinceSeq !== undefined) {
    query = query.where(gt(terminalOutputTable.seq, sinceSeq));
  }

  return query.orderBy(asc(terminalOutputTable.seq)).limit(200);
}
```

### Fix 3: Wait for Output After Readiness
```typescript
// agent-service.ts - Add delay or use output sequence tracking
const readiness = await this.terminalManager.waitForReadiness(budId, timeout);

// Option A: Small delay to let output flush to DB
await new Promise(resolve => setTimeout(resolve, 100));

// Option B: Wait for specific output sequence
const expectedSeq = await this.terminalManager.getLastSeq(budId);
await this.terminalManager.waitForOutputSeq(budId, expectedSeq, timeout);

const tail = await this.terminalManager.tailOutput(budId, maxBytes);
```

### Fix 4: Use In-Memory Buffer Instead of DB for Recent Output
```typescript
// terminal-manager.ts - Keep recent output in memory
private outputBuffers = new Map<string, { chunks: Buffer[], lastSeq: number }>();

handleTerminalOutput(budId, frame) {
  // Store in memory immediately
  const buffer = this.outputBuffers.get(budId) ?? { chunks: [], lastSeq: 0 };
  buffer.chunks.push(Buffer.from(frame.data, 'base64'));
  buffer.lastSeq = frame.seq;
  this.outputBuffers.set(budId, buffer);

  // Also store to DB (async, for persistence)
  db.insert(terminalOutputTable).values({ ... });
}

tailOutput(budId, maxBytes) {
  // Read from memory first (always fresh)
  const buffer = this.outputBuffers.get(budId);
  // Fall back to DB for older data
}
```

---

## Investigation Commands

```bash
# Check terminal output rows for a bud
psql -c "SELECT seq, byte_offset, length(data) FROM terminal_output WHERE bud_id = 'xxx' ORDER BY seq DESC LIMIT 20;"

# Check agent session events
grep "agent.message\|agent.tool_call" service.log

# Watch gateway frame handling
grep "terminal_output\|terminal_ready" service.log | tail -100
```

---

## Related Files

| File | Lines | Description |
|------|-------|-------------|
| `service/src/agent/agent-service.ts` | 226-271, 835-919, 898-902 | Agent message emission, terminal call execution |
| `service/src/runtime/terminal-manager.ts` | 185-240, 242-249, 255-266, 296-326 | Output handling, readiness, tailOutput |
| `service/src/ws/gateway.ts` | 452-480 | Terminal frame handling |
| `service/src/server.ts` | 87-97 | SSE endpoints (missing thread stream) |
| `web/src/App.tsx` | 772-789 | Message posting (no SSE) |
| `service/src/db/schema.ts` | 280-295 | terminal_output table schema |
