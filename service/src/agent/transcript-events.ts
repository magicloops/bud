import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { budTable, messageTable, threadTable } from "../db/schema.js";
import type { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import type { ThreadChange } from "../routes/threads/change-listener.js";
import { serializeMessageView } from "./message-view.js";

/** Complete insert/mutation publication from commit-delivered database hints. */
export class TranscriptEvents {
  private readonly pending = new Map<string, ThreadChange>();
  private draining: Promise<void> | undefined;
  private generation = 0;
  constructor(private readonly runtime: AgentRuntimeStateManager,
    private readonly load: (hint: ThreadChange) => Promise<{ message: typeof messageTable.$inferSelect } | undefined> = loadOwnedMessage) {}
  changed(hint: ThreadChange): void {
    if (hint.kind !== "message" && hint.kind !== "transcript") return;
    if (!hint.thread_id || !hint.message_id) return;
    const key = `${hint.owner}:${hint.thread_id}:${hint.message_id}`;
    const current = this.pending.get(key);
    this.pending.set(key, current?.kind === "transcript" ? current : hint);
    if (this.pending.size > 1024) { this.lost(); return; }
    if (!this.draining) this.draining = this.drain().finally(() => {
      this.draining = undefined;
      const next = this.pending.values().next().value;
      if (next) this.changed(next);
    });
  }
  lost(): void { this.generation++; this.pending.clear(); this.runtime.invalidateReplay(); }
  async flush(): Promise<void> { while (this.draining) await this.draining; }
  private async drain(): Promise<void> {
    for (const [key, hint] of this.pending) {
      this.pending.delete(key);
      const generation = this.generation;
      try {
        if (hint.kind === "transcript") {
          this.runtime.emit(hint.thread_id!, { event: "transcript.invalidated", data: { message_ids: [hint.message_id] } });
          continue;
        }
        const row = await this.load(hint);
        if (generation !== this.generation) continue;
        this.runtime.emit(hint.thread_id!, row ? { event: "transcript.message", data: { message: serializeMessageView(row.message) } }
          : { event: "transcript.invalidated", data: { message_ids: [hint.message_id] } });
      } catch { this.lost(); }
    }
  }
}

async function loadOwnedMessage(hint: ThreadChange) {
        const [row] = await db.select({ message: messageTable }).from(messageTable)
          .innerJoin(threadTable, and(eq(threadTable.threadId, messageTable.threadId), eq(threadTable.createdByUserId, hint.owner), isNull(threadTable.deletedAt)))
          .innerJoin(budTable, and(eq(budTable.budId, threadTable.budId), eq(budTable.createdByUserId, hint.owner)))
          .where(and(eq(messageTable.messageId, hint.message_id!), eq(messageTable.threadId, hint.thread_id!), eq(messageTable.createdByUserId, hint.owner))).limit(1);
  return row;
}
