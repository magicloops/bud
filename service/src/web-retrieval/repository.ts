import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { threadTable, budTable, agentInvocationTable, agentInvocationActionTable,
  webRetrievalArtifactTable as artifacts, webRetrievalRequestTable as requests } from "../db/schema.js";
import { RetrievalError, type RetrievalContext } from "./contracts.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Connection = Database | Tx;
export type Authority = { budId: string; tenantId: string | null; binding: string };
export type Artifact = typeof artifacts.$inferSelect;
export class RetrievalRepository {
  constructor(private readonly database: Database = db) {}

  async authorize(context: RetrievalContext, conn: Connection = this.database): Promise<Authority> {
    const [thread] = await conn.select({ budId: threadTable.budId, tenantId: threadTable.tenantId }).from(threadTable)
      .innerJoin(budTable, eq(threadTable.budId, budTable.budId))
      .where(and(eq(threadTable.threadId, context.threadId), eq(threadTable.createdByUserId, context.owner),
        eq(budTable.createdByUserId, context.owner), isNull(threadTable.deletedAt))).limit(1);
    if (!thread) throw new RetrievalError("not_found", "Owned thread not found.");
    const [invocation] = await conn.select().from(agentInvocationTable).where(and(
      eq(agentInvocationTable.threadId, context.threadId), eq(agentInvocationTable.turnId, context.turnId),
      eq(agentInvocationTable.createdByUserId, context.owner))).limit(1);
    if (!invocation) return { ...thread, binding: "legacy" };
    const [action] = await conn.select().from(agentInvocationActionTable).where(and(
      eq(agentInvocationActionTable.invocationId, invocation.id), eq(agentInvocationActionTable.callId, context.callId),
      eq(agentInvocationActionTable.createdByUserId, context.owner), eq(agentInvocationActionTable.fence, invocation.fence),
      eq(agentInvocationActionTable.status, "intent"))).limit(1);
    if (invocation.status !== "running" || invocation.cancelRequestedAt || !invocation.leaseExpiresAt ||
      invocation.leaseExpiresAt <= new Date() || !action) throw new RetrievalError("execution_changed", "This tool no longer has active execution authority.");
    return { ...thread, binding: `${invocation.id}:${invocation.fence}` };
  }

  async reserve(context: RetrievalContext, fingerprint: string, backend: string): Promise<{ id: string; authority: Authority; saved: Artifact | undefined }> {
    return this.database.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${context.threadId}, 912))`);
      const authority = await this.authorize(context, tx);
      const [prior] = await tx.select().from(requests).where(and(eq(requests.threadId, context.threadId),
        eq(requests.createdByUserId, context.owner), eq(requests.turnId, context.turnId), eq(requests.callId, context.callId)));
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new RetrievalError("call_conflict", "This call was already used for different arguments.");
        if (prior.status !== "completed") throw new RetrievalError("outcome_unknown", "This request already started; it will not be automatically repeated.");
        const saved = await this.load(context, prior.id, tx);
        return { id: prior.id, authority, saved };
      }
      const [count] = await tx.select({ count: sql<number>`count(*)::int` }).from(requests).where(and(
        eq(requests.createdByUserId, context.owner), eq(requests.threadId, context.threadId), eq(requests.turnId, context.turnId)));
      if (count.count >= 10) throw new RetrievalError("request_budget_exhausted", "This invocation has used its 10 web retrieval requests.");
      const [size] = await tx.select({ bytes: sql<number>`coalesce(sum(${artifacts.byteLength}), 0)::int` }).from(artifacts)
        .where(and(eq(artifacts.createdByUserId, context.owner), eq(artifacts.threadId, context.threadId), gt(artifacts.expiresAt, new Date())));
      if (size.bytes + 524288 > 10 * 1024 * 1024) throw new RetrievalError("storage_quota", "This thread's web evidence storage is full.");
      const id = `wr_${ulid()}`;
      await tx.insert(requests).values({ id, threadId: context.threadId, budId: authority.budId,
        turnId: context.turnId, callId: context.callId, fingerprint, backend,
        createdByUserId: context.owner, tenantId: authority.tenantId });
      return { id, authority, saved: undefined };
    });
  }

  async load(context: RetrievalContext, id: string, conn: Connection = this.database): Promise<Artifact> {
    await this.authorize(context, conn);
    const [value] = await conn.select().from(artifacts).where(and(eq(artifacts.id, id),
      eq(artifacts.createdByUserId, context.owner), eq(artifacts.threadId, context.threadId), gt(artifacts.expiresAt, new Date())));
    if (!value) throw new RetrievalError("reference_unavailable", "Reference not found or expired. Read the original public URL again if needed.");
    return value;
  }

  async complete(context: RetrievalContext, id: string, authority: Authority, operation: string,
    backend: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Artifact> {
    return this.database.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${context.threadId}, 912))`);
      const current = await this.authorize(context, tx);
      signal?.throwIfAborted();
      if (current.binding !== authority.binding) throw new RetrievalError("execution_changed", "Execution changed while retrieving the page.");
      const [size] = await tx.select({ bytes: sql<number>`coalesce(sum(${artifacts.byteLength}), 0)::int` }).from(artifacts)
        .where(and(eq(artifacts.createdByUserId, context.owner), eq(artifacts.threadId, context.threadId), gt(artifacts.expiresAt, new Date())));
      const byteLength = Buffer.byteLength(JSON.stringify(payload));
      if (size.bytes + byteLength > 10 * 1024 * 1024) throw new RetrievalError("storage_quota", "This thread's web evidence storage is full.");
      const [receipt] = await tx.update(requests).set({ status: "completed" }).where(and(eq(requests.id, id),
        eq(requests.createdByUserId, context.owner), eq(requests.threadId, context.threadId), eq(requests.status, "started"))).returning();
      if (!receipt) throw new RetrievalError("outcome_unknown", "Request already completed or failed.");
      const [artifact] = await tx.insert(artifacts).values({ id, requestId: id, threadId: context.threadId,
        budId: authority.budId, createdByUserId: context.owner, tenantId: authority.tenantId,
        operation, backend, payload, byteLength, expiresAt: new Date(Date.now() + 7 * 86400000) }).returning();
      signal?.throwIfAborted();
      return artifact;
    });
  }

  async fail(context: RetrievalContext, id: string): Promise<void> {
    await this.database.update(requests).set({ status: "failed" }).where(and(eq(requests.id, id),
      eq(requests.createdByUserId, context.owner), eq(requests.threadId, context.threadId), eq(requests.status, "started")));
  }

  async cleanup(): Promise<void> {
    // Bounded maintenance; request receipts remain to preserve budgets.
    await this.database.execute(sql`delete from ${artifacts} where id in (
      select a.id from ${artifacts} a join ${threadTable} t on t.thread_id = a.thread_id
      where a.expires_at <= now() or t.deleted_at is not null limit 100)`);
  }
}
