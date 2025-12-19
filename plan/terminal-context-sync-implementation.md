# Plan: Terminal Context Sync Implementation

**Status:** ✅ **IMPLEMENTED** (2025-12-16)

## Context

- **Design doc:** [`design/terminal-context-sync.md`](../design/terminal-context-sync.md)
- **Debug analysis:** [`debug/tui-context-tracking-analysis.md`](../debug/tui-context-tracking-analysis.md)
- **Related spec:** [`service/src/terminal/terminal.spec.md`](../service/src/terminal/terminal.spec.md)

## Objective

Implement pre-flight terminal context synchronization so the agent has accurate terminal state when processing new user messages.

**Success criteria:**
1. Agent correctly identifies shell vs TUI after user manually exits Claude Code
2. Agent handles session recreation correctly
3. No noticeable latency impact (<500ms worst case)
4. Context updates are human-readable, not structured JSON

---

## Spec Files to Update

- [x] `service/src/terminal/terminal.spec.md` - Add ContextSyncService docs
- [x] `service/src/agent/agent.spec.md` - Document isThreadActive() method
- [x] `service/src/routes/routes.spec.md` - Document context sync in message endpoint
- [x] `service/src/llm/providers/providers.spec.md` - Document mid-conversation system message handling

---

## Phase 1: State Storage

**Goal:** Store terminal state snapshots for comparison.

### 1.1 Database Schema

Add column to `terminal_session` table:

```typescript
// service/src/db/schema.ts

export const terminalSessionTable = pgTable("terminal_session", {
  // ... existing columns ...

  // NEW: State snapshot for context sync
  stateSnapshot: jsonb("state_snapshot").$type<{
    screenHash: string;
    lastLine: string;
    detectedMode: "shell" | "repl" | "tui" | "unknown";
    detectedProgram: string | null;
    capturedAt: string;  // ISO timestamp
  } | null>(),
});
```

**Tasks:**
- [x] Add `stateSnapshot` column to schema
- [x] Run `drizzle-kit push` to apply changes
- [x] Update `db.spec.md` with new column

### 1.2 State Snapshot Types

```typescript
// service/src/terminal/types.ts

export interface TerminalStateSnapshot {
  screenHash: string;
  lastLine: string;
  detectedMode: "shell" | "repl" | "tui" | "unknown";
  detectedProgram: string | null;
  capturedAt: Date;
}

export interface StateChangeDetails {
  previousMode: string;
  previousProgram: string | null;
  previousLastLine: string;
  currentCapture: string;
  currentLastLine: string;
  currentModeHint: string;
}
```

**Tasks:**
- [x] Add types to `terminal/types.ts`

---

## Phase 2: Context Sync Service

**Goal:** Create service to detect state changes and generate summaries.

### 2.1 Service Skeleton

```typescript
// service/src/terminal/context-sync-service.ts

import { createHash } from "crypto";
import type { FastifyBaseLogger } from "fastify";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import type { TerminalStateSnapshot, StateChangeDetails } from "./types.js";

export class ContextSyncService {
  constructor(
    private terminalSessionManager: TerminalSessionManager,
    private logger: FastifyBaseLogger
  ) {}

  /**
   * Check if terminal state changed since last snapshot.
   * If changed, generate summary and return it for message injection.
   */
  async checkAndSync(
    sessionId: string,
    threadId: string
  ): Promise<string | null> {
    // Implementation in 2.2-2.4
  }
}
```

**Tasks:**
- [x] Create `context-sync-service.ts` file
- [x] Add to service initialization in `server.ts`
- [x] Export from `terminal/index.ts` if exists

### 2.2 State Capture & Hashing

```typescript
private async captureCurrentState(sessionId: string): Promise<{
  capture: string;
  hash: string;
  lastLine: string;
}> {
  const result = await this.terminalSessionManager.capturePane(sessionId, {
    startLine: -30,
    joinLines: true
  }, 3000);

  const capture = result.output;
  const hash = createHash("sha256").update(capture).digest("hex").slice(0, 16);
  const lastLine = this.extractLastLine(capture);

  return { capture, hash, lastLine };
}

private extractLastLine(capture: string): string {
  const lines = capture.split("\n").filter(l => l.trim());
  return lines[lines.length - 1] || "";
}
```

**Tasks:**
- [x] Implement `captureCurrentState()`
- [x] Implement `extractLastLine()`

### 2.3 Heuristic Mode Detection

```typescript
private detectModeHeuristic(
  capture: string,
  lastLine: string
): "shell" | "repl" | "tui" | "unknown" {
  const trimmed = lastLine.trim();

  // Shell prompt indicators
  if (trimmed.endsWith('$') || trimmed.endsWith('#') || trimmed.endsWith('%')) {
    return "shell";
  }
  if (/[❯λ➜>]\s*$/.test(trimmed)) {
    return "shell";
  }

  // Python REPL
  if (trimmed.startsWith('>>>') || trimmed.startsWith('...')) {
    return "repl";
  }

  // IPython
  if (/^In \[\d+\]:/.test(trimmed)) {
    return "repl";
  }

  // Node REPL (but not Claude Code)
  if (trimmed === '>' && !capture.includes('Claude')) {
    return "repl";
  }

  // Claude Code TUI
  if (capture.includes('╭') && capture.includes('╰')) {
    return "tui";
  }
  if (capture.includes('Claude') && capture.includes('───')) {
    return "tui";
  }

  // Vim/editor
  if (capture.includes('~') && /^\s*\d+\s/.test(capture)) {
    return "tui";
  }

  return "unknown";
}
```

**Tasks:**
- [x] Implement `detectModeHeuristic()`
- [ ] Add tests for common prompt patterns (TODO: future enhancement)

### 2.4 Change Detection

```typescript
private async detectStateChange(
  sessionId: string,
  currentCapture: string,
  currentHash: string,
  currentLastLine: string
): Promise<{ changed: boolean; details?: StateChangeDetails }> {
  const session = await this.terminalSessionManager.getSession(sessionId);
  const lastSnapshot = session?.stateSnapshot as TerminalStateSnapshot | null;

  if (!lastSnapshot) {
    // First check - no comparison possible
    return { changed: false };
  }

  // Quick check: identical hash means no change
  if (currentHash === lastSnapshot.screenHash) {
    return { changed: false };
  }

  // Hash changed - check if it's significant
  const currentModeHint = this.detectModeHeuristic(currentCapture, currentLastLine);
  const modeChanged = currentModeHint !== lastSnapshot.detectedMode;
  const lastLineChanged = currentLastLine !== lastSnapshot.lastLine;

  // Only report change if mode or prompt changed
  if (!modeChanged && !lastLineChanged) {
    return { changed: false };
  }

  return {
    changed: true,
    details: {
      previousMode: lastSnapshot.detectedMode,
      previousProgram: lastSnapshot.detectedProgram,
      previousLastLine: lastSnapshot.lastLine,
      currentCapture,
      currentLastLine,
      currentModeHint
    }
  };
}
```

**Tasks:**
- [x] Implement `detectStateChange()`

### 2.5 LLM Summary Generation

```typescript
private async generateSummary(details: StateChangeDetails): Promise<string> {
  const prompt = `You are summarizing terminal state changes for an AI agent.

Previous state: ${details.previousMode} mode${details.previousProgram ? ` (${details.previousProgram})` : ''}
Previous prompt: "${details.previousLastLine}"

Current terminal (last 20 lines):
\`\`\`
${details.currentCapture.split('\n').slice(-20).join('\n')}
\`\`\`

Write ONE brief sentence describing what changed. Focus on what the agent needs to know.

Examples:
- "Claude Code has exited and the terminal shows a shell prompt."
- "The Python REPL is still running."
- "A new shell session started in ~/project."`;

  // Use Haiku for fast, cheap summarization
  const response = await this.haikuProvider.invokeSync(
    [{ role: "user", content: [{ type: "text", text: prompt }] }],
    [],
    { model: "claude-haiku-4-5", maxOutputTokens: 100 }
  );

  return response.content[0].text.trim();
}
```

**Tasks:**
- [x] Implement `generateSummary()`
- [x] Add Haiku provider injection to service constructor (uses providerRegistry)
- [x] Handle LLM call failures gracefully (fallback summary)

### 2.6 Snapshot Update

```typescript
private async updateSnapshot(
  sessionId: string,
  hash: string,
  lastLine: string,
  mode: string,
  program: string | null
): Promise<void> {
  const snapshot: TerminalStateSnapshot = {
    screenHash: hash,
    lastLine,
    detectedMode: mode as TerminalStateSnapshot["detectedMode"],
    detectedProgram: program,
    capturedAt: new Date()
  };

  await db
    .update(terminalSessionTable)
    .set({ stateSnapshot: snapshot })
    .where(eq(terminalSessionTable.sessionId, sessionId));
}
```

**Tasks:**
- [x] Implement `updateSnapshot()`

### 2.7 Complete checkAndSync

```typescript
async checkAndSync(sessionId: string, threadId: string): Promise<string | null> {
  try {
    // 1. Capture current state
    const { capture, hash, lastLine } = await this.captureCurrentState(sessionId);

    // 2. Detect changes
    const { changed, details } = await this.detectStateChange(
      sessionId, capture, hash, lastLine
    );

    const currentMode = this.detectModeHeuristic(capture, lastLine);

    // 3. Update pendingCommands if mode changed to shell
    // This ensures terminal.run uses correct output method (tailOutput vs capturePane)
    if (currentMode === "shell") {
      this.terminalSessionManager.clearPendingCommand(sessionId);
    }

    if (!changed) {
      // Update hash but don't inject message
      await this.updateSnapshot(sessionId, hash, lastLine, currentMode, null);
      return null;
    }

    // 4. Generate summary
    const summary = await this.generateSummary(details!);

    // 5. Insert context message
    await this.insertContextMessage(threadId, summary, details!);

    // 6. Update snapshot
    await this.updateSnapshot(sessionId, hash, lastLine, currentMode, null);

    this.logger.info(
      { sessionId, threadId, previousMode: details!.previousMode, currentMode },
      "Context sync: state change detected"
    );

    return summary;
  } catch (err) {
    this.logger.warn({ sessionId, err }, "Context sync failed, skipping");
    return null;
  }
}
```

**Tasks:**
- [x] Implement full `checkAndSync()` method
- [x] Add error handling and logging

### 2.8 Integration: Clear Stale pendingCommands

Add method to `TerminalSessionManager` to allow external clearing:

```typescript
// service/src/runtime/terminal-session-manager.ts

/**
 * Clear pending command tracking for a session.
 * Called by ContextSyncService when detecting shell mode after REPL exit.
 */
clearPendingCommand(sessionId: string): void {
  const pending = this.pendingCommands.get(sessionId);
  if (pending) {
    this.debug("clearing pending command via context sync", {
      sessionId,
      command: pending.command
    });
    this.pendingCommands.set(sessionId, null);
  }
}
```

**Tasks:**
- [x] Add `clearPendingCommand()` method to TerminalSessionManager
- [x] Call from ContextSyncService when shell mode detected

---

## Phase 3: Message Injection

**Goal:** Insert context sync messages into conversation.

### 3.1 Insert Context Message

```typescript
// In ContextSyncService

private async insertContextMessage(
  threadId: string,
  summary: string,
  details: StateChangeDetails
): Promise<void> {
  await db.insert(messageTable).values({
    threadId,
    role: "system",
    displayRole: "Terminal Status",
    content: summary,
    metadata: {
      type: "context_sync",
      previousMode: details.previousMode,
      currentMode: details.currentModeHint,
      automated: true
    },
    // Timestamp slightly before "now" to sort before user message
    createdAt: new Date(Date.now() - 100)
  });
}
```

**Tasks:**
- [x] Implement `insertContextMessage()`

### 3.2 Provider Transformation (Anthropic)

```typescript
// service/src/llm/providers/anthropic.ts

// In transformMessages() or similar:
private transformSystemMessages(messages: CanonicalMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  let isFirst = true;

  for (const msg of messages) {
    if (msg.role === "system") {
      if (isFirst) {
        // First system message handled separately (Anthropic system param)
        isFirst = false;
        continue;
      }
      // Mid-conversation system → user with prefix
      result.push({
        role: "user",
        content: `[System Note] ${this.extractText(msg)}`
      });
    } else {
      result.push(this.transformMessage(msg));
      isFirst = false;
    }
  }

  return result;
}
```

**Tasks:**
- [x] Add mid-conversation system message handling to AnthropicProvider
- [x] Verify OpenAI provider passes system messages through unchanged (inherent behavior)
- [ ] Add tests for message transformation (TODO: future enhancement)

---

## Phase 4: Integration

**Goal:** Hook context sync into message flow.

### 4.1 AgentService: isThreadActive

```typescript
// service/src/agent/agent-service.ts

// Add method to check if thread has active agent
isThreadActive(threadId: string): boolean {
  return this.cancellations.has(threadId);
}
```

**Tasks:**
- [x] Add `isThreadActive()` method to AgentService

### 4.2 Message Endpoint Integration

```typescript
// service/src/routes/threads.ts

// In POST /api/threads/:threadId/messages handler:

// After getting session, before creating user message:
if (session) {
  const isAgentActive = agentService.isThreadActive(threadId);

  if (!isAgentActive) {
    const contextUpdate = await contextSyncService.checkAndSync(
      session.sessionId,
      threadId
    );

    if (contextUpdate) {
      logger.info({ threadId, update: contextUpdate }, "Context sync injected");
    }
  }
}

// Continue with user message creation...
```

**Tasks:**
- [x] Inject ContextSyncService into routes
- [x] Add context sync call before message creation
- [x] Add logging

### 4.3 Service Initialization

```typescript
// service/src/app.ts or wherever services are initialized

const contextSyncService = new ContextSyncService(
  terminalSessionManager,
  providerRegistry.getProviderForModel("claude-haiku-4-5"),
  logger
);

// Pass to routes
```

**Tasks:**
- [x] Initialize ContextSyncService in app startup (server.ts)
- [x] Pass to routes that need it (registerThreadRoutes)

---

## Phase 5: Testing

### 5.1 Unit Tests

```typescript
// service/src/terminal/context-sync-service.spec.ts

describe("ContextSyncService", () => {
  describe("detectModeHeuristic", () => {
    it("detects shell prompt ending in $", () => { /* ... */ });
    it("detects shell prompt ending in #", () => { /* ... */ });
    it("detects custom prompt with ❯", () => { /* ... */ });
    it("detects Python REPL >>>", () => { /* ... */ });
    it("detects Claude Code TUI", () => { /* ... */ });
    it("returns unknown for ambiguous output", () => { /* ... */ });
  });

  describe("detectStateChange", () => {
    it("returns false when hash unchanged", () => { /* ... */ });
    it("returns false when only minor output changed", () => { /* ... */ });
    it("returns true when mode changed", () => { /* ... */ });
    it("returns true when prompt line changed", () => { /* ... */ });
  });
});
```

**Tasks:**
- [ ] Add unit tests for heuristic detection
- [ ] Add unit tests for change detection
- [ ] Add integration tests for full flow

### 5.2 Manual Testing Scenarios

| Scenario | Steps | Expected |
|----------|-------|----------|
| Shell → Claude Code → Shell | 1. Send message (shell)<br>2. Agent starts Claude<br>3. User types "exit"<br>4. Send new message | Context sync message injected before user message |
| No change | 1. Send message<br>2. Agent runs command<br>3. Send another message | No context sync (hash same or minor change) |
| Session recreated | 1. Wait for idle timeout<br>2. Send message | Context sync: "new shell session" |
| Python REPL exit | 1. Agent starts python<br>2. User types exit()<br>3. Send message | Context sync: "Python exited" |

**Tasks:**
- [ ] Manual test each scenario
- [ ] Document results

---

## Phase 6: Cleanup & Documentation

### 6.1 Spec Updates

- [x] Update `terminal.spec.md` with ContextSyncService
- [x] Update `agent.spec.md` with isThreadActive
- [x] Update `routes.spec.md` with context sync flow
- [x] Update `providers.spec.md` with system message transformation

### 6.2 Logging & Observability

- [ ] Add structured logging for context sync events
- [ ] Consider metrics for:
  - Context sync triggers per hour
  - LLM summary call duration
  - False positive rate (if trackable)

---

## Rollout

1. Deploy with feature flag (if we have one) or to staging first
2. Monitor for:
   - Latency impact on message send
   - LLM cost from Haiku calls
   - User feedback on context accuracy
3. Iterate on heuristics based on real-world prompt patterns

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Haiku call fails | Catch error, skip context sync, log warning |
| Capture-pane fails | Skip context sync, agent discovers via tools |
| False positives (unnecessary updates) | Tune heuristics, require mode OR prompt change |
| Context message confuses agent | Clear prefix, test with various models |
| Latency too high | Haiku is fast (~200ms), acceptable for message send |

---

## Dependencies

- Haiku model available via provider registry
- `capture-pane` working reliably
- Database supports JSONB column

---

*Created: 2025-12-16*
*Design doc: [`design/terminal-context-sync.md`](../design/terminal-context-sync.md)*
