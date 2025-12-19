# Design: Terminal Context Synchronization

## Problem Statement

When a user sends a new message to the Bud Agent, the agent's understanding of terminal state may be stale. The conversation history contains tool results with context like `{ mode: "repl", program: "claude" }`, but that context reflects the state at the time of the last tool call - not the current state.

**Scenarios where context becomes stale:**
1. User manually exits Claude Code (types "exit" in xterm.js)
2. User runs commands manually in the terminal
3. A running process completes or crashes
4. Session is recreated (idle timeout, bud reconnect)
5. Significant time has passed since last agent interaction

**Result:** Agent sends inappropriate commands (shell commands to Claude Code, or natural language to shell).

---

## Current Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ User types message in UI                                                 │
│         │                                                                │
│         ▼                                                                │
│ POST /api/threads/:id/messages { text: "..." }                           │
│         │                                                                │
│         ▼                                                                │
│ AgentService.startUserMessage()                                          │
│         │                                                                │
│         ▼                                                                │
│ buildConversation() - loads ALL messages from DB                         │
│    └── Old tool results contain STALE context                            │
│         │                                                                │
│         ▼                                                                │
│ Agent loop begins with STALE understanding of terminal state             │
└──────────────────────────────────────────────────────────────────────────┘
```

**The gap:** There's no mechanism to update the agent's context before the conversation is built.

---

## Proposed Solution: Pre-Flight Context Check

Before the user's message is processed, compare current terminal state to last known state. If changed, inject a human-readable summary message that updates the agent's understanding.

### High-Level Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│ User types message in UI                                                 │
│         │                                                                │
│         ▼                                                                │
│ POST /api/threads/:id/messages { text: "..." }                           │
│         │                                                                │
│         ▼                                                                │
│ ┌─────────────────────────────────────────────────────────────────────┐  │
│ │ PRE-FLIGHT CONTEXT CHECK (NEW)                                      │  │
│ │                                                                     │  │
│ │ 1. Capture current terminal state (capture-pane, 30 lines)          │  │
│ │ 2. Compare to last known state (hash, detected mode)                │  │
│ │ 3. If changed:                                                      │  │
│ │    a. Call Haiku to summarize what changed                          │  │
│ │    b. Insert context update message before user message             │  │
│ │ 4. Update "last known state" record                                 │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│         │                                                                │
│         ▼                                                                │
│ AgentService.startUserMessage()                                          │
│         │                                                                │
│         ▼                                                                │
│ buildConversation() - now includes context update if state changed       │
│         │                                                                │
│         ▼                                                                │
│ Agent has ACCURATE understanding of terminal state                       │
└──────────────────────────────────────────────────────────────────────────┘
```

### What Gets Stored (Per Session)

```typescript
interface TerminalStateSnapshot {
  sessionId: string;
  capturedAt: Date;

  // Content-based change detection
  screenHash: string;           // Hash of last N lines
  lastLine: string;             // The last non-empty line (often the prompt)

  // Derived state (set by heuristics OR LLM analysis)
  detectedMode: "shell" | "repl" | "tui" | "unknown";
  detectedProgram: string | null;  // "claude", "python", "vim", etc.

  // For determining when to re-analyze
  lastUserMessageAt: Date | null;
  analysisPending: boolean;
}
```

### Change Detection Logic

```typescript
async function detectStateChange(
  sessionId: string,
  currentCapture: string
): Promise<{ changed: boolean; details?: StateChangeDetails }> {
  const lastSnapshot = await getLastSnapshot(sessionId);

  if (!lastSnapshot) {
    // First capture for this session - no comparison needed
    return { changed: false };
  }

  const currentHash = hashScreenContent(currentCapture);

  // Quick check: if hash is identical, nothing changed
  if (currentHash === lastSnapshot.screenHash) {
    return { changed: false };
  }

  // Hash changed - analyze what changed
  const currentLastLine = extractLastLine(currentCapture);
  const lastLineChanged = currentLastLine !== lastSnapshot.lastLine;

  // Heuristic: detect obvious mode changes without LLM
  const currentModeHint = detectModeHeuristic(currentCapture, currentLastLine);
  const modeChanged = currentModeHint !== lastSnapshot.detectedMode;

  // Significant change if mode changed or last line (prompt) changed significantly
  const significantChange = modeChanged || lastLineChanged;

  if (!significantChange) {
    // Minor change (e.g., new output in same mode) - update hash but don't notify
    return { changed: false };
  }

  return {
    changed: true,
    details: {
      previousMode: lastSnapshot.detectedMode,
      previousProgram: lastSnapshot.detectedProgram,
      currentModeHint,
      currentCapture,
      previousLastLine: lastSnapshot.lastLine,
      currentLastLine
    }
  };
}
```

### Heuristic Mode Detection (No LLM Needed)

For common cases, we can detect mode without an LLM call:

```typescript
function detectModeHeuristic(capture: string, lastLine: string): "shell" | "repl" | "tui" | "unknown" {
  const trimmed = lastLine.trim();

  // Shell prompt indicators
  if (trimmed.endsWith('$') || trimmed.endsWith('#') || trimmed.endsWith('%')) {
    return "shell";
  }
  if (trimmed.match(/[❯λ➜>]\s*$/)) {
    return "shell";
  }

  // Python REPL
  if (trimmed.startsWith('>>>') || trimmed.startsWith('...')) {
    return "repl";
  }

  // Node REPL
  if (trimmed.startsWith('>') && !capture.includes('Claude')) {
    return "repl";
  }

  // Claude Code TUI (has distinctive UI elements)
  if (capture.includes('╭') && capture.includes('╰') && capture.includes('Claude')) {
    return "tui";
  }
  if (capture.includes('> ') && capture.includes('───')) {
    return "tui";
  }

  // Vim/editor indicators
  if (capture.includes('~') && capture.match(/^\s*\d+\s/m)) {
    return "tui";
  }

  return "unknown";
}
```

### LLM-Based Summary Generation

When state change is detected, generate a human-readable summary:

```typescript
async function generateContextUpdateMessage(
  details: StateChangeDetails
): Promise<string> {
  const prompt = `You are summarizing terminal state changes for an AI agent.

Previous state: ${details.previousMode} mode${details.previousProgram ? ` (${details.previousProgram})` : ''}
Previous prompt line: "${details.previousLastLine}"

Current terminal screen (last 20 lines):
\`\`\`
${details.currentCapture}
\`\`\`

Write a brief, informative message (1-2 sentences) describing what changed.
Examples:
- "Claude Code has exited. The terminal now shows a shell prompt."
- "The Python REPL is still active, showing the result of the last command."
- "A new shell session has started in /home/user/project."

Be concise. Focus on what the agent needs to know to send appropriate commands.`;

  const response = await haikuProvider.invokeSync(
    [{ role: "user", content: [{ type: "text", text: prompt }] }],
    [],
    { model: "claude-haiku-4-5", maxOutputTokens: 150 }
  );

  return response.content[0].text;
}
```

### Message Injection

Context updates are stored as `role: "system"` in our internal schema (semantically correct), then transformed per-provider:

```typescript
// Insert context update message BEFORE the user's actual message
await db.insert(messageTable).values({
  threadId,
  role: "system",  // Semantically correct - this IS a system message
  displayRole: "Terminal Status",  // UI shows this instead of "System"
  content: contextUpdateMessage,  // No prefix needed - role is clear
  metadata: {
    type: "context_sync",
    previousMode: details.previousMode,
    currentMode: newSnapshot.detectedMode,
    automated: true
  },
  createdAt: new Date(Date.now() - 1)  // Ensure it sorts before user message
});
```

### Provider-Layer Transformation

The provider layer transforms mid-conversation system messages per API requirements:

```typescript
// In buildConversation() or provider.transformMessages():

// OpenAI: System messages allowed anywhere - pass through as-is
// Anthropic: System messages only at start - convert to user message

// AnthropicProvider transformation:
function transformMessages(messages: CanonicalMessage[]): AnthropicMessage[] {
  return messages.map((msg, index) => {
    // First message can be system (handled separately as system param)
    // Mid-conversation system messages must become user messages
    if (msg.role === "system" && index > 0) {
      return {
        role: "user",
        content: `[System Note] ${msg.content[0].text}`
      };
    }
    // ... normal transformation
  });
}

// OpenAIProvider: No transformation needed for system messages
```

**Example stored messages (internal schema):**
```
role: "system", content: "Claude Code has exited. The terminal now shows a shell prompt."
role: "system", content: "The terminal session was recreated. A fresh shell is available."
role: "system", content: "Python REPL is no longer active. Shell prompt visible."
```

**Anthropic sees (after transformation):**
```
role: "user", content: "[System Note] Claude Code has exited. The terminal now shows a shell prompt."
```

**OpenAI sees (no transformation):**
```
role: "system", content: "Claude Code has exited. The terminal now shows a shell prompt."
```

---

## Integration Points

### 1. Message Creation Endpoint

```typescript
// routes/threads.ts - POST /api/threads/:id/messages

app.post('/api/threads/:threadId/messages', async (request, reply) => {
  const { threadId } = request.params;
  const { text, model, reasoning_effort } = request.body;

  // Get session for this thread
  const session = await terminalSessionManager.getSessionForThread(threadId);

  if (session) {
    // Skip context check if agent is already active (streaming)
    // In that case, agent will discover state via tool calls
    const isAgentActive = agentService.isThreadActive(threadId);

    if (!isAgentActive) {
      // NEW: Pre-flight context check
      const contextUpdate = await contextSyncService.checkAndSync(
        session.sessionId,
        threadId
      );

      if (contextUpdate) {
        // Context changed - message was auto-inserted
        logger.info({ threadId, update: contextUpdate }, "Context sync: state change detected");
      }
    } else {
      logger.debug({ threadId }, "Skipping context sync - agent stream active");
    }
  }

  // Continue with normal message creation and agent trigger...
});
```

### 2. New Service: ContextSyncService

```typescript
// service/src/terminal/context-sync-service.ts

export class ContextSyncService {
  constructor(
    private terminalSessionManager: TerminalSessionManager,
    private llmProvider: LLMProvider,  // Haiku
    private logger: FastifyBaseLogger
  ) {}

  async checkAndSync(sessionId: string, threadId: string): Promise<string | null> {
    // 1. Capture current state
    const capture = await this.terminalSessionManager.capturePane(sessionId, {
      startLine: -30,
      joinLines: true
    });

    // 2. Compare to last known state
    const change = await detectStateChange(sessionId, capture.output);

    if (!change.changed) {
      // Update hash but don't inject message
      await this.updateSnapshot(sessionId, capture.output, null);
      return null;
    }

    // 3. Generate human-readable summary
    const message = await generateContextUpdateMessage(change.details);

    // 4. Insert context update message
    await this.insertContextMessage(threadId, message, change.details);

    // 5. Update snapshot with new state
    await this.updateSnapshot(sessionId, capture.output, change.details);

    return message;
  }
}
```

### 3. Database Changes

Option A: New column on `terminal_session` table:
```sql
ALTER TABLE terminal_session ADD COLUMN state_snapshot JSONB;
```

Option B: New table for state tracking:
```sql
CREATE TABLE terminal_state_snapshot (
  session_id TEXT PRIMARY KEY REFERENCES terminal_session(session_id),
  screen_hash TEXT NOT NULL,
  last_line TEXT,
  detected_mode TEXT,
  detected_program TEXT,
  captured_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
```

### 4. Existing Tool Call Enhancement

Still include screen snapshot in `terminal.run` results (Option 6 from debug doc):

```typescript
// In executeTerminalCall(), for terminal.run:
return {
  output: decoded,
  outputBytes,
  readiness: finalReadiness,
  lastLine: ...,
  truncated,
  omittedLines: 0,
  context,
  screenSnapshot: screenCapture.output  // Visual ground truth
};
```

This helps DURING the agent loop. The pre-flight check helps BEFORE the loop starts.

---

## Relationship to Existing Components

### vs. `pendingCommands` tracking

**Current:** Tracks when we THINK a REPL started (input-based).
**Proposed:** Verifies what's ACTUALLY running (output-based).

**Integration:** Context sync should UPDATE `pendingCommands` when state changes:
```typescript
// In ContextSyncService.checkAndSync():
if (changed && details.currentModeHint === "shell") {
  // Clear stale REPL tracking so terminal.run uses correct output method
  this.terminalSessionManager.clearPendingCommand(sessionId);
}
```

This ensures `terminal.run` uses the correct output method (capturePane vs tailOutput) after context sync runs.

### vs. `terminal.capture` tool

**`terminal.capture`:** Agent-initiated tool to get screen content during a run.
**Pre-flight check:** Server-initiated check BEFORE agent run starts.

**No conflict:** They serve different purposes:
- Context sync: Fix stale conversation history
- `terminal.capture`: Agent needs current screen during task

**Potential optimization:** Cache the pre-flight capture briefly. If agent immediately calls `terminal.capture` or `terminal.run`, reuse the cached capture instead of re-capturing.

### vs. `terminal.run` REPL mode detection

**Current `terminal.run` logic:**
```typescript
const context = getContext();  // Based on pendingCommands (CAN BE STALE!)
if (context.mode === "repl") {
  // Uses capturePane() - rendered screen
} else {
  // Uses tailOutput() - raw byte stream
}
```

**Integration:** After context sync clears `pendingCommands`, `terminal.run` will correctly use `tailOutput()` for shell mode.

**Future simplification:** With reliable context sync, we could potentially:
1. Always use `capturePane()` for output (simpler, more consistent)
2. Include screen snapshot in all tool results (Option 6 from debug doc)
3. Remove `pendingCommands` tracking entirely

### vs. `handleTerminalReady()` shell detection

**Current:** Clears `pendingCommands` when shell prompt detected in readiness.
**Proposed:** Complements this by checking at message-send time, catching cases where readiness wasn't triggered.

### Shared Heuristics

Mode detection is currently duplicated:
- Bud daemon: `detect_prompt()` in `main.rs`
- Service: `pendingCommands` tracking + readiness assessment
- Context sync: `detectModeHeuristic()` (new)

**Future work:** Unify heuristics into a shared module, possibly with the Bud daemon's detection informing the service via `terminal_ready` assessments.

---

## Future Consideration: Manual Input Tracking

The user mentioned intercepting manual xterm.js inputs. This could provide even better coverage:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ User types in xterm.js (manual input)                                    │
│         │                                                                │
│         ▼                                                                │
│ Input intercepted, logged to terminal_session_input_log                  │
│ with source: "user_manual"                                               │
│         │                                                                │
│         ▼                                                                │
│ Later: Pre-flight check sees manual inputs since last agent turn         │
│         │                                                                │
│         ▼                                                                │
│ Context update includes: "User manually ran: exit, ls, npm test"         │
└──────────────────────────────────────────────────────────────────────────┘
```

**Complexity:** Requires xterm.js integration, handling of partial inputs, etc.
**Recommendation:** Defer this. The capture-based approach handles most cases. If users are steered away from manual terminal interaction, this becomes less important.

---

## Cost Analysis

### Per User Message

| Component | When | Cost |
|-----------|------|------|
| `capture-pane` | Always | 0 (local tmux command) |
| Hash comparison | Always | 0 (CPU only) |
| Haiku summary | Only if state changed | ~$0.0001-0.0003 |

**Expected frequency of state changes:** Low (most messages don't have intervening terminal changes).

**Estimated cost:** <$0.001 per 100 messages.

### Latency

| Component | Time |
|-----------|------|
| `capture-pane` | 10-50ms |
| Hash + heuristic | <5ms |
| Haiku call (if needed) | 200-400ms |
| DB insert (if needed) | 10-20ms |

**Best case (no change):** +15-55ms
**Worst case (change detected):** +250-500ms

**Acceptable:** This happens once at message send, not during agent loop.

---

## Design Decisions (Resolved)

### 1. Where should the check happen?

**Decision:** Server-side (in message endpoint)
- Simpler client, server has all context
- Skip check if agent stream is already active

### 2. How to handle capture-pane failures?

**Decision:** Log warning, skip context check, proceed with message
- Agent will discover state via tool calls
- Don't block user message on capture failure

### 3. What role should the context update message have?

**Decision:** `role: "system"` in internal schema, transformed per-provider
- Store as `system` (semantically correct - these ARE system-level updates)
- Provider layer transforms for API compatibility:
  - **OpenAI:** Keep as `system` (supported anywhere in conversation)
  - **Anthropic:** Convert to `user` with `[System Note]` prefix (system only allowed at start)
- Clean separation: internal schema is correct, providers handle quirks

### 4. Should we debounce/throttle checks?

**Decision:** Skip if agent stream is active, otherwise always check
- Hash comparison is fast (<5ms)
- If agent is streaming, it will discover state via tool calls
- No need for time-based throttling

### 5. How much context to capture?

**Decision:** 30 lines
- Good balance for prompt detection
- Sufficient for most TUI layouts
- Not excessive for Haiku analysis

### 6. What if Haiku generates a bad summary?

**Decision:** Accept as-is for v1, monitor and iterate
- Message is informational, not blocking
- Agent has tool calls to verify actual state
- Can add validation later if needed

---

## Implementation Plan

### Phase 1: Core Infrastructure

1. Create `ContextSyncService` class
2. Add `terminal_state_snapshot` storage (column or table)
3. Implement `detectStateChange()` with hash comparison
4. Implement `detectModeHeuristic()` for common cases

### Phase 2: LLM Integration

1. Add Haiku provider configuration
2. Implement `generateContextUpdateMessage()`
3. Add message injection logic

### Phase 3: Integration

1. Hook into message creation endpoint
2. Add logging and metrics
3. Test with various terminal states

### Phase 4: Enhancement (Optional)

1. Add screen snapshot to `terminal.run` results (Option 6)
2. Consider manual input tracking (future)
3. Add UI indicator for context sync status

---

## Success Criteria

1. Agent correctly identifies shell vs Claude Code after manual exit
2. Agent correctly handles session recreation
3. No noticeable latency impact on message send (<500ms worst case)
4. Context update messages are clear and helpful
5. No false positives (unnecessary context updates)

---

*Created: 2025-12-16*
