import type { FastifyReply } from "fastify";

export type RunEvent = {
  event: string;
  data: Record<string, unknown>;
  id?: string;
};

type Listener = (event: RunEvent) => void;

export class RunEventBus {
  private listeners = new Map<string, Set<Listener>>();
  private buffers = new Map<string, RunEvent[]>();

  constructor(private bufferLimit = 1000) {}

  emit(runId: string, event: RunEvent) {
    if (!this.buffers.has(runId)) {
      this.buffers.set(runId, []);
    }
    const buffer = this.buffers.get(runId)!;
    buffer.push(event);
    if (buffer.length > this.bufferLimit) {
      buffer.shift();
    }

    const listeners = this.listeners.get(runId);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }

  attach(runId: string, reply: FastifyReply) {
    const listener: Listener = (event) => {
      reply.sse({ event: event.event, data: JSON.stringify(event.data), id: event.id });
    };

    const listeners = this.listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(runId, listeners);

    const buffer = this.buffers.get(runId) ?? [];
    for (const event of buffer) {
      listener(event);
    }

    return () => {
      const set = this.listeners.get(runId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }
}
