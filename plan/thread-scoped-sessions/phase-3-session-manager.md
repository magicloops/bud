# Phase 3: TerminalSessionManager

_Status: Complete_

## Overview

Create a new `TerminalSessionManager` class that replaces `TerminalManager`. This class manages thread-scoped terminal sessions instead of bud-scoped terminals.

**File:** `service/src/runtime/terminal-session-manager.ts` (new file)

---

## Current State: TerminalManager

The current `TerminalManager` (`service/src/runtime/terminal-manager.ts`):

- Keyed by `budId` (one terminal per Bud)
- No concept of threads or sessions
- Methods: `ensureTerminal(budId)`, `sendInput(budId, ...)`, etc.
- In-memory state: `readiness`, `lastOffsets`, `pendingCommands`, `pendingCaptures`

```typescript
// Current: budId-keyed
class TerminalManager {
  private readonly readiness = new Map<string, { assessment; updatedAt }>();
  private readonly lastOffsets = new Map<string, number>();
  private readonly pendingCommands = new Map<string, PendingCommand | null>();

  async ensureTerminal(budId: string, ...): Promise<{ ok: boolean }>;
  async sendInput(budId: string, data: Buffer, ...): Promise<{ ok: boolean }>;
  // ...
}
```

---

## Target State: TerminalSessionManager

The new `TerminalSessionManager`:

- Keyed by `sessionId` (one session per thread)
- Creates sessions via `createSessionForThread(threadId, budId)`
- Looks up sessions via `getSessionForThread(threadId)`
- All operations use `sessionId`

```typescript
// New: sessionId-keyed, thread-aware
class TerminalSessionManager {
  private readonly readiness = new Map<string, { assessment; updatedAt }>();
  private readonly lastOffsets = new Map<string, number>();
  private readonly pendingCommands = new Map<string, PendingCommand | null>();

  // Session lifecycle
  async createSessionForThread(threadId: string, budId: string): Promise<string>;
  async getSessionForThread(threadId: string): Promise<TerminalSession | null>;
  async ensureSession(sessionId: string): Promise<{ ok: boolean; resumed: boolean }>;
  async closeSession(sessionId: string): Promise<void>;

  // Terminal operations (all by sessionId)
  async sendInput(sessionId: string, data: Buffer, ...): Promise<{ ok: boolean }>;
  async sendInterrupt(sessionId: string): Promise<{ ok: boolean }>;
  async sendResize(sessionId: string, cols: number, rows: number): Promise<{ ok: boolean }>;
  // ...
}
```

---

## Implementation

### 1. Type Definitions

```typescript
// service/src/terminal/types.ts - updates

export type SessionState = "pending" | "creating" | "ready" | "active" | "idle" | "closed";

export interface TerminalSession {
  sessionId: string;
  threadId: string | null;
  budId: string;
  instanceId: string | null;
  tmuxSessionName: string | null;
  state: SessionState;
  cols: number;
  rows: number;
  createdAt: Date;
  startedAt: Date | null;
  lastActivityAt: Date | null;
}
```

### 2. TerminalSessionManager Class

```typescript
// service/src/runtime/terminal-session-manager.ts

import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import { ulid } from "ulid";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { terminalSessionTable, terminalSessionOutputTable, terminalSessionInputLogTable, threadTable } from "../db/schema.js";
import { config, TERMINAL_PROTO_VERSION } from "../config.js";
import { sendFrameToBud, getBudForSession } from "../ws/gateway.js";
import type { TerminalSession, SessionState, PendingCommand, TerminalContext, ReadinessAssessment } from "../terminal/types.js";
import { TerminalSessionEventBus } from "./terminal-session-event-bus.js";
import { isKnownReplProgram, getProgramInfo } from "../terminal/known-programs.js";

const STALE_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

export class TerminalSessionManager {
  private readonly logger: FastifyBaseLogger;
  private readonly events: TerminalSessionEventBus;

  // In-memory state (keyed by sessionId)
  private readonly readiness = new Map<string, { assessment: ReadinessAssessment; updatedAt: number }>();
  private readonly lastOffsets = new Map<string, number>();
  private readonly pendingCommands = new Map<string, PendingCommand | null>();
  private readonly pendingCaptures = new Map<string, {
    resolve: (result: CaptureResult) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  constructor(logger: FastifyBaseLogger, events: TerminalSessionEventBus) {
    this.logger = logger;
    this.events = events;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a new session for a thread. Returns existing session if one exists.
   */
  async createSessionForThread(threadId: string, budId: string): Promise<string> {
    // Check if thread already has an active session
    const existing = await db.query.terminalSessionTable.findFirst({
      where: and(
        eq(terminalSessionTable.threadId, threadId),
        isNull(terminalSessionTable.closedAt)
      ),
    });

    if (existing) {
      this.logger.info({ threadId, sessionId: existing.sessionId }, "Session already exists for thread");
      return existing.sessionId;
    }

    // Create new session
    const sessionId = `sess_${ulid()}`;
    const tmuxSessionName = this.tmuxSessionName(sessionId);

    await db.insert(terminalSessionTable).values({
      sessionId,
      threadId,
      budId,
      instanceId: null, // Will be set when Bud connects
      tmuxSessionName,
      state: "pending",
    });

    this.logger.info({ threadId, sessionId, budId }, "Created new session for thread");
    return sessionId;
  }

  /**
   * Get the active session for a thread.
   */
  async getSessionForThread(threadId: string): Promise<TerminalSession | null> {
    const row = await db.query.terminalSessionTable.findFirst({
      where: and(
        eq(terminalSessionTable.threadId, threadId),
        isNull(terminalSessionTable.closedAt)
      ),
    });

    if (!row) return null;

    return {
      sessionId: row.sessionId,
      threadId: row.threadId,
      budId: row.budId,
      instanceId: row.instanceId,
      tmuxSessionName: row.tmuxSessionName,
      state: row.state as SessionState,
      cols: row.cols,
      rows: row.rows,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      lastActivityAt: row.lastActivityAt,
    };
  }

  /**
   * Ensure a session is running on its Bud instance.
   * Sends terminal_ensure to Bud if not already connected.
   */
  async ensureSession(sessionId: string): Promise<{ ok: boolean; resumed: boolean; error?: string }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return { ok: false, resumed: false, error: "session_not_found" };
    }

    if (session.state === "closed") {
      return { ok: false, resumed: false, error: "session_closed" };
    }

    // If already ready/active, just return success
    if (session.state === "ready" || session.state === "active") {
      return { ok: true, resumed: false };
    }

    // Send terminal_ensure to Bud
    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_ensure",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      config: {
        cols: session.cols,
        rows: session.rows,
      },
    };

    const sent = sendFrameToBud(session.budId, payload);
    if (!sent) {
      this.logger.warn({ sessionId, budId: session.budId }, "Failed to send terminal_ensure (bud offline)");
      return { ok: false, resumed: false, error: "bud_offline" };
    }

    // Update state to creating
    await db.update(terminalSessionTable)
      .set({ state: "creating", lastActivityAt: new Date() })
      .where(eq(terminalSessionTable.sessionId, sessionId));

    this.logger.info({ sessionId, budId: session.budId }, "terminal_ensure sent");
    return { ok: true, resumed: false };
  }

  /**
   * Close a session.
   */
  async closeSession(sessionId: string, reason = "requested"): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    // Send close to Bud
    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_close",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      reason,
    };
    sendFrameToBud(session.budId, payload);

    // Update DB
    await db.update(terminalSessionTable)
      .set({ state: "closed", closedAt: new Date() })
      .where(eq(terminalSessionTable.sessionId, sessionId));

    // Clear in-memory state
    this.clearSessionCache(sessionId);

    // Emit event
    this.events.emit(sessionId, {
      event: "terminal.status",
      data: { state: "closed", reason },
      id: ulid(),
    });

    this.logger.info({ sessionId, reason }, "Session closed");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Terminal Operations
  // ─────────────────────────────────────────────────────────────────────────

  async sendInput(
    sessionId: string,
    data: Buffer,
    options: { source?: "agent" | "user" | "system"; runId?: string; userId?: string } = {}
  ): Promise<{ ok: boolean; error?: string }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return { ok: false, error: "session_not_found" };
    }

    const inputStr = data.toString("utf-8");
    const source = options.source ?? "agent";

    // Track REPL commands
    if (!this.pendingCommands.get(sessionId) && inputStr.includes("\n")) {
      const command = this.parseCommandFromInput(inputStr);
      if (command && isKnownReplProgram(command)) {
        this.pendingCommands.set(sessionId, {
          input: inputStr,
          command,
          sentAt: Date.now(),
          source,
        });
      }
    }

    // Determine detection mode
    const context = this.getSessionContext(sessionId);
    const useActivityBased = context.mode === "repl";

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_input",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      data: data.toString("base64"),
      await_ready: {
        enabled: true,
        activity_based: useActivityBased,
        ...(useActivityBased
          ? { activity_interval_ms: 5000, activity_stable_count: 2, activity_initial_delay_ms: 2000, max_wait_ms: 60000 }
          : { max_wait_ms: 30000 }),
      },
    };

    const sent = sendFrameToBud(session.budId, payload);
    if (!sent) {
      return { ok: false, error: "bud_offline" };
    }

    // Record input and update stats
    await this.recordInput(sessionId, data, options);
    await this.bumpInputStats(sessionId, data.length);

    return { ok: true };
  }

  async sendInterrupt(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return { ok: false, error: "session_not_found" };
    }

    const context = this.getSessionContext(sessionId);
    const useActivityBased = context.mode === "repl";

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_interrupt",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      await_ready: {
        enabled: true,
        activity_based: useActivityBased,
        ...(useActivityBased
          ? { activity_interval_ms: 5000, activity_stable_count: 2, max_wait_ms: 60000 }
          : { max_wait_ms: 5000 }),
      },
    };

    const sent = sendFrameToBud(session.budId, payload);
    if (!sent) {
      return { ok: false, error: "bud_offline" };
    }

    // Clear pending command
    this.pendingCommands.set(sessionId, null);

    return { ok: true };
  }

  async sendResize(sessionId: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return { ok: false, error: "session_not_found" };
    }

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_resize",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      cols,
      rows,
    };

    const sent = sendFrameToBud(session.budId, payload);
    if (!sent) {
      return { ok: false, error: "bud_offline" };
    }

    await db.update(terminalSessionTable)
      .set({ cols, rows, lastActivityAt: new Date() })
      .where(eq(terminalSessionTable.sessionId, sessionId));

    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Handlers (called by Gateway)
  // ─────────────────────────────────────────────────────────────────────────

  async handleTerminalStatus(sessionId: string, payload: TerminalStatusPayload): Promise<void> {
    const now = new Date();

    await db.update(terminalSessionTable)
      .set({
        state: payload.state,
        tmuxSessionName: payload.info?.tmux_session ?? undefined,
        cols: payload.info?.cols ?? undefined,
        rows: payload.info?.rows ?? undefined,
        startedAt: payload.info?.started_at ? new Date(payload.info.started_at) : undefined,
        lastActivityAt: now,
      })
      .where(eq(terminalSessionTable.sessionId, sessionId));

    this.events.emit(sessionId, {
      event: "terminal.status",
      data: { state: payload.state, info: payload.info ?? {} },
      id: ulid(),
    });
  }

  async handleTerminalOutput(sessionId: string, payload: TerminalOutputPayload): Promise<void> {
    const buffer = Buffer.from(payload.data, "base64");
    const endOffset = payload.byte_offset + buffer.length;

    // Track offset synchronously
    this.lastOffsets.set(sessionId, endOffset);

    // Store output (with soft cap)
    const session = await this.getSession(sessionId);
    if (!session) return;

    const remaining = Math.max(config.terminalOutputSoftCapBytes - (session.outputLogBytes ?? 0), 0);
    const toStore = remaining >= buffer.length ? buffer : buffer.subarray(0, remaining);

    if (toStore.length > 0) {
      await db.insert(terminalSessionOutputTable)
        .values({
          sessionId,
          seq: payload.seq,
          data: toStore,
          byteOffset: payload.byte_offset,
        })
        .onConflictDoNothing({
          target: [terminalSessionOutputTable.sessionId, terminalSessionOutputTable.byteOffset],
        });
    }

    // Update stats
    await db.update(terminalSessionTable)
      .set({
        totalOutputBytes: sql`total_output_bytes + ${buffer.length}`,
        outputLogBytes: sql`LEAST(${config.terminalOutputSoftCapBytes}, output_log_bytes + ${toStore.length})`,
        lastOutputAt: new Date(),
        lastActivityAt: new Date(),
      })
      .where(eq(terminalSessionTable.sessionId, sessionId));

    // Emit to subscribers
    this.events.emit(sessionId, {
      event: "terminal.output",
      data: { seq: payload.seq, data: payload.data, byte_offset: payload.byte_offset },
      id: ulid(),
    });
  }

  async handleTerminalReady(sessionId: string, assessment: ReadinessAssessment): Promise<void> {
    this.readiness.set(sessionId, { assessment, updatedAt: Date.now() });

    // Clear pending command if back at shell
    if (assessment.prompt_type === "shell" && assessment.confidence >= 0.8 && assessment.hints?.looks_like_prompt) {
      this.pendingCommands.set(sessionId, null);
    }

    this.events.emit(sessionId, {
      event: "terminal.ready",
      data: { assessment },
      id: ulid(),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Context & Readiness
  // ─────────────────────────────────────────────────────────────────────────

  getSessionContext(sessionId: string): TerminalContext {
    this.cleanupStaleCommand(sessionId);
    const pending = this.pendingCommands.get(sessionId);

    if (!pending) {
      return { mode: "shell" };
    }

    const programInfo = getProgramInfo(pending.command);
    if (!programInfo) {
      return { mode: "unknown", pendingCommand: pending };
    }

    return {
      mode: "repl",
      pendingCommand: pending,
      program: programInfo.name,
      programDisplayName: programInfo.displayName,
      interactionStyle: programInfo.interactionStyle,
      hints: programInfo.hints,
    };
  }

  getLastOffset(sessionId: string): number {
    return this.lastOffsets.get(sessionId) ?? 0;
  }

  async waitForReadiness(sessionId: string, timeoutMs = 5000): Promise<ReadinessAssessment | null> {
    const start = Date.now();
    const initialUpdated = this.readiness.get(sessionId)?.updatedAt ?? 0;

    while (Date.now() - start < timeoutMs) {
      const latest = this.readiness.get(sessionId);
      if (latest && latest.updatedAt > initialUpdated) {
        return latest.assessment;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return this.readiness.get(sessionId)?.assessment ?? null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async getSession(sessionId: string): Promise<TerminalSession | null> {
    const row = await db.query.terminalSessionTable.findFirst({
      where: eq(terminalSessionTable.sessionId, sessionId),
    });
    if (!row) return null;
    return {
      sessionId: row.sessionId,
      threadId: row.threadId,
      budId: row.budId,
      instanceId: row.instanceId,
      tmuxSessionName: row.tmuxSessionName,
      state: row.state as SessionState,
      cols: row.cols,
      rows: row.rows,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      lastActivityAt: row.lastActivityAt,
    };
  }

  private tmuxSessionName(sessionId: string): string {
    const suffix = sessionId.replace("sess_", "");
    const name = `s_${suffix}`;
    return name.length > 32 ? name.slice(0, 32) : name;
  }

  private clearSessionCache(sessionId: string): void {
    this.readiness.delete(sessionId);
    this.lastOffsets.delete(sessionId);
    this.pendingCommands.delete(sessionId);
  }

  private cleanupStaleCommand(sessionId: string): void {
    const pending = this.pendingCommands.get(sessionId);
    if (pending && Date.now() - pending.sentAt > STALE_COMMAND_TIMEOUT_MS) {
      this.pendingCommands.set(sessionId, null);
    }
  }

  private parseCommandFromInput(input: string): string | null {
    const trimmed = input.replace(/[\r\n]+$/, "").trim();
    if (!trimmed) return null;
    const firstWord = trimmed.split(/\s+/)[0];
    if (!firstWord) return null;
    const basename = firstWord.split("/").pop() || firstWord;
    return basename.replace(/^\.\//, "");
  }

  private async recordInput(sessionId: string, data: Buffer, options: { source?: string; runId?: string; userId?: string }) {
    await db.insert(terminalSessionInputLogTable).values({
      sessionId,
      data,
      source: options.source ?? "agent",
      runId: options.runId,
      userId: options.userId,
    });
  }

  private async bumpInputStats(sessionId: string, deltaBytes: number) {
    await db.update(terminalSessionTable)
      .set({
        totalInputBytes: sql`total_input_bytes + ${deltaBytes}`,
        lastInputAt: new Date(),
        lastActivityAt: new Date(),
      })
      .where(eq(terminalSessionTable.sessionId, sessionId));
  }
}
```

---

## Implementation Checklist

- [ ] Create `service/src/runtime/terminal-session-manager.ts`
  - [ ] Session lifecycle methods (`createSessionForThread`, `getSessionForThread`, `ensureSession`, `closeSession`)
  - [ ] Terminal operations (`sendInput`, `sendInterrupt`, `sendResize`, `capturePane`)
  - [ ] Event handlers (`handleTerminalStatus`, `handleTerminalOutput`, `handleTerminalReady`)
  - [ ] Context methods (`getSessionContext`, `getLastOffset`, `waitForReadiness`)
  - [ ] Output methods (`tailOutput`)
  - [ ] Metrics methods (`fetchMetrics`, `fetchAggregateMetrics`)
  - [ ] Idle management (`startIdleChecks`, `runIdleCheck`)
- [ ] Create `service/src/runtime/terminal-session-event-bus.ts` (session-keyed)
- [ ] Update type definitions in `service/src/terminal/types.ts`
- [ ] Remove `service/src/runtime/terminal-manager.ts`
- [ ] Update imports throughout codebase

---

## Key Differences from TerminalManager

| Aspect | TerminalManager | TerminalSessionManager |
|--------|-----------------|------------------------|
| Key | `budId` | `sessionId` |
| Lookup | Direct by budId | `getSessionForThread(threadId)` |
| Creation | `ensureTerminal(budId)` | `createSessionForThread(threadId, budId)` |
| DB Table | `bud_terminal` | `terminal_session` |
| Events | `emit(budId, ...)` | `emit(sessionId, ...)` |
| Frame | No session_id | All frames include `session_id` |

---

## Notes

- All in-memory Maps are keyed by `sessionId` (not `budId`)
- `getSession()` fetches from DB, `getSessionForThread()` adds thread lookup
- Event emission uses session-keyed channels
- `sendFrameToBud()` still needs `budId` (looked up from session)
