import { randomUUID } from "node:crypto";
import { loadThreadSummaries } from "./summary-loader.js";

type Summary = Awaited<ReturnType<typeof loadThreadSummaries>>[number];
export type ListCheckpoint = { epoch: string; sequence: number };
export type ListEvent = { event: "upsert" | "remove" | "resync_required"; data: Record<string, unknown> };
type Scope = { epoch: string; sequence: number; tail: Promise<unknown>; queued: number;
  listeners: Set<(event: ListEvent) => void>; dirty: Set<string>; known: Set<string>; timer?: ReturnType<typeof setTimeout> };

/** Serializes only database reads/publications, never client network I/O. */
export class ThreadListFeed {
  private readonly scopes = new Map<string, Scope>();
  constructor(private readonly load: (owner: string, id: string) => Promise<Summary | null> = async (owner, id) =>
    (await loadThreadSummaries(owner, { threadId: id }))[0] ?? null) {}
  private scope(owner: string): Scope {
    let scope = this.scopes.get(owner);
    if (!scope) { scope = { epoch: randomUUID(), sequence: 0, tail: Promise.resolve(), queued: 0, listeners: new Set(), dirty: new Set(), known: new Set() }; this.scopes.set(owner, scope); }
    return scope;
  }
  checkpoint(owner: string): ListCheckpoint {
    const { epoch, sequence } = this.scope(owner); return { epoch, sequence };
  }
  subscribe(owner: string, listener: (event: ListEvent) => void) {
    const scope = this.scope(owner); scope.listeners.add(listener);
    return () => { scope.listeners.delete(listener); this.prune(owner, scope); };
  }
  private prune(owner: string, scope: Scope) {
    if (!scope.listeners.size && !scope.queued && !scope.dirty.size && this.scopes.get(owner) === scope) this.scopes.delete(owner);
  }
  private enqueue<T>(owner: string, work: (scope: Scope) => Promise<T>): Promise<T> {
    const scope = this.scope(owner);
    if (scope.queued >= 256) { this.reset(owner); return Promise.reject(new Error("thread_list_overflow")); }
    scope.queued++;
    const epoch = scope.epoch;
    const promise = scope.tail.then(() => {
      if (scope.epoch !== epoch) throw new Error("thread_list_continuity_lost");
      return work(scope);
    });
    scope.tail = promise.catch(() => { this.reset(owner); }).finally(() => { scope.queued--; this.prune(owner, scope); });
    return promise;
  }
  snapshot<T extends { threads: Summary[] }>(owner: string, read: () => Promise<T>): Promise<T & { feed_checkpoint: ListCheckpoint }> {
    return this.enqueue(owner, async scope => {
      const epoch = scope.epoch;
      const result = await read();
      if (scope.epoch !== epoch) throw new Error("thread_list_continuity_lost");
      for (const thread of result.threads) scope.known.add(thread.thread_id);
      if (scope.known.size > 2048) { this.reset(owner); throw new Error("thread_list_overflow"); }
      return { ...result, feed_checkpoint: { epoch, sequence: scope.sequence } };
    });
  }
  changed(owner: string, id: string): void {
    const scope = this.scopes.get(owner);
    if (!scope?.listeners.size) return;
    scope.dirty.add(id);
    if (scope.dirty.size > 1024) { this.reset(owner); return; }
    scope.timer ??= setTimeout(() => {
      scope.timer = undefined;
      const ids = [...scope.dirty]; scope.dirty.clear();
      void this.enqueue(owner, async current => {
        const epoch = current.epoch;
        for (const id of ids) {
          const thread = await this.load(owner, id);
          if (current.epoch !== epoch) return;
          const checkpoint = { epoch, sequence: ++current.sequence };
          const known = current.known.has(id);
          if (thread) current.known.add(id); else current.known.delete(id);
          if (current.known.size > 2048) { this.reset(owner); return; }
          // IDs are only removed after being visible to this owner scope.
          const event: ListEvent = thread ? { event: "upsert", data: { thread, ...checkpoint } }
            : known ? { event: "remove", data: { thread_id: id, ...checkpoint } }
            : { event: "resync_required", data: { reason: "membership_changed", ...checkpoint } };
          for (const listener of [...current.listeners]) listener(event);
        }
      }).catch(() => {});
    }, 250);
  }
  reset(owner?: string): void {
    for (const [id, scope] of this.scopes) {
      if (owner && id !== owner) continue;
      clearTimeout(scope.timer); scope.timer = undefined; scope.dirty.clear();
      scope.epoch = randomUUID(); scope.sequence = 0; scope.known.clear();
      for (const listener of [...scope.listeners]) listener({ event: "resync_required", data: { reason: "continuity_lost", epoch: scope.epoch, sequence: 0 } });
      this.prune(id, scope);
    }
  }
}
