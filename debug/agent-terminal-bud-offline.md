# Debug: Agent Terminal "bud_offline" Error

## Environment
- Branch: `adam/interactive-sessions`
- Error: `bud_offline` when agent tries to send terminal commands
- Symptom: Direct terminal input from UI works; agent path fails

## Error Log
```
[16:06:54.280] INFO: Dispatching tool call
    component: "agent"
    tool: "terminal.run"
    command: "ls -la\n"
[16:06:54.281] INFO: No active session for bud; dropping frame
    component: "ws_gateway"
[16:06:54.281] WARN: Failed to dispatch terminal_ensure (bud offline)
    component: "terminal_manager"
[16:06:54.282] INFO: No active session for bud; dropping frame
    component: "ws_gateway"
[16:06:54.282] WARN: Failed to send terminal_input (bud offline)
    component: "terminal_manager"
[16:06:54.282] ERROR: Agent flow failed
    err.message: "bud_offline"
    err.stack: Error at AgentService.executeTerminalCall (agent-service.ts:896)
```

## Root Cause Analysis

### Two Different Paths to Terminal

**Path A: UI Direct Input (WORKS)**
```
User selects budId in UI (state)
    → App.tsx uses budId from useState
    → POST /api/terminals/{budId}/input
    → terminalManager.sendInput(budId)
    → sendFrameToBud(budId)
    → sessions.get(budId) ✓ FOUND
    → Frame sent to Bud
```

**Path B: Agent Terminal Call (FAILS)**
```
Agent receives threadId
    → fetchBudForThread(threadId) queries DB
    → Returns thread.budId from database
    → terminalManager.ensureTerminal(budId)
    → sendFrameToBud(budId)
    → sessions.get(budId) ✗ NOT FOUND
    → "No active session for bud; dropping frame"
```

### The Mismatch

The issue is that **the budId stored in the thread's database record** may not match **the budId that's currently connected via WebSocket**.

Key code locations:

1. **UI gets budId from React state** (`web/src/App.tsx:59`):
   ```typescript
   const [budId, setBudId] = useState<string | null>(null)
   ```
   This is set when user selects a Bud in the UI.

2. **Agent gets budId from database** (`service/src/agent/agent-service.ts:1037-1046`):
   ```typescript
   private async fetchBudForThread(threadId: string): Promise<{ budId: string }> {
     const thread = await db.query.threadTable.findFirst({
       where: eq(threadTable.threadId, threadId),
       columns: { budId: threadTable.budId }
     });
     if (!thread) {
       throw new Error("thread not found");
     }
     return { budId: thread.budId };
   }
   ```

3. **WebSocket sessions map** (`service/src/ws/gateway.ts:180`):
   ```typescript
   const sessions = new Map<string, SessionTracker>();
   ```
   This map is populated when a Bud connects via WebSocket handshake.

4. **sendFrameToBud checks sessions map** (`service/src/ws/gateway.ts:183-187`):
   ```typescript
   export function sendFrameToBud(budId: string, payload: Record<string, unknown>): boolean {
     const session = sessions.get(budId);
     if (!session) {
       logDebug({ budId }, "No active session for bud; dropping frame ");
       return false;
     }
     // ...
   }
   ```

## Hypotheses

### H1: Thread references a different budId than the connected Bud (MOST LIKELY)

The thread was created with one `budId`, but the Bud that's currently connected has a different `budId`.

**Evidence:**
- The log shows "No active session for bud" which means `sessions.get(budId)` returned `undefined`
- The terminal works via UI, which uses the currently selected (connected) budId
- The agent uses the thread's stored budId, which may be stale/different

**Test:**
1. Log the budId being looked up by the agent
2. Log all keys in the `sessions` map
3. Compare to see if there's a mismatch

### H2: Session map uses different key format

The `sessions` map might be keyed differently than expected (e.g., with a prefix or different case).

**Evidence:**
- Registration happens at `gateway.ts:694`: `sessions.set(budId, tracker)`
- Lookup happens at `gateway.ts:184`: `sessions.get(budId)`
- Should be same format, but worth verifying

### H3: Race condition - Bud disconnected between operations

The Bud might have disconnected after `ensureTerminal` but before `sendInput`.

**Evidence:**
- Both `ensureTerminal` AND `sendInput` fail with "bud offline"
- This suggests the session wasn't there for either call
- Less likely to be a race condition, more likely a fundamental mismatch

### H4: Thread was created with a non-existent/old budId

When the thread was created, it may have been associated with a budId that:
- No longer exists
- Never connected in this service session
- Was from a previous run of the service

**Evidence:**
- Thread ID: `82c0c645-cc28-4b74-a6c5-835650cc10e1`
- Need to check what budId this thread references in the database

## Code Flow Details

### 1. Agent receives tool call from OpenAI
`agent-service.ts:252` - `runAgentFlow()` receives response with `terminal_run` function call

### 2. Agent dispatches terminal call
`agent-service.ts:835-919` - `executeTerminalCall()`:
```typescript
private async executeTerminalCall(threadId, directive) {
  const bud = await this.fetchBudForThread(threadId);  // Line 839 - DB lookup
  await this.terminalManager.ensureTerminal(bud.budId); // Line 840 - First WS call
  // ...
  const sent = await this.terminalManager.sendInput(   // Line 890 - Second WS call
    bud.budId,
    Buffer.from(input, "utf-8"),
    { source: "agent" }
  );
  if (!sent.ok) {
    throw new Error(sent.error ?? "terminal_input_failed");  // Line 896 - ERROR HERE
  }
}
```

### 3. Terminal Manager calls gateway
`terminal-manager.ts:55-69` - `ensureTerminal()`:
```typescript
async ensureTerminal(budId: string) {
  const sent = sendFrameToBud(budId, payload);  // Line 66
  if (!sent) {
    this.logger.warn({ budId }, "Failed to dispatch terminal_ensure (bud offline)");
    return { ok: false, error: "bud_offline" };  // Line 69
  }
}
```

`terminal-manager.ts:97-114` - `sendInput()`:
```typescript
async sendInput(budId: string, data: Buffer) {
  const sent = sendFrameToBud(budId, payload);  // Line 111
  if (!sent) {
    this.logger.warn({ budId }, "Failed to send terminal_input (bud offline)");
    return { ok: false, error: "bud_offline" };  // Line 114
  }
}
```

### 4. Gateway checks sessions map
`gateway.ts:183-187` - `sendFrameToBud()`:
```typescript
export function sendFrameToBud(budId: string, payload) {
  const session = sessions.get(budId);  // Line 184
  if (!session) {
    logDebug({ budId }, "No active session for bud; dropping frame ");  // Line 186
    return false;  // Line 187
  }
}
```

## Potential Fixes

### Fix 1: Add diagnostic logging
Add logging to compare the budId from thread lookup vs active sessions:

```typescript
// In executeTerminalCall
const bud = await this.fetchBudForThread(threadId);
this.logger.info({
  threadId,
  budIdFromThread: bud.budId,
  activeSessions: Array.from(sessions.keys())  // Need to export this
}, "Terminal call budId lookup");
```

### Fix 2: Validate budId is connected before using
Before calling `ensureTerminal`, check if the budId has an active session:

```typescript
// New function in gateway.ts
export function isBudConnected(budId: string): boolean {
  return sessions.has(budId);
}

// In executeTerminalCall
const bud = await this.fetchBudForThread(threadId);
if (!isBudConnected(bud.budId)) {
  throw new Error(`bud_not_connected: ${bud.budId}`);
}
```

### Fix 3: Use the UI's budId selection pattern for agents
Instead of looking up budId from the thread, the agent flow could:
1. Accept budId as a parameter to the agent run
2. Or validate that the thread's budId matches an active connection

### Fix 4: Auto-update thread.budId when Bud connects
When a Bud connects via WebSocket, update any threads that reference an old/disconnected budId.

## Investigation Steps

1. **Add logging to show budId mismatch:**
   - Log the budId from `fetchBudForThread()`
   - Export and log `sessions.keys()` from gateway
   - Compare to see the actual mismatch

2. **Check database for thread's budId:**
   ```sql
   SELECT thread_id, bud_id FROM thread
   WHERE thread_id = '82c0c645-cc28-4b74-a6c5-835650cc10e1';
   ```

3. **Check what budId is currently connected:**
   - Look at service logs for "Bud enrolled" message with budId
   - Or add an endpoint to list active sessions

4. **Verify thread creation flow:**
   - How does the UI create threads?
   - Does it use the currently selected budId?
   - Is that budId persisted correctly?

## Related Files

| File | Lines | Description |
|------|-------|-------------|
| `service/src/agent/agent-service.ts` | 835-919 | `executeTerminalCall()` - where error originates |
| `service/src/agent/agent-service.ts` | 1037-1046 | `fetchBudForThread()` - DB lookup |
| `service/src/runtime/terminal-manager.ts` | 55-95 | `ensureTerminal()` |
| `service/src/runtime/terminal-manager.ts` | 97-125 | `sendInput()` |
| `service/src/ws/gateway.ts` | 180 | `sessions` map definition |
| `service/src/ws/gateway.ts` | 183-202 | `sendFrameToBud()` |
| `service/src/ws/gateway.ts` | 687-696 | `registerSession()` |
| `web/src/App.tsx` | 59 | UI budId state |
| `web/src/App.tsx` | 335, 610, 716 | UI terminal API calls with budId |

## Immediate Next Steps

1. Add debug logging to confirm budId mismatch hypothesis
2. Query database to see what budId the thread references
3. Compare with the budId shown in "Bud enrolled" log message
4. Implement fix based on findings
