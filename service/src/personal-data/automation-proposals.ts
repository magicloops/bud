import { and, desc, eq, isNull, lt, lte } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { automationProposalTable as proposals, automationTable as rules, agentDataGrantTable as grants,
  dataOwnerStateTable as owners, agentInvocationTable as invocations, agentInvocationActionTable as actions,
  threadTable as threads, budTable as buds } from "../db/schema.js";
import { Automations } from "./automations.js";
import { automationDefinitionSchema, parseAutomationInput } from "./automation-contracts.js";
import { AUTOMATION_PROPOSAL_LIMITS as limits, automationProposalRequestSchema, automationProposalDecisionSchema,
  automationProposalCancelSchema, parseAutomationProposalInput } from "./automation-proposal-contracts.js";
import { DataRequestError } from "./contracts.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Proposal = typeof proposals.$inferSelect;
export type AutomationProposalContext = { owner: string; invocationId: string; workerId: string; fence: number; callId: string };
export const AUTOMATION_PROPOSAL_TOOL = "automations_request_activation";
const notFound = () => new DataRequestError(404, "automation_proposal_not_found", "Automation proposal not found");
const conflict = () => new DataRequestError(409, "automation_proposal_conflict", "Automation proposal changed; reload before continuing");

export function serializeAutomationProposal(row: Proposal) {
  return { proposal_id: row.id, automation_id: row.automationId, invocation_id: row.invocationId,
    thread_id: row.threadId, bud_id: row.budId, call_id: row.callId, definition: row.definition,
    draft_version: row.draftVersion, grant_version: row.grantVersion, version: row.version,
    status: row.status, activated_revision: row.activatedRevision, expires_at: row.expiresAt,
    decided_at: row.decidedAt, created_at: row.createdAt, updated_at: row.updatedAt };
}

export class AutomationProposals {
  constructor(private readonly database: Database = db, private readonly now = () => new Date()) {}

  private async lockOwner(tx: Transaction, owner: string) {
    await tx.insert(owners).values({ createdByUserId: owner }).onConflictDoNothing();
    await tx.select().from(owners).where(eq(owners.createdByUserId, owner)).for("update");
  }
  private async load(tx: Transaction, owner: string, id: string) {
    const [row] = await tx.select().from(proposals).where(and(eq(proposals.id, id), eq(proposals.createdByUserId, owner)));
    if (!row) throw notFound();
    return row;
  }
  private async invocation(tx: Transaction, owner: string, id: string) {
    const [row] = await tx.select({ invocation: invocations }).from(invocations)
      .innerJoin(threads, and(eq(threads.threadId, invocations.threadId), eq(threads.createdByUserId, owner), isNull(threads.deletedAt)))
      .innerJoin(buds, and(eq(buds.budId, invocations.budId), eq(buds.createdByUserId, owner)))
      .where(and(eq(invocations.id, id), eq(invocations.createdByUserId, owner))).for("update", { of: invocations });
    return row?.invocation;
  }
  private async finish(tx: Transaction, row: Proposal, status: "expired" | "canceled" | "stale") {
    const [updated] = await tx.update(proposals).set({ status, version: row.version + 1, updatedAt: this.now() })
      .where(and(eq(proposals.id, row.id), eq(proposals.createdByUserId, row.createdByUserId))).returning();
    return updated;
  }
  private async reconcile(tx: Transaction, row: Proposal): Promise<Proposal> {
    if (row.status !== "pending") return row;
    if (row.expiresAt <= this.now()) return this.finish(tx, row, "expired");
    const invocation = await this.invocation(tx, row.createdByUserId, row.invocationId);
    if (!invocation || invocation.origin !== "human" || invocation.cancelRequestedAt ||
      !["running", "waiting_for_user"].includes(invocation.status)) return this.finish(tx, row, "canceled");
    const [rule] = await tx.select().from(rules).where(and(eq(rules.id, row.automationId), eq(rules.createdByUserId, row.createdByUserId)));
    const [grant] = await tx.select().from(grants).where(eq(grants.createdByUserId, row.createdByUserId));
    if (!rule || rule.state === "deleted" || rule.version !== row.draftVersion || !isDeepStrictEqual(rule.draft, row.definition) ||
      (grant?.version ?? 0) !== row.grantVersion) return this.finish(tx, row, "stale");
    return row;
  }

  async get(owner: string, id: string) {
    return this.database.transaction(async tx => {
      await this.lockOwner(tx, owner);
      return serializeAutomationProposal(await this.reconcile(tx, await this.load(tx, owner, id)));
    });
  }

  async list(owner: string, query: { limit?: number; cursor?: string; pending_only?: boolean } = {}) {
    const limit = query.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > limits.page_size ||
      (query.pending_only !== undefined && typeof query.pending_only !== "boolean"))
      throw new DataRequestError(400, "invalid_automation_proposal_query", "Invalid proposal page");
    let before: string | undefined;
    if (query.cursor !== undefined) {
      try {
        if (typeof query.cursor !== "string" || query.cursor.length > 2048) throw new Error();
        const value = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
        if (value.owner !== owner || value.pending !== !!query.pending_only || !/^ap_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.before)) throw new Error();
        before = value.before;
      } catch { throw new DataRequestError(400, "invalid_automation_proposal_cursor", "Invalid proposal cursor"); }
    }
    return this.database.transaction(async tx => {
      await this.lockOwner(tx, owner);
      // There can be at most 20 pending proposals per owner. Reconcile before
      // filtering so an expired card cannot remain in the pending inventory.
      const pending = await tx.select().from(proposals).where(and(eq(proposals.createdByUserId, owner), eq(proposals.status, "pending")))
        .orderBy(proposals.id).limit(limits.pending_per_owner);
      for (const row of pending) await this.reconcile(tx, row);
      const rows = await tx.select().from(proposals).where(and(eq(proposals.createdByUserId, owner),
        before ? lt(proposals.id, before) : undefined, query.pending_only ? eq(proposals.status, "pending") : undefined))
        .orderBy(desc(proposals.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      return { items: page.map(serializeAutomationProposal), next_cursor: rows.length > limit
        ? Buffer.from(JSON.stringify({ owner, pending: !!query.pending_only, before: page[page.length - 1].id })).toString("base64url") : null };
    });
  }

  async request(context: AutomationProposalContext, input: unknown) {
    return this.database.transaction(tx => this.requestInTransaction(tx, context, input));
  }

  /** Runner must persist its waiting action and release its lease in this transaction. */
  async requestInTransaction(tx: Transaction, context: AutomationProposalContext, input: unknown) {
    const value = parseAutomationProposalInput(automationProposalRequestSchema, input);
    await this.lockOwner(tx, context.owner);
    const invocation = await this.invocation(tx, context.owner, context.invocationId);
    if (!invocation) throw notFound();
    if (invocation.origin !== "human") throw new DataRequestError(403, "automation_management_origin_denied", "Automated runs cannot create standing work");
    if (invocation.status !== "running" || invocation.workerId !== context.workerId || invocation.fence !== context.fence ||
      !invocation.leaseExpiresAt || invocation.leaseExpiresAt <= this.now() || invocation.cancelRequestedAt)
      throw new DataRequestError(409, "invocation_unavailable", "Invocation is no longer executing this request");
    const [action] = await tx.select().from(actions).where(and(eq(actions.invocationId, invocation.id), eq(actions.callId, context.callId),
      eq(actions.createdByUserId, context.owner), eq(actions.kind, AUTOMATION_PROPOSAL_TOOL), eq(actions.fence, context.fence), eq(actions.status, "intent")));
    if (!action) throw new DataRequestError(409, "automation_proposal_intent_required", "A current automation proposal intent is required");
    const [existing] = await tx.select().from(proposals).where(and(eq(proposals.createdByUserId, context.owner),
      eq(proposals.invocationId, invocation.id), eq(proposals.callId, context.callId)));
    if (existing) {
      if (existing.automationId !== value.automation_id || existing.draftVersion !== value.expected_version) throw conflict();
      return serializeAutomationProposal(await this.reconcile(tx, existing));
    }
    const [rule] = await tx.select().from(rules).where(and(eq(rules.id, value.automation_id), eq(rules.createdByUserId, context.owner)));
    if (!rule || rule.state === "deleted") throw notFound();
    if (rule.version !== value.expected_version) throw conflict();
    const definition = parseAutomationInput(automationDefinitionSchema, rule.draft);
    const [grant] = await tx.select().from(grants).where(eq(grants.createdByUserId, context.owner));
    if (!grant || !definition.data_access.scopes.every(scope => grant.scopes.includes(scope)) || definition.data_access.history_days > grant.historyDays)
      throw new DataRequestError(403, "data_permission_required", "Approve the requested data access before requesting activation");
    const pending = await tx.select().from(proposals).where(and(eq(proposals.createdByUserId, context.owner), eq(proposals.status, "pending")))
      .orderBy(proposals.id).limit(limits.pending_per_owner);
    let count = 0;
    for (const row of pending) if ((await this.reconcile(tx, row)).status === "pending") count++;
    if (count >= limits.pending_per_owner) throw new DataRequestError(409, "automation_proposal_limit", "Resolve pending automation reviews before creating more");
    const now = this.now();
    const [row] = await tx.insert(proposals).values({ id: `ap_${ulid()}`, automationId: rule.id, invocationId: invocation.id,
      threadId: invocation.threadId, budId: invocation.budId, callId: context.callId, definition,
      draftVersion: rule.version, grantVersion: grant.version, createdByUserId: context.owner, tenantId: invocation.tenantId,
      createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + limits.expiry_seconds * 1000) }).returning();
    return serializeAutomationProposal(row);
  }

  async decide(owner: string, id: string, input: unknown) {
    return this.resolve(owner, id, parseAutomationProposalInput(automationProposalDecisionSchema, input));
  }
  async cancel(owner: string, id: string, input: unknown) {
    return this.resolve(owner, id, { ...parseAutomationProposalInput(automationProposalCancelSchema, input), decision: "cancel" });
  }
  private async resolve(owner: string, id: string, value: { decision: "approve" | "decline" | "cancel"; expected_version: number; idempotency_key: string }) {
    return this.database.transaction(async tx => {
      await this.lockOwner(tx, owner);
      const prior = await this.load(tx, owner, id);
      if (prior.decisionIdempotencyKey === value.idempotency_key) {
        if (!isDeepStrictEqual(prior.decisionRequest, value)) throw conflict();
        return serializeAutomationProposal(prior);
      }
      if (prior.status !== "pending" || prior.version !== value.expected_version) throw conflict();
      const [used] = await tx.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.createdByUserId, owner), eq(proposals.decisionIdempotencyKey, value.idempotency_key)));
      if (used) throw conflict();
      const current = await this.reconcile(tx, prior);
      if (current.status !== "pending") return serializeAutomationProposal(current);
      let activatedRevision: number | null = null;
      if (value.decision === "approve") {
        try {
          const activated = await new Automations(this.database).activateInTransaction(tx, owner, prior.automationId, {
            expected_version: prior.draftVersion, expected_grant_version: prior.grantVersion, acknowledge_standing_work: true,
          });
          activatedRevision = activated.active_revision;
        } catch (error) {
          // Known validation errors happen before activation writes. SQL failures
          // must escape so the entire decision/activation transaction rolls back.
          if (!(error instanceof DataRequestError)) throw error;
          return serializeAutomationProposal(await this.finish(tx, prior, "stale"));
        }
      }
      const [row] = await tx.update(proposals).set({ status: value.decision === "approve" ? "approved" : value.decision === "decline" ? "declined" : "canceled",
        activatedRevision, version: prior.version + 1, decisionRequest: value, decisionIdempotencyKey: value.idempotency_key,
        decidedByUserId: owner, decidedAt: this.now(), updatedAt: this.now() }).where(and(eq(proposals.id, id), eq(proposals.createdByUserId, owner))).returning();
      return serializeAutomationProposal(row);
    });
  }

  /** Service maintenance; one owner-bound expired proposal per call. */
  async expireNext(owner?: string): Promise<boolean> {
    const [candidate] = await this.database.select({ id: proposals.id, owner: proposals.createdByUserId }).from(proposals)
      .where(and(owner ? eq(proposals.createdByUserId, owner) : undefined, eq(proposals.status, "pending"), lte(proposals.expiresAt, this.now())))
      .orderBy(proposals.expiresAt).limit(1);
    if (!candidate) return false;
    await this.get(candidate.owner, candidate.id);
    return true;
  }
}
