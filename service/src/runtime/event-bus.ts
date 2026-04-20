import type { FastifyReply } from "fastify";

export type SseEvent = {
  event: string;
  data: Record<string, unknown>;
  id?: string;
};

export type TerminalEvent = SseEvent;

type Listener = (evt: SseEvent) => void;

type AttachOptions = {
  lastEventId?: string | null;
};

class SseEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly buffers = new Map<string, SseEvent[]>();
  private readonly bufferLimit: number;

  constructor(bufferLimit = 1000) {
    this.bufferLimit = bufferLimit;
  }

  emit(channelId: string, event: SseEvent): void {
    if (!this.buffers.has(channelId)) {
      this.buffers.set(channelId, []);
    }
    const buffer = this.buffers.get(channelId)!;
    buffer.push(event);
    if (buffer.length > this.bufferLimit) {
      buffer.shift();
    }

    const listeners = this.listeners.get(channelId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Listener failed (likely disconnected client) - continue to others
        // Don't log here to avoid spam when clients disconnect normally
      }
    }
  }

  /**
   * Clear the event buffer for a channel.
   * Used when bud disconnects to prevent stale events from being replayed.
   */
  clearBuffer(channelId: string): void {
    this.buffers.delete(channelId);
  }

  private getReplayBuffer(channelId: string, options?: AttachOptions) {
    const buffer = this.buffers.get(channelId) ?? [];
    const lastEventId = options?.lastEventId ?? null;

    if (!lastEventId) {
      return {
        buffer,
        replay: buffer,
        resumeFound: null as boolean | null,
      };
    }

    const lastSeenIndex = buffer.findIndex((event) => event.id === lastEventId);
    if (lastSeenIndex === -1) {
      return {
        buffer,
        replay: [] as SseEvent[],
        resumeFound: false,
      };
    }

    return {
      buffer,
      replay: buffer.slice(lastSeenIndex + 1),
      resumeFound: true,
    };
  }

  attach(channelId: string, reply: FastifyReply, options?: AttachOptions): () => void {
    const listener: Listener = (event) => {
      reply.log.info(
        { channelId, event: event.event, component: "sse" },
        "SSE event emit"
      );
      reply.sse({ event: event.event, data: JSON.stringify(event.data), id: event.id });
    };

    const listeners = this.listeners.get(channelId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channelId, listeners);

    const replayState = this.getReplayBuffer(channelId, options);
    reply.log.info(
      {
        channelId,
        buffered: replayState.buffer.length,
        replaying: replayState.replay.length,
        lastEventId: options?.lastEventId ?? null,
        resumeFound: replayState.resumeFound,
        component: "sse",
      },
      "SSE listener attached"
    );
    // Prime the SSE response immediately when there is no buffered event to replay.
    // fastify-sse-v2 only initializes the streaming response on the first reply.sse() call.
    if (replayState.replay.length === 0) {
      reply.sse({
        event: "heartbeat",
        data: JSON.stringify(
          replayState.buffer.length === 0
            ? { ts: Date.now(), initial: true }
            : { ts: Date.now() },
        ),
      });
    }
    for (const event of replayState.replay) {
      listener(event);
    }

    return () => {
      const set = this.listeners.get(channelId);
      if (!set) return;
      set.delete(listener);
      reply.log.info(
        { channelId, remaining: set.size, component: "sse" },
        "SSE listener detached"
      );
      if (set.size === 0) {
        this.listeners.delete(channelId);
      }
    };
  }

  /**
   * Attach a callback-style listener for use in manual SSE streams.
   * Replays buffered events immediately.
   */
  attachCallback(channelId: string, callback: Listener, options?: AttachOptions): () => void {
    const listeners = this.listeners.get(channelId) ?? new Set();
    listeners.add(callback);
    this.listeners.set(channelId, listeners);

    const replayState = this.getReplayBuffer(channelId, options);
    for (const event of replayState.replay) {
      callback(event);
    }

    return () => {
      const set = this.listeners.get(channelId);
      if (!set) return;
      set.delete(callback);
      if (set.size === 0) {
        this.listeners.delete(channelId);
      }
    };
  }
}

export class TerminalEventBus extends SseEventBus {}
export class AgentEventBus extends SseEventBus {}
