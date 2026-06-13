import type { FastifyReply } from "fastify";
import { monotonicFactory } from "ulid";
import type { ContextBudgetSnapshot } from "../agent/context-budget-state.js";
import type { AgentEnvironmentSnapshot } from "../agent/environment.js";
import type { SseEvent } from "./event-bus.js";

export type AgentRuntimePhase =
  | "idle"
  | "starting"
  | "thinking"
  | "tool_running"
  | "waiting_for_user"
  | "streaming_message";

export type AgentPendingTool = {
  client_id: string;
  call_id: string;
  name: string;
  args: Record<string, unknown>;
  started_at: string;
};

export type AgentDraftAssistant = {
  client_id: string;
  text: string;
  started_at: string;
  updated_at: string;
};

export type AgentDraftReasoning = {
  client_id: string;
  text: string;
  llm_call_id: string;
  index: number;
  provider: string;
  provider_model: string;
  started_at: string;
  updated_at: string;
};

export type AgentRuntimeLastError = {
  turn_id: string;
  code: string;
  message: string;
  retryable: boolean;
  occurred_at: string;
};

export type AgentRuntimeSnapshot = {
  active: boolean;
  turn_id: string | null;
  phase: AgentRuntimePhase;
  can_cancel: boolean;
  stream_cursor: string;
  pending_tool: AgentPendingTool | null;
  draft_assistant: AgentDraftAssistant | null;
  draft_reasoning: AgentDraftReasoning[];
  environment: AgentEnvironmentSnapshot | null;
  context_budget: ContextBudgetSnapshot | null;
  last_error: AgentRuntimeLastError | null;
  updated_at: string;
};

export type AgentStreamAttachment =
  | {
      status: "attached";
      detach: () => void;
      replayed: number;
      resume_found: boolean | null;
    }
  | {
      status: "resync_required";
      detach: () => void;
      provided_cursor: string;
    };

type InternalSnapshot = {
  active: boolean;
  turnId: string | null;
  phase: AgentRuntimePhase;
  canCancel: boolean;
  streamCursor: string;
  pendingTool: AgentPendingTool | null;
  draftAssistant:
    | {
        clientId: string;
        text: string;
        startedAt: Date;
        updatedAt: Date;
    }
    | null;
  draftReasoning: Array<{
    turnId: string;
    clientId: string;
    text: string;
    llmCallId: string;
    index: number;
    provider: string;
    providerModel: string;
    startedAt: Date;
    updatedAt: Date;
  }>;
  environment: AgentEnvironmentSnapshot | null;
  contextBudget: ContextBudgetSnapshot | null;
  lastError: AgentRuntimeLastError | null;
  updatedAt: Date;
};

type BufferEntry = {
  cursor: string;
  event: SseEvent | null;
  recordedAt: number;
};

type Listener = (event: SseEvent) => void;

type AttachOptions = {
  afterCursor?: string | null;
};

const DEFAULT_BUFFER_LIMIT = 256;
const DEFAULT_BUFFER_TTL_MS = 60_000;

export class AgentRuntimeStateManager {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly buffers = new Map<string, BufferEntry[]>();
  private readonly snapshots = new Map<string, InternalSnapshot>();
  private readonly nextCursor = monotonicFactory();
  private readonly bufferLimit: number;
  private readonly bufferTtlMs: number;

  constructor(bufferLimit = DEFAULT_BUFFER_LIMIT, bufferTtlMs = DEFAULT_BUFFER_TTL_MS) {
    this.bufferLimit = bufferLimit;
    this.bufferTtlMs = bufferTtlMs;
  }

  getSnapshot(threadId: string): AgentRuntimeSnapshot {
    const snapshot = this.ensureSnapshot(threadId);
    this.ensureCursorAvailable(threadId, snapshot);
    return this.serializeSnapshot(snapshot);
  }

  startTurn(
    threadId: string,
    turnId: string,
    environment?: AgentEnvironmentSnapshot | null,
  ): AgentRuntimeSnapshot {
    return this.updateSnapshot(
      threadId,
      (snapshot) => {
        snapshot.active = true;
        snapshot.turnId = turnId;
        snapshot.phase = "starting";
        snapshot.canCancel = true;
        snapshot.pendingTool = null;
        snapshot.draftAssistant = null;
        snapshot.draftReasoning = [];
        snapshot.environment = environment ?? null;
        snapshot.contextBudget = null;
        snapshot.lastError = null;
      },
      undefined,
    );
  }

  markThinking(threadId: string, cursor?: string): AgentRuntimeSnapshot {
    return this.updateSnapshot(
      threadId,
      (snapshot) => {
        snapshot.phase = "thinking";
        snapshot.pendingTool = null;
      },
      cursor,
    );
  }

  setPendingTool(
    threadId: string,
    pendingTool: AgentPendingTool,
    cursor: string,
  ): AgentRuntimeSnapshot {
    return this.updateSnapshot(
      threadId,
      (snapshot) => {
        snapshot.phase = "tool_running";
        snapshot.pendingTool = pendingTool;
        snapshot.draftAssistant = null;
      },
      cursor,
    );
  }

  setPendingUserQuestions(
    threadId: string,
    pendingTool: AgentPendingTool,
    cursor: string,
  ): AgentRuntimeSnapshot {
    return this.updateSnapshot(
      threadId,
      (snapshot) => {
        snapshot.phase = "waiting_for_user";
        snapshot.pendingTool = pendingTool;
        snapshot.draftAssistant = null;
      },
      cursor,
    );
  }

  setDraftAssistant(
    threadId: string,
    clientId: string,
    text: string,
    cursor: string,
    startedAt?: Date,
  ): AgentRuntimeSnapshot {
    return this.updateSnapshot(
      threadId,
      (snapshot) => {
        const currentDraft = snapshot.draftAssistant?.clientId === clientId
          ? snapshot.draftAssistant
          : null;
        snapshot.phase = "streaming_message";
        snapshot.pendingTool = null;
        snapshot.draftAssistant = {
          clientId,
          text,
          startedAt: currentDraft?.startedAt ?? startedAt ?? new Date(),
          updatedAt: new Date(),
        };
      },
      cursor,
    );
  }

  clearDraftAssistant(threadId: string, cursor?: string): AgentRuntimeSnapshot {
    return this.updateSnapshot(
      threadId,
      (snapshot) => {
        snapshot.phase = "thinking";
        snapshot.draftAssistant = null;
      },
      cursor,
    );
  }

  setDraftReasoning(
    threadId: string,
    draft: {
      turnId: string;
      clientId: string;
      text: string;
      llmCallId: string;
      index: number;
      provider: string;
      providerModel: string;
      startedAt?: Date;
    },
    cursor: string,
  ): AgentRuntimeSnapshot {
    return this.updateSnapshot(
      threadId,
      (snapshot) => {
        snapshot.phase = "thinking";
        snapshot.pendingTool = null;
        const existingIndex = snapshot.draftReasoning.findIndex(
          (current) => current.clientId === draft.clientId,
        );
        const current = existingIndex >= 0 ? snapshot.draftReasoning[existingIndex] : null;
        const next = {
          turnId: draft.turnId,
          clientId: draft.clientId,
          text: draft.text,
          llmCallId: draft.llmCallId,
          index: draft.index,
          provider: draft.provider,
          providerModel: draft.providerModel,
          startedAt: current?.startedAt ?? draft.startedAt ?? new Date(),
          updatedAt: new Date(),
        };
        if (existingIndex >= 0) {
          snapshot.draftReasoning[existingIndex] = next;
        } else {
          snapshot.draftReasoning.push(next);
        }
      },
      cursor,
    );
  }

  clearDraftReasoning(
    threadId: string,
    clientId: string,
    cursor?: string,
  ): AgentRuntimeSnapshot {
    return this.updateSnapshot(
      threadId,
      (snapshot) => {
        snapshot.phase = "thinking";
        snapshot.draftReasoning = snapshot.draftReasoning.filter(
          (draft) => draft.clientId !== clientId,
        );
      },
      cursor,
    );
  }

  advanceCursor(threadId: string, cursor: string): AgentRuntimeSnapshot {
    return this.updateSnapshot(threadId, () => {}, cursor);
  }

  setContextBudget(
    threadId: string,
    contextBudget: ContextBudgetSnapshot | null,
    cursor?: string,
  ): AgentRuntimeSnapshot {
    return this.updateSnapshot(
      threadId,
      (snapshot) => {
        snapshot.contextBudget = contextBudget;
      },
      cursor,
    );
  }

  clearContextBudget(threadId: string, cursor?: string): AgentRuntimeSnapshot {
    return this.setContextBudget(threadId, null, cursor);
  }

  setLastError(
    threadId: string,
    lastError: AgentRuntimeLastError,
    cursor?: string,
  ): AgentRuntimeSnapshot {
    return this.updateSnapshot(
      threadId,
      (snapshot) => {
        snapshot.lastError = lastError;
      },
      cursor,
    );
  }

  clearLastError(threadId: string, cursor?: string): AgentRuntimeSnapshot {
    return this.updateSnapshot(
      threadId,
      (snapshot) => {
        snapshot.lastError = null;
      },
      cursor,
    );
  }

  setEnvironment(
    threadId: string,
    environment: AgentEnvironmentSnapshot | null,
    cursor?: string,
  ): AgentRuntimeSnapshot {
    return this.updateSnapshot(
      threadId,
      (snapshot) => {
        snapshot.environment = environment;
      },
      cursor,
    );
  }

  finishTurn(threadId: string): AgentRuntimeSnapshot {
    return this.updateSnapshot(
      threadId,
      (snapshot) => {
        snapshot.active = false;
        snapshot.turnId = null;
        snapshot.phase = "idle";
        snapshot.canCancel = false;
        snapshot.pendingTool = null;
        snapshot.draftAssistant = null;
        snapshot.draftReasoning = [];
        snapshot.environment = null;
        snapshot.contextBudget = null;
      },
      undefined,
    );
  }

  emit(threadId: string, event: Omit<SseEvent, "id">): string {
    const emittedEvent: SseEvent = {
      ...event,
      id: this.nextCursor(),
    };

    this.appendBuffer(threadId, {
      cursor: emittedEvent.id!,
      event: emittedEvent,
      recordedAt: Date.now(),
    });

    const listeners = this.listeners.get(threadId);
    if (!listeners) {
      return emittedEvent.id!;
    }

    for (const listener of listeners) {
      try {
        listener(emittedEvent);
      } catch {
        // Listener failed (likely disconnected client); continue to others.
      }
    }

    return emittedEvent.id!;
  }

  attach(threadId: string, reply: FastifyReply, options?: AttachOptions): AgentStreamAttachment {
    const attachment = this.prepareAttachment(threadId, options);
    if (attachment.status === "resync_required") {
      reply.log.info(
        {
          channelId: threadId,
          afterCursor: options?.afterCursor ?? null,
          component: "agent_sse",
        },
        "Agent SSE attach requires resync",
      );
      return attachment;
    }

    const listener: Listener = (event) => {
      reply.log.info(
        { channelId: threadId, event: event.event, component: "agent_sse" },
        "Agent SSE event emit",
      );
      reply.sse({ event: event.event, data: JSON.stringify(event.data), id: event.id });
    };

    const listeners = this.listeners.get(threadId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);

    reply.log.info(
      {
        channelId: threadId,
        buffered: attachment.buffered,
        replaying: attachment.replay.length,
        afterCursor: options?.afterCursor ?? null,
        resumeFound: attachment.resumeFound,
        component: "agent_sse",
      },
      "Agent SSE listener attached",
    );

    if (attachment.replay.length === 0) {
      reply.sse({
        event: "heartbeat",
        data: JSON.stringify(
          attachment.buffered === 0
            ? { ts: Date.now(), initial: true }
            : { ts: Date.now() },
        ),
      });
    }

    for (const event of attachment.replay) {
      listener(event);
    }

    return {
      status: "attached",
      detach: () => {
        const set = this.listeners.get(threadId);
        if (!set) {
          return;
        }

        set.delete(listener);
        reply.log.info(
          { channelId: threadId, remaining: set.size, component: "agent_sse" },
          "Agent SSE listener detached",
        );

        if (set.size === 0) {
          this.listeners.delete(threadId);
        }
      },
      replayed: attachment.replay.length,
      resume_found: attachment.resumeFound,
    };
  }

  attachCallback(threadId: string, callback: Listener, options?: AttachOptions): AgentStreamAttachment {
    const attachment = this.prepareAttachment(threadId, options);
    if (attachment.status === "resync_required") {
      return attachment;
    }

    const listeners = this.listeners.get(threadId) ?? new Set<Listener>();
    listeners.add(callback);
    this.listeners.set(threadId, listeners);

    for (const event of attachment.replay) {
      callback(event);
    }

    return {
      status: "attached",
      detach: () => {
        const set = this.listeners.get(threadId);
        if (!set) {
          return;
        }

        set.delete(callback);
        if (set.size === 0) {
          this.listeners.delete(threadId);
        }
      },
      replayed: attachment.replay.length,
      resume_found: attachment.resumeFound,
    };
  }

  private prepareAttachment(threadId: string, options?: AttachOptions) {
    const snapshot = this.ensureSnapshot(threadId);
    this.ensureCursorAvailable(threadId, snapshot);

    const buffer = this.buffers.get(threadId) ?? [];
    const afterCursor = options?.afterCursor ?? null;

    if (!afterCursor) {
      return {
        status: "attached" as const,
        replay: [] as SseEvent[],
        resumeFound: null as boolean | null,
        buffered: buffer.length,
      };
    }

    const resumeIndex = buffer.findIndex((entry) => entry.cursor === afterCursor);
    if (resumeIndex === -1) {
      return {
        status: "resync_required" as const,
        provided_cursor: afterCursor,
        detach: () => {},
      };
    }

    return {
      status: "attached" as const,
      replay: buffer.slice(resumeIndex + 1).flatMap((entry) => (entry.event ? [entry.event] : [])),
      resumeFound: true,
      buffered: buffer.length,
    };
  }

  private ensureSnapshot(threadId: string): InternalSnapshot {
    const existing = this.snapshots.get(threadId);
    if (existing) {
      this.pruneBuffer(threadId);
      return existing;
    }

    const cursor = this.pushCheckpoint(threadId);
    const snapshot: InternalSnapshot = {
      active: false,
      turnId: null,
      phase: "idle",
      canCancel: false,
      streamCursor: cursor,
      pendingTool: null,
      draftAssistant: null,
      draftReasoning: [],
      environment: null,
      contextBudget: null,
      lastError: null,
      updatedAt: new Date(),
    };
    this.snapshots.set(threadId, snapshot);
    return snapshot;
  }

  private updateSnapshot(
    threadId: string,
    updater: (snapshot: InternalSnapshot) => void,
    cursor?: string,
  ): AgentRuntimeSnapshot {
    const snapshot = this.ensureSnapshot(threadId);
    updater(snapshot);
    snapshot.streamCursor = cursor ?? this.pushCheckpoint(threadId);
    snapshot.updatedAt = new Date();
    return this.serializeSnapshot(snapshot);
  }

  private ensureCursorAvailable(threadId: string, snapshot: InternalSnapshot) {
    this.pruneBuffer(threadId);
    const buffer = this.buffers.get(threadId) ?? [];
    const hasCursor = buffer.some((entry) => entry.cursor === snapshot.streamCursor);
    if (hasCursor) {
      return;
    }

    snapshot.streamCursor = this.pushCheckpoint(threadId);
    snapshot.updatedAt = new Date();
  }

  private pushCheckpoint(threadId: string): string {
    const cursor = this.nextCursor();
    this.appendBuffer(threadId, {
      cursor,
      event: null,
      recordedAt: Date.now(),
    });
    return cursor;
  }

  private appendBuffer(threadId: string, entry: BufferEntry) {
    this.pruneBuffer(threadId);
    const buffer = this.buffers.get(threadId) ?? [];
    buffer.push(entry);

    while (buffer.length > this.bufferLimit) {
      buffer.shift();
    }

    this.buffers.set(threadId, buffer);
  }

  private pruneBuffer(threadId: string) {
    const buffer = this.buffers.get(threadId);
    if (!buffer || buffer.length === 0) {
      return;
    }

    const cutoff = Date.now() - this.bufferTtlMs;
    while (buffer.length > 0 && buffer[0]!.recordedAt < cutoff) {
      buffer.shift();
    }

    while (buffer.length > this.bufferLimit) {
      buffer.shift();
    }

    if (buffer.length === 0) {
      this.buffers.delete(threadId);
    }
  }

  private serializeSnapshot(snapshot: InternalSnapshot): AgentRuntimeSnapshot {
    return {
      active: snapshot.active,
      turn_id: snapshot.turnId,
      phase: snapshot.phase,
      can_cancel: snapshot.canCancel,
      stream_cursor: snapshot.streamCursor,
      pending_tool: snapshot.pendingTool,
      draft_assistant: snapshot.draftAssistant
        ? {
            client_id: snapshot.draftAssistant.clientId,
            text: snapshot.draftAssistant.text,
            started_at: snapshot.draftAssistant.startedAt.toISOString(),
            updated_at: snapshot.draftAssistant.updatedAt.toISOString(),
          }
        : null,
      draft_reasoning: snapshot.draftReasoning.map((draft) => ({
        client_id: draft.clientId,
        text: draft.text,
        llm_call_id: draft.llmCallId,
        index: draft.index,
        provider: draft.provider,
        provider_model: draft.providerModel,
        started_at: draft.startedAt.toISOString(),
        updated_at: draft.updatedAt.toISOString(),
      })),
      environment: snapshot.environment,
      context_budget: snapshot.contextBudget,
      last_error: snapshot.lastError,
      updated_at: snapshot.updatedAt.toISOString(),
    };
  }
}
