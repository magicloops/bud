# Phase 6: Agent Integration

_Status: Complete_

## Overview

Update the agent service to use `TerminalSessionManager` instead of `TerminalManager`. The agent now works with thread-scoped sessions.

**File:** `service/src/agent/agent-service.ts`

---

## Current State

```typescript
// Current: uses TerminalManager with budId
export class AgentService {
  private readonly terminalManager: TerminalManager;

  private async executeTerminalCall(
    threadId: string,
    directive: ...
  ): Promise<TerminalCallResult> {
    const bud = await this.fetchBudForThread(threadId);
    await this.terminalManager.ensureTerminal(bud.budId);

    // All operations use bud.budId
    await this.terminalManager.sendInput(bud.budId, ...);
    await this.terminalManager.waitForReadiness(bud.budId, ...);
    await this.terminalManager.tailOutput(bud.budId, ...);
    // etc.
  }
}
```

---

## Target State

```typescript
// New: uses TerminalSessionManager with sessionId
export class AgentService {
  private readonly sessionManager: TerminalSessionManager;

  private async executeTerminalCall(
    threadId: string,
    directive: ...
  ): Promise<TerminalCallResult> {
    // Get or create session for this thread
    const session = await this.getOrCreateSession(threadId);

    // All operations use session.sessionId
    await this.sessionManager.sendInput(session.sessionId, ...);
    await this.sessionManager.waitForReadiness(session.sessionId, ...);
    await this.sessionManager.tailOutput(session.sessionId, ...);
    // etc.
  }

  private async getOrCreateSession(threadId: string): Promise<TerminalSession> {
    let session = await this.sessionManager.getSessionForThread(threadId);
    if (!session) {
      const bud = await this.fetchBudForThread(threadId);
      const sessionId = await this.sessionManager.createSessionForThread(threadId, bud.budId);
      session = await this.sessionManager.getSessionForThread(threadId);
    }
    if (!session) {
      throw new Error("Failed to create terminal session");
    }
    // Ensure session is running
    const { ok, error } = await this.sessionManager.ensureSession(session.sessionId);
    if (!ok) {
      throw new Error(error ?? "Failed to ensure terminal session");
    }
    return session;
  }
}
```

---

## Implementation

### 1. Update Constructor

```typescript
export class AgentService {
  private readonly client: OpenAI;
  private readonly sessionManager: SessionManager;
  private readonly terminalSessionManager: TerminalSessionManager;  // Changed
  private readonly events: SessionEventBus;
  // ...

  constructor(
    client: OpenAI,
    sessionManager: SessionManager,
    terminalSessionManager: TerminalSessionManager,  // Changed
    events: SessionEventBus,
    logger: FastifyBaseLogger,
    debugEnabled: boolean,
    openaiDebugEnabled: boolean
  ) {
    this.client = client;
    this.sessionManager = sessionManager;
    this.terminalSessionManager = terminalSessionManager;  // Changed
    // ...
  }
}
```

### 2. Add Session Helper

```typescript
/**
 * Get or create the terminal session for a thread.
 * Creates session on first terminal tool use.
 */
private async getOrCreateSession(threadId: string): Promise<TerminalSession> {
  // Check for existing session
  let session = await this.terminalSessionManager.getSessionForThread(threadId);

  if (!session) {
    // Create new session
    const bud = await this.fetchBudForThread(threadId);
    const sessionId = await this.terminalSessionManager.createSessionForThread(
      threadId,
      bud.budId
    );
    session = await this.terminalSessionManager.getSessionForThread(threadId);

    if (!session) {
      throw new Error("Failed to create terminal session for thread");
    }

    this.logger.info(
      { threadId, sessionId: session.sessionId, budId: bud.budId, component: "agent" },
      "Created new terminal session for thread"
    );
  }

  // Ensure session is running on Bud
  const { ok, resumed, error } = await this.terminalSessionManager.ensureSession(session.sessionId);
  if (!ok) {
    throw new Error(error ?? "Failed to ensure terminal session");
  }

  if (resumed) {
    this.logger.info(
      { sessionId: session.sessionId, component: "agent" },
      "Resumed existing terminal session"
    );
  }

  return session;
}
```

### 3. Update executeTerminalCall

```typescript
private async executeTerminalCall(
  threadId: string,
  directive: Extract<AgentDirective, { type: "tool_call"; tool: string }>
): Promise<TerminalCallResult> {
  // Get or create session for this thread
  const session = await this.getOrCreateSession(threadId);
  const sessionId = session.sessionId;

  // Helper to get context
  const getContext = () => {
    const ctx = this.terminalSessionManager.getSessionContext(sessionId);
    return {
      mode: ctx.mode,
      program: ctx.program,
      programDisplayName: ctx.programDisplayName,
      interactionStyle: ctx.interactionStyle,
      hints: ctx.hints,
    };
  };

  // terminal.interrupt
  if (directive.tool === "terminal.interrupt") {
    await this.terminalSessionManager.sendInterrupt(sessionId);
    const readiness = await this.terminalSessionManager.waitForReadiness(
      sessionId,
      directive.timeoutMs ?? 5000
    );
    const tail = await this.terminalSessionManager.tailOutput(
      sessionId,
      config.terminalOutputBackfillBytes
    );
    const decoded = this.decodeTail(tail.data);
    const finalReadiness = this.normalizeReadiness(readiness, {
      ready: true,
      confidence: 0.6,
      trigger: "interrupt",
      hints: DEFAULT_READINESS_HINTS,
    });
    this.logReadinessDecision(directive.tool, finalReadiness);
    return {
      output: decoded,
      outputBytes: tail.totalBytes,
      readiness: finalReadiness,
      lastLine: decoded.trim().split(/\r?\n/).pop() ?? "",
      truncated: tail.data.length < tail.totalBytes,
      omittedLines: 0,
      context: getContext(),
    };
  }

  // terminal.capture
  if (directive.tool === "terminal.capture") {
    const lines = directive.lines ?? -50;
    const shouldWait = directive.wait === true;

    this.debug("terminal.capture", { sessionId, lines, wait: shouldWait });

    let readiness: Record<string, unknown>;

    if (shouldWait) {
      const sessionReadiness = await this.terminalSessionManager.waitForReadiness(
        sessionId,
        directive.timeoutMs ?? 5000
      );
      readiness = this.normalizeReadiness(sessionReadiness, {
        ready: false,
        confidence: 0.3,
        trigger: "wait_timeout",
        hints: { ...DEFAULT_READINESS_HINTS, may_still_be_processing: true },
      });
      this.logReadinessDecision(directive.tool, readiness);
    } else {
      readiness = { ready: true, confidence: 1.0, trigger: "capture" };
    }

    try {
      const capture = await this.terminalSessionManager.capturePane(
        sessionId,
        { startLine: lines, joinLines: true },
        directive.timeoutMs ?? 5000
      );
      if (capture.error) {
        throw new Error(capture.error);
      }
      this.logTerminalOutput("terminal.capture", capture.output);
      return {
        output: capture.output,
        outputBytes: capture.outputBytes,
        readiness,
        lastLine: capture.output.trim().split(/\r?\n/).pop() ?? "",
        truncated: false,
        omittedLines: 0,
        context: getContext(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { sessionId, error: message, component: "agent_terminal" },
        "capture-pane failed"
      );
      throw err;
    }
  }

  // terminal.run
  const offsetBeforeInput = this.terminalSessionManager.getLastOffset(sessionId);
  this.debug("terminal.run capturing offset before input", { sessionId, offsetBeforeInput });

  const input = directive.input ?? directive.command ?? "";
  const sent = await this.terminalSessionManager.sendInput(
    sessionId,
    Buffer.from(input, "utf-8"),
    { source: "agent" }
  );
  if (!sent.ok) {
    throw new Error(sent.error ?? "terminal_input_failed");
  }

  const readiness = await this.terminalSessionManager.waitForReadiness(
    sessionId,
    directive.timeoutMs ?? 5000
  );
  const offsetAfterReadiness = this.terminalSessionManager.getLastOffset(sessionId);

  this.debug("terminal.run after readiness", {
    sessionId,
    offsetBeforeInput,
    offsetAfterReadiness,
    offsetDelta: offsetAfterReadiness - offsetBeforeInput,
  });

  // Get output based on context mode
  const context = getContext();
  let decoded: string;
  let outputBytes: number;
  let truncated: boolean;

  if (context.mode === "repl") {
    this.debug("terminal.run using capture-pane for REPL context", {
      sessionId,
      program: context.program,
    });

    try {
      const capture = await this.terminalSessionManager.capturePane(sessionId, {
        startLine: -50,
        joinLines: true,
      });
      this.logTerminalOutput("terminal.run (REPL)", capture.output);
      decoded = capture.output;
      outputBytes = capture.outputBytes;
      truncated = false;
    } catch (err) {
      this.logger.warn(
        { sessionId, err, component: "agent_terminal" },
        "capture-pane failed, falling back to pipe-pane"
      );
      const tail = await this.terminalSessionManager.tailOutput(
        sessionId,
        config.terminalOutputBackfillBytes,
        { sinceOffset: offsetBeforeInput }
      );
      decoded = this.decodeTail(tail.data);
      outputBytes = tail.totalBytes;
      truncated = tail.data.length < tail.totalBytes;
    }
  } else {
    const tail = await this.terminalSessionManager.tailOutput(
      sessionId,
      config.terminalOutputBackfillBytes,
      { sinceOffset: offsetBeforeInput }
    );
    decoded = this.decodeTail(tail.data);
    outputBytes = tail.totalBytes;
    truncated = tail.data.length < tail.totalBytes;
  }

  this.debug("terminal.run received output", {
    sessionId,
    offsetBeforeInput,
    mode: context.mode,
    program: context.program,
    outputBytes,
    truncated,
  });

  const finalReadiness = this.normalizeReadiness(readiness, {
    ready: false,
    confidence: 0.3,
    trigger: "timeout",
    hints: { ...DEFAULT_READINESS_HINTS, may_still_be_processing: true },
  });
  this.logReadinessDecision(directive.tool, finalReadiness);

  return {
    output: decoded,
    outputBytes,
    readiness: finalReadiness,
    lastLine: decoded.trim().split(/\r?\n/).pop() ?? "",
    truncated,
    omittedLines: 0,
    context,
  };
}
```

### 4. Update Server Setup

```typescript
// service/src/server.ts or wherever AgentService is instantiated

// Before
const agentService = new AgentService(
  openaiClient,
  sessionManager,
  terminalManager,  // Old
  events,
  logger,
  config.agentDebug,
  config.agentDebugOpenai
);

// After
const agentService = new AgentService(
  openaiClient,
  sessionManager,
  terminalSessionManager,  // New
  events,
  logger,
  config.agentDebug,
  config.agentDebugOpenai
);
```

---

## Implementation Checklist

- [ ] Update `AgentService` constructor to use `TerminalSessionManager`
- [ ] Add `getOrCreateSession(threadId)` helper method
- [ ] Update `executeTerminalCall()` to use sessionId
  - [ ] Replace all `bud.budId` references with `sessionId`
  - [ ] Replace `terminalManager` calls with `terminalSessionManager` calls
- [ ] Update logging to use `sessionId` instead of `budId`
- [ ] Update server setup to pass `TerminalSessionManager`
- [ ] Remove `TerminalManager` import and member

---

## Key Changes

| Before | After |
|--------|-------|
| `this.terminalManager` | `this.terminalSessionManager` |
| `bud.budId` | `session.sessionId` |
| `ensureTerminal(budId)` | `getOrCreateSession(threadId)` → `ensureSession(sessionId)` |
| `getTerminalContext(budId)` | `getSessionContext(sessionId)` |
| `sendInput(budId, ...)` | `sendInput(sessionId, ...)` |
| `sendInterrupt(budId)` | `sendInterrupt(sessionId)` |
| `waitForReadiness(budId, ...)` | `waitForReadiness(sessionId, ...)` |
| `tailOutput(budId, ...)` | `tailOutput(sessionId, ...)` |
| `capturePane(budId, ...)` | `capturePane(sessionId, ...)` |
| `getLastOffset(budId)` | `getLastOffset(sessionId)` |

---

## Notes

- Session is created lazily on first terminal tool use
- `getOrCreateSession()` handles both creation and ensuring
- All terminal operations now go through the session
- Logging updated to show `sessionId` for easier debugging
