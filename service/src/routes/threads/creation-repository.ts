import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../../db/client.js";
import { budTable, threadTable, messageTable, agentInvocationTable, threadCreationReceiptTable as receipts } from "../../db/schema.js";
import { InvocationRepository, InvocationError, type InvocationAdmission } from "../../agent/invocation-repository.js";
import { invocationTimingTransaction } from "../../agent/invocation-timing.js";

/** Parsed semantic input only; sorted object keys make JSON ordering irrelevant. */
export function creationFingerprint(input: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

type PreparedCreation = {
  title?: string;
  modelId: string | null;
  reasoningEffort: string | null;
  admission: Omit<InvocationAdmission, "owner" | "threadId" | "origin" | "idempotencyKey">;
};

export class ThreadCreationRepository {
  constructor(private readonly database: Database = db) {}

  async create(input: { owner: string; budId: string; key: string; fingerprint: string },
    prepare: () => Promise<PreparedCreation | null>) {
    return invocationTimingTransaction(this.database, async tx => {
      // The unique constraint is the durable invariant. This transaction lock
      // also serializes preparation, so a retry never resolves new defaults.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.owner, input.key])}, 0))`);
      const [bud] = await tx.select().from(budTable).where(and(eq(budTable.budId, input.budId),
        eq(budTable.createdByUserId, input.owner))).for("share").limit(1);
      if (!bud) throw new InvocationError("bud_not_found");
      const [receipt] = await tx.select().from(receipts).where(and(eq(receipts.createdByUserId, input.owner),
        eq(receipts.creationKey, input.key))).limit(1);
      if (receipt) {
        if (receipt.fingerprint !== input.fingerprint) throw new InvocationError("creation_key_conflict");
        if (!receipt.threadId || !receipt.messageId || !receipt.invocationId) throw new InvocationError("thread_not_found");
        const [result] = await tx.select({ thread: threadTable, message: messageTable, invocation: agentInvocationTable })
          .from(threadTable).innerJoin(messageTable, and(eq(messageTable.messageId, receipt.messageId),
            eq(messageTable.threadId, threadTable.threadId), eq(messageTable.createdByUserId, input.owner)))
          .innerJoin(agentInvocationTable, and(eq(agentInvocationTable.id, receipt.invocationId),
            eq(agentInvocationTable.threadId, threadTable.threadId), eq(agentInvocationTable.inputMessageId, messageTable.messageId),
            eq(agentInvocationTable.createdByUserId, input.owner)))
          .where(and(eq(threadTable.threadId, receipt.threadId), eq(threadTable.budId, input.budId),
            eq(threadTable.createdByUserId, input.owner), isNull(threadTable.deletedAt))).limit(1);
        if (!result) throw new InvocationError("thread_not_found");
        return { ...result, duplicate: true };
      }
      const prepared = await prepare();
      if (!prepared) return null;
      const [thread] = await tx.insert(threadTable).values({ budId: input.budId, title: prepared.title ?? null,
        modelId: prepared.modelId, reasoningEffort: prepared.reasoningEffort,
        createdByUserId: input.owner, tenantId: bud.tenantId }).returning();
      const receiptId = ulid();
      const admitted = await new InvocationRepository(this.database).admitInTransaction(tx, {
        ...prepared.admission, owner: input.owner, threadId: thread.threadId,
        origin: "human", idempotencyKey: `thread_creation:${receiptId}`,
      });
      await tx.insert(receipts).values({ id: receiptId, creationKey: input.key, fingerprint: input.fingerprint,
        threadId: thread.threadId, messageId: admitted.message.messageId, invocationId: admitted.invocation.id,
        createdByUserId: input.owner, tenantId: bud.tenantId });
      const [currentThread] = await tx.select().from(threadTable).where(eq(threadTable.threadId, thread.threadId));
      return { thread: currentThread, ...admitted };
    });
  }
}
