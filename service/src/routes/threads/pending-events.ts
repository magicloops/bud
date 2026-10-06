import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { threadTable, budTable } from "../../db/schema.js";
import type { AgentRuntimeStateManager } from "../../runtime/agent-runtime-state.js";
import type { ThreadChange } from "./change-listener.js";

/** Hints mean "reread pending inventory"; they carry no kinds, rows or identities. */
export class PendingRequestEvents {
  private readonly pending = new Map<string, ThreadChange>();
  private draining: Promise<void> | undefined;
  private generation = 0;
  constructor(private readonly runtime: Pick<AgentRuntimeStateManager, "emit" | "invalidateReplay">,
    private readonly owned: (hint: ThreadChange) => Promise<boolean> = async hint => {
      const [row] = await db.select({ id: threadTable.threadId }).from(threadTable)
        .innerJoin(budTable, and(eq(budTable.budId, threadTable.budId), eq(budTable.createdByUserId, hint.owner)))
        .where(and(eq(threadTable.threadId, hint.thread_id!), eq(threadTable.createdByUserId, hint.owner), isNull(threadTable.deletedAt))).limit(1);
      return !!row;
    }) {}
  changed(hint: ThreadChange) {
    if (hint.kind !== "pending" || !hint.thread_id) return;
    this.pending.set(`${hint.owner}:${hint.thread_id}`, hint);
    if (this.pending.size > 1024) { this.lost(); return; }
    if (!this.draining) this.draining = this.drain().finally(() => {
      this.draining = undefined;
      const next = this.pending.values().next().value;
      if (next) this.changed(next);
    });
  }
  lost() { this.generation++; this.pending.clear(); this.runtime.invalidateReplay(); }
  async flush() { while (this.draining) await this.draining; }
  private async drain() {
    for (const [key, hint] of this.pending) {
      this.pending.delete(key);
      const generation = this.generation;
      try {
        if (await this.owned(hint) && generation === this.generation) {
          this.runtime.emit(hint.thread_id!, { event: "agent.pending_requests_changed", data: {} });
        }
      } catch { this.lost(); }
    }
  }
}
