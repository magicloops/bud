import { and, eq, isNull } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { agentInvocationTable as inv, threadTable as threads, budTable as buds } from "../db/schema.js";
import type { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import { serializeInvocation } from "./invocation-view.js";
import type { Invocation } from "./invocation-repository.js";

/** Serialize reload/publication, not stale rows captured by commit callbacks. */
export class InvocationEvents {
  private readonly pending = new Set<string>();
  private draining: Promise<void> | undefined;
  constructor(
    private readonly publish: (row: Invocation) => void,
    private readonly failed: () => void,
    private readonly load: (id: string) => Promise<Invocation | null>,
  ) {}
  changed(ids: string[]) {
    for (const id of ids) this.pending.add(id);
    if (!this.draining) this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.pending.size) this.changed([]);
    });
  }
  async flush() { while (this.draining) await this.draining; }
  private async drain() {
    for (const id of this.pending) {
      this.pending.delete(id);
      try {
        const current = await this.load(id);
        if (current) this.publish(current);
      } catch { this.failed(); }
    }
  }
}

export function invocationEvents(runtime: AgentRuntimeStateManager, failed: () => void, database: Database = db) {
  return new InvocationEvents(row => {
    runtime.emit(row.threadId, { event: "agent.invocation_changed", data: serializeInvocation(row) });
  }, failed, async id => {
    // Internal publication lookup. Only the current owner may receive this
    // thread's events; attaching/replaying still authorizes the live viewer.
    const [row] = await database.select({ invocation: inv }).from(inv)
      .innerJoin(threads, and(eq(threads.threadId, inv.threadId), eq(threads.createdByUserId, inv.createdByUserId)))
      .innerJoin(buds, and(eq(buds.budId, inv.budId), eq(buds.createdByUserId, inv.createdByUserId)))
      .where(and(eq(inv.id, id), isNull(threads.deletedAt))).limit(1);
    return row?.invocation ?? null;
  });
}
