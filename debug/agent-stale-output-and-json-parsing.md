# Debug: Agent Stale Output & JSON Parsing Issues

**Date:** 2025-12-03
**Branch:** `adam/interactive-sessions`
**Status:** INVESTIGATING

## Symptoms

Two issues observed during agent testing:

### Issue A: OpenAI JSON Parsing Warning

The agent expects JSON responses from OpenAI, but OpenAI sometimes returns plain text:

```
[23:26:13.159] WARN: Agent response was not JSON; falling back to plain text
    rawText: "type: final\nstatus: failed\nmessage: TODO.md not found..."
    err: SyntaxError: Unexpected token 'y', "type: final"... is not valid JSON
```

### Issue B: Agent Sees Stale Terminal Output

The agent responded with "TODO.md not found" even though the terminal output showed the file exists. The agent is seeing stale/wrong terminal output.

## Log Timeline

```
23:26:08.098  terminal_output frame received (byte_offset: 1324661)
23:26:08.102  SSE terminal.output emitted
23:26:09.648  SSE terminal.ready emitted
23:26:09.731  Agent readiness assessment (ready=true, confidence=0.95)
23:26:09.740  SSE agent.tool_result emitted
23:26:09.740  Calling OpenAI Responses (265 entries)
23:26:13.157  OpenAI response received
23:26:13.159  WARN: Agent response was not JSON
```

## Analysis

### Issue A: JSON Parsing (LOWER PRIORITY)

**Root Cause:** The system prompt asks OpenAI to "Always produce STRICT JSON", but OpenAI's function calling models don't always produce JSON for their text output - only for tool calls. When the model decides to respond with text instead of a tool call, it uses plain text.

**Current Behavior:** The code at `agent-service.ts:562-566` already handles this with a fallback:
```typescript
} catch (err) {
  this.logger.warn(...);
  return {
    type: "final",
    status: "succeeded",  // <-- Fallback treats as success
    message: trimmed
  };
}
```

**Assessment:** This is working as designed. The warning is informational. The agent can use OpenAI's native function calling for tool calls, and plain text responses for final messages are acceptable.

**Possible Improvement:** Change system prompt to not require strict JSON for final responses, or use OpenAI's `response_format: { type: "json_object" }` parameter (but this may conflict with function calling).

### Issue B: Agent Sees Stale Output (CRITICAL)

This is the blocking issue. Let's trace the data flow:

#### Data Flow Diagram

```
[Bud] terminal output → [Service WS] handleTerminalOutput()
                                ↓
        ┌───────────────────────┴───────────────────────┐
        ↓                                               ↓
  lastOffsets.set(endOffset)              DB insert (async)
        ↓                                               ↓
        ↓                              (may complete later)
        ↓
[Bud] terminal_ready → [Service WS] handleTerminalReady()
        ↓
  readiness.set(assessment)
        ↓
[Agent] waitForReadiness() returns
        ↓
[Agent] offsetBeforeInput = getLastOffset()  ← Gets value set earlier
        ↓
[Agent] tailOutput(sinceOffset)
        ↓
  DB query: WHERE byte_offset >= sinceOffset
        ↓
  Returns... what?
```

#### Potential Race Conditions

1. **DB Insert Race:** The `handleTerminalOutput()` sets `lastOffsets` synchronously, but the DB insert is async. If the agent calls `tailOutput()` before the DB insert completes, it will query for data that doesn't exist yet.

2. **Offset Tracking on Service Restart:** If the service restarts, `lastOffsets` map is empty (in-memory). The agent calls `getLastOffset()` and gets 0. But the DB has data from before. So `tailOutput({ sinceOffset: 0 })` returns ALL historical data, not just new output.

3. **Output Before Input:** The `offsetBeforeInput` is captured BEFORE sending input, but the sequence is:
   - Agent captures `offsetBeforeInput`
   - Agent sends input
   - Bud executes command
   - Bud sends output
   - Service receives output, updates `lastOffsets` (but agent already has old value)
   - Agent waits for readiness
   - Agent queries with `sinceOffset = offsetBeforeInput`

   This should work correctly... unless the agent is reusing a stale offset from a previous turn.

#### Key Insight: Checking the Agent's Tool Result

Looking at the log:
```
23:26:09.740  SSE agent.tool_result emitted
```

This happens BEFORE the OpenAI call. So the agent received the tool result. The question is: what output did the tool result contain?

**Missing Log:** We don't have a log of what `tailOutput()` actually returned. This is critical for debugging.

## Recommended Investigation

### Step 1: Add Diagnostic Logging

Add logging to `tailOutput()` to see what's being queried and returned:

```typescript
async tailOutput(
  budId: string,
  maxBytes: number,
  options?: { sinceOffset?: number }
): Promise<{ data: Buffer; totalBytes: number }> {
  const currentOffset = this.lastOffsets.get(budId) ?? 0;
  this.logger.info({
    budId,
    maxBytes,
    sinceOffset: options?.sinceOffset,
    currentOffset,
    component: "terminal_manager"
  }, "tailOutput called");

  // ... rest of method

  this.logger.info({
    budId,
    rowCount: rows.length,
    totalBytes: combined.length,
    firstOffset: rows[0]?.byteOffset,
    lastOffset: rows[rows.length - 1]?.byteOffset,
    component: "terminal_manager"
  }, "tailOutput result");
```

### Step 2: Log Agent's Received Output

Add logging in `executeTerminalCall()`:

```typescript
const tail = await this.terminalManager.tailOutput(...);
const decoded = this.decodeTail(tail.data);
this.logger.info({
  budId: bud.budId,
  offsetBeforeInput,
  tailBytes: tail.totalBytes,
  decodedLength: decoded.length,
  decodedPreview: decoded.slice(0, 200),
  component: "agent"
}, "Agent received terminal output");
```

### Step 3: Verify DB Insert Timing

Check if the race between `handleTerminalOutput()` DB insert and agent's `tailOutput()` query is the issue:

```typescript
// In handleTerminalOutput, after DB insert:
this.logger.info({
  budId,
  seq: payload.seq,
  byteOffset: payload.byte_offset,
  storedBytes: toStore.length,
  component: "terminal_manager"
}, "terminal_output stored in DB");
```

### Step 4: Test the sinceOffset Query

Run a manual test to verify the query works:

```bash
cd service && npx tsx ../debug/query-terminal-output.ts
```

Then add a specific query to check what `WHERE byte_offset >= X` returns for a known offset value.

## Hypotheses

### Hypothesis 1: DB Insert Race (LIKELY)

The `handleTerminalOutput()` is called, sets `lastOffsets`, but the DB insert hasn't completed when the agent calls `tailOutput()`.

**Evidence:** The timestamps show only 100ms between output received and readiness signal. This is fast for an async DB insert.

**Fix:** Either:
- Add `await` to ensure DB insert completes before readiness is processed
- Or: Read from `lastOffsets` in-memory buffer instead of DB for recent output

### Hypothesis 2: Offset Starts at 0 After Restart (LIKELY)

If the service was restarted, `lastOffsets` is empty. When the agent captures `offsetBeforeInput = getLastOffset()`, it gets 0. Then it queries `WHERE byte_offset >= 0` which returns ALL historical output, not just the new command's output.

**Evidence:** Would need to check if service was restarted recently.

**Fix:** Initialize `lastOffsets` from DB on startup, or when first output is received for a terminal.

### Hypothesis 3: Agent Getting Wrong Output

The agent might be getting the correct recent output, but it contains output from a previous command that's confusing the model.

**Evidence:** The model said "TODO.md not found". If the output actually showed a `find` command that found nothing, this would be correct behavior (model isn't seeing stale data, it's interpreting current data).

**Fix:** N/A if this is correct behavior.

## Immediate Next Steps

1. Add the diagnostic logging from Step 1 & 2 above
2. Reproduce the issue and capture the logs
3. Check what output the agent actually received
4. Determine which hypothesis is correct
5. Implement fix based on findings

## Related Files

| File | Purpose |
|------|---------|
| `service/src/runtime/terminal-manager.ts:233-297` | `handleTerminalOutput()` - stores output |
| `service/src/runtime/terminal-manager.ts:362-442` | `tailOutput()` - queries output |
| `service/src/runtime/terminal-manager.ts:91-93` | `getLastOffset()` - in-memory tracking |
| `service/src/agent/agent-service.ts:835-929` | `executeTerminalCall()` - agent's terminal tool |
| `debug/terminal-output-ordering.md` | Previous investigation (seq collision bug) |
