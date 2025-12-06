import type { FastifyReply } from "fastify";

export type SseEvent = {
  event: string;
  data: Record<string, unknown>;
  id?: string;
};

export type RunEvent = SseEvent;
export type SessionEvent = SseEvent;
export type TerminalEvent = SseEvent;

// eslint-disable-next-line no-unused-vars
type Listener = (evt: SseEvent) => void;

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

  attach(channelId: string, reply: FastifyReply): () => void {
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

    const buffer = this.buffers.get(channelId) ?? [];
    reply.log.info(
      { channelId, buffered: buffer.length, component: "sse" },
      "SSE listener attached"
    );
    for (const event of buffer) {
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
}

export class RunEventBus extends SseEventBus {}
export class SessionEventBus extends SseEventBus {}
export class TerminalEventBus extends SseEventBus {}
