import { and, asc, desc, eq, isNull, lt, lte } from "drizzle-orm";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { automationBootstrapProposalTable as proposals, automationBootstrapProposalMemberTable as members,
  dataOwnerStateTable as owners, agentInvocationTable as invocations, agentInvocationActionTable as actions,
  threadTable as threads, budTable as buds, automationTable as rules, agentDataGrantTable as grants } from "../db/schema.js";
import { AutomationBootstrap } from "./automation-bootstrap.js";
import { automationModelResolver, type AutomationModelResolution } from "./automation-model.js";
import { Automations } from "./automations.js";
import { canonicalJson, DataRequestError } from "./contracts.js";
import { automationBootstrapReviewRequestSchema, frozenBootstrapReviewSchema, type FrozenBootstrapReview } from "./automation-bootstrap-review-contracts.js";
import { AUTOMATION_PROPOSAL_LIMITS as limits, automationProposalDecisionSchema,
  automationProposalCancelSchema, parseAutomationProposalInput } from "./automation-proposal-contracts.js";
import type { AutomationProposalContext } from "./automation-proposals.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Proposal = typeof proposals.$inferSelect;
export const BOOTSTRAP_PROPOSAL_TOOL = "automations_request_existing_contacts";
const missing = () => new DataRequestError(404, "bootstrap_proposal_not_found", "Existing-contact review not found");
const conflict = () => new DataRequestError(409, "bootstrap_proposal_conflict", "Review changed; request a fresh review");
const fingerprint = (value: FrozenBootstrapReview) => createHash("sha256").update(canonicalJson(value)).digest("hex");

export function serializeBootstrapProposal(row: Proposal) {
  const frozen = frozenBootstrapReviewSchema.parse(row.frozen);
  return { proposal_id: row.id, kind: "existing_contacts" as const, automation_id: row.automationId,
    revision: row.revision, invocation_id: row.invocationId, thread_id: row.threadId, bud_id: row.budId,
    call_id: row.callId, definition: frozen.definition, selection: frozen.selection,
    grant_version: frozen.grant_version, member_count: row.memberCount,
    group_size: frozen.selection.mode === "per_contact" ? 1 : 25,
    group_count: Math.ceil(row.memberCount / (frozen.selection.mode === "per_contact" ? 1 : 25)),
    version: row.version, status: row.status, bootstrap_id: row.bootstrapId,
    expires_at: row.expiresAt, decided_at: row.decidedAt, created_at: row.createdAt, updated_at: row.updatedAt };
}

export class AutomationBootstrapProposals {
  constructor(private readonly database: Database = db, private readonly now = () => new Date()) {}
  private async lockOwner(tx: Transaction, owner: string) {
    const [row] = await tx.select().from(owners).where(eq(owners.createdByUserId, owner)).for("update");
    if (!row) throw missing();
  }
  private async load(tx: Transaction, owner: string, id: string) {
    const [row] = await tx.select().from(proposals).where(and(eq(proposals.id, id), eq(proposals.createdByUserId, owner)));
    if (!row) throw missing();
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
  private async reconcile(tx: Transaction, row: Proposal) {
    if (row.status !== "pending") return row;
    if (row.expiresAt <= this.now()) return this.finish(tx, row, "expired");
    const invocation = await this.invocation(tx, row.createdByUserId, row.invocationId);
    if (!invocation || invocation.origin !== "human" || invocation.cancelRequestedAt || !invocation.reservesThread ||
      !["running", "waiting_for_user"].includes(invocation.status)) return this.finish(tx, row, "canceled");
    const [action] = await tx.select().from(actions).where(and(eq(actions.invocationId, row.invocationId),
      eq(actions.callId, row.callId), eq(actions.createdByUserId, row.createdByUserId), eq(actions.kind, BOOTSTRAP_PROPOSAL_TOOL)));
    if (!action || action.fence !== invocation.fence ||
      (action.status !== "intent" && action.status !== "waiting_for_user") ||
      (action.status === "waiting_for_user" && action.evidence?.bootstrap_proposal_id !== row.id))
      return this.finish(tx, row, "canceled");
    const frozen = frozenBootstrapReviewSchema.parse(row.frozen);
    const [rule] = await tx.select().from(rules).where(and(eq(rules.id, row.automationId), eq(rules.createdByUserId, row.createdByUserId)));
    const [grant] = await tx.select().from(grants).where(eq(grants.createdByUserId, row.createdByUserId));
    if (!rule || rule.version !== frozen.selection.expected_version || rule.activeRevision !== row.revision ||
      grant?.version !== frozen.grant_version) return this.finish(tx, row, "stale");
    return row;
  }

  async request(context: AutomationProposalContext, input: unknown) {
    return this.database.transaction(tx => this.requestInTransaction(tx, context, input));
  }
  /** Runner parks the matching intent and releases its lease in this same transaction. */
  async requestInTransaction(tx: Transaction, context: AutomationProposalContext, input: unknown) {
    const selection = parseAutomationProposalInput(automationBootstrapReviewRequestSchema, input);
    await this.lockOwner(tx, context.owner);
    const invocation = await this.invocation(tx, context.owner, context.invocationId);
    if (!invocation) throw missing();
    if (invocation.origin !== "human") throw new DataRequestError(403, "automation_management_origin_denied", "Automated runs cannot request existing-contact work");
    if (invocation.status !== "running" || !invocation.reservesThread || invocation.workerId !== context.workerId ||
      invocation.fence !== context.fence || !invocation.leaseExpiresAt || invocation.leaseExpiresAt <= this.now() || invocation.cancelRequestedAt)
      throw new DataRequestError(409, "invocation_unavailable", "Invocation is no longer executing this request");
    const [action] = await tx.select().from(actions).where(and(eq(actions.invocationId, invocation.id),
      eq(actions.callId, context.callId), eq(actions.createdByUserId, context.owner), eq(actions.kind, BOOTSTRAP_PROPOSAL_TOOL),
      eq(actions.fence, context.fence), eq(actions.status, "intent")));
    if (!action) throw new DataRequestError(409, "bootstrap_proposal_intent_required", "A current existing-contact review intent is required");
    const [existing] = await tx.select().from(proposals).where(and(eq(proposals.createdByUserId, context.owner),
      eq(proposals.invocationId, invocation.id), eq(proposals.callId, context.callId)));
    if (existing) {
      if (!isDeepStrictEqual(frozenBootstrapReviewSchema.parse(existing.frozen).selection, selection)) throw conflict();
      return { kind: "proposal" as const, proposal: serializeBootstrapProposal(await this.reconcile(tx, existing)) };
    }
    const frozen = await new AutomationBootstrap(this.database).freezeReviewInTransaction(tx, context.owner, selection);
    await new Automations(this.database).validateTargetsInTransaction(tx, context.owner, frozen.definition, true);
    if (!frozen.contact_revision_ids.length) return { kind: "no_work" as const, member_count: 0 as const, automation_id: selection.automation_id };
    const pending = await tx.select().from(proposals).where(and(eq(proposals.createdByUserId, context.owner), eq(proposals.status, "pending")))
      .orderBy(proposals.id).limit(limits.pending_per_owner);
    let count = 0;
    for (const row of pending) if ((await this.reconcile(tx, row)).status === "pending") count++;
    if (count >= limits.pending_per_owner) throw new DataRequestError(409, "bootstrap_proposal_limit", "Resolve pending existing-contact reviews first");
    const now = this.now();
    const [row] = await tx.insert(proposals).values({ id: `bp_${ulid()}`, automationId: selection.automation_id,
      revision: frozen.revision, invocationId: invocation.id, threadId: invocation.threadId, budId: invocation.budId,
      callId: context.callId, frozen, fingerprint: fingerprint(frozen), memberCount: frozen.contact_revision_ids.length,
      createdByUserId: context.owner, tenantId: invocation.tenantId, createdAt: now, updatedAt: now,
      expiresAt: new Date(now.getTime() + limits.expiry_seconds * 1000) }).returning();
    await tx.insert(members).values(frozen.contact_revision_ids.map((id, ordinal) => ({ proposalId: row.id,
      ordinal, contactRevisionId: id, createdByUserId: context.owner, tenantId: invocation.tenantId })));
    return { kind: "proposal" as const, proposal: serializeBootstrapProposal(row) };
  }

  async get(owner: string, id: string) {
    return this.database.transaction(async tx => {
      await this.lockOwner(tx, owner);
      const result = serializeBootstrapProposal(await this.reconcile(tx, await this.load(tx, owner, id)));
      let model_resolution: AutomationModelResolution | null = null;
      try { model_resolution = (await automationModelResolver(tx, owner, [result.definition]))(result.definition); } catch { /* Unavailable targets remain reviewable. */ }
      return { ...result, model_resolution };
    });
  }
  async list(owner: string, query: { limit?: number; cursor?: string; pending_only?: boolean } = {}) {
    const limit = query.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > limits.page_size ||
      (query.pending_only !== undefined && typeof query.pending_only !== "boolean")) throw conflict();
    let before: string | undefined;
    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 2048) throw new Error();
        const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
        if (cursor.owner !== owner || cursor.pending !== !!query.pending_only || !/^bp_[0-9A-HJKMNP-TV-Z]{26}$/.test(cursor.before)) throw new Error();
        before = cursor.before;
      } catch { throw conflict(); }
    }
    return this.database.transaction(async tx => {
      const [state] = await tx.select().from(owners).where(eq(owners.createdByUserId, owner)).for("update");
      if (!state) return { items: [], next_cursor: null };
      const pending = await tx.select().from(proposals).where(and(eq(proposals.createdByUserId, owner), eq(proposals.status, "pending")))
        .orderBy(proposals.id).limit(limits.pending_per_owner);
      for (const row of pending) await this.reconcile(tx, row);
      const rows = await tx.select().from(proposals).where(and(eq(proposals.createdByUserId, owner),
        before ? lt(proposals.id, before) : undefined, query.pending_only ? eq(proposals.status, "pending") : undefined))
        .orderBy(desc(proposals.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      return { items: page.map(serializeBootstrapProposal), next_cursor: rows.length > limit ? Buffer.from(JSON.stringify({
        owner, pending: !!query.pending_only, before: page[page.length - 1].id })).toString("base64url") : null };
    });
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
        return serializeBootstrapProposal(prior);
      }
      if (prior.status !== "pending" || prior.version !== value.expected_version) throw conflict();
      const [used] = await tx.select({ id: proposals.id }).from(proposals).where(and(eq(proposals.createdByUserId, owner), eq(proposals.decisionIdempotencyKey, value.idempotency_key)));
      if (used) throw conflict();
      const current = await this.reconcile(tx, prior);
      if (current.status !== "pending") return serializeBootstrapProposal(current);
      let bootstrapId: string | null = null;
      if (value.decision === "approve") {
        const frozen = frozenBootstrapReviewSchema.parse(prior.frozen);
        const stored = await tx.select().from(members).where(and(eq(members.proposalId, id), eq(members.createdByUserId, owner))).orderBy(asc(members.ordinal)).limit(1001);
        if (fingerprint(frozen) !== prior.fingerprint || frozen.owner !== owner || frozen.revision !== prior.revision ||
          frozen.selection.automation_id !== prior.automationId || stored.length !== prior.memberCount ||
          stored.some((member, index) => member.ordinal !== index) ||
          !isDeepStrictEqual(stored.map(member => member.contactRevisionId), frozen.contact_revision_ids))
          throw new Error("bootstrap_proposal_integrity_failed");
        try {
          await new Automations(this.database).validateTargetsInTransaction(tx, owner, frozen.definition, true);
          const receipt = await new AutomationBootstrap(this.database).captureReviewedInTransaction(tx, owner, frozen, `proposal:${id}`);
          bootstrapId = receipt.bootstrap_id;
        } catch (error) {
          if (!(error instanceof DataRequestError)) throw error;
          return serializeBootstrapProposal(await this.finish(tx, prior, "stale"));
        }
      }
      const [row] = await tx.update(proposals).set({ status: value.decision === "approve" ? "approved" : value.decision === "decline" ? "declined" : "canceled",
        bootstrapId, version: prior.version + 1, decisionRequest: value, decisionIdempotencyKey: value.idempotency_key,
        decidedByUserId: owner, decidedAt: this.now(), updatedAt: this.now() })
        .where(and(eq(proposals.id, id), eq(proposals.createdByUserId, owner))).returning();
      return serializeBootstrapProposal(row);
    });
  }
  async expireNext(owner?: string): Promise<boolean> {
    const [candidate] = await this.database.select({ id: proposals.id, owner: proposals.createdByUserId }).from(proposals)
      .where(and(owner ? eq(proposals.createdByUserId, owner) : undefined, eq(proposals.status, "pending"), lte(proposals.expiresAt, this.now())))
      .orderBy(proposals.expiresAt).limit(1);
    if (!candidate) return false;
    await this.get(candidate.owner, candidate.id);
    return true;
  }
}
