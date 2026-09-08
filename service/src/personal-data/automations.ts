import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { db, type Database } from "../db/client.js";
import { InvocationRepository } from "../agent/invocation-repository.js";
import { automationTable as rules, automationRevisionTable as revisions, automationDeliveryTable as deliveries, automationBootstrapGroupTable as groups, automationBootstrapTable as bootstraps, dataOwnerStateTable as owners,
  agentDataGrantTable as grants, budTable as buds, threadTable as threads, agentInvocationTable as invocations, messageTable as messages,
  automationProposalTable as proposals, automationBootstrapProposalTable as bootstrapProposals,
  contactSourceTable as sources, dataCollectionEpochTable as epochs, dataInstallationTable as installations } from "../db/schema.js";
import { resolveEffectiveModelSelection } from "../llm/index.js";
import { parseBudLocalModelId, registerBudLocalModelsFromCapabilities } from "../llm/local-llm-capabilities.js";
import { automationDefinitionSchema, automationDraftSchema, automationActivationSchema, automationPauseSchema, automationDeleteSchema,
  parseAutomationInput, AUTOMATION_LIMITS, type AutomationDefinition } from "./automation-contracts.js";
import { DataRequestError } from "./contracts.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Rule = typeof rules.$inferSelect;
const conflict = () => new DataRequestError(409, "automation_conflict", "Automation changed; reload before saving");

export function serializeAutomation(row: Rule) {
  return { automation_id: row.id, version: row.version, state: row.state, draft: row.draft,
    active_revision: row.activeRevision, created_at: row.createdAt, updated_at: row.updatedAt };
}

export class Automations {
  constructor(private readonly database: Database = db) {}

  async list(owner: string) {
    const rows = await this.database.select().from(rules).where(and(eq(rules.createdByUserId, owner), ne(rules.state, "deleted")))
      .orderBy(desc(rules.id)).limit(AUTOMATION_LIMITS.rules_per_owner);
    return { items: rows.map(serializeAutomation) };
  }

  async get(owner: string, id: string) {
    // One statement gives a consistent draft/active-revision snapshot.
    const [row] = await this.database.select({ rule: rules, revision: revisions }).from(rules)
      .leftJoin(revisions, and(eq(revisions.automationId, rules.id),
        eq(revisions.revision, rules.activeRevision), eq(revisions.createdByUserId, owner)))
      .where(and(eq(rules.id, id), eq(rules.createdByUserId, owner))).limit(1);
    if (!row) throw new DataRequestError(404, "automation_not_found", "Automation not found");
    return { ...serializeAutomation(row.rule), active: row.revision ? {
      revision: row.revision.revision, definition: row.revision.definition,
      grant_version: row.revision.grantVersion, activated_at: row.revision.createdAt,
    } : null };
  }

  async history(owner: string, id: string, query: { limit?: number; cursor?: string } = {}) {
    await this.get(owner, id);
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new DataRequestError(400, "invalid_automation_query", "Limit must be between 1 and 100");
    let before: string | undefined;
    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 2048) throw new Error();
        const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
        if (cursor.owner !== owner || cursor.automation !== id || typeof cursor.before !== "string" ||
          !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(cursor.before)) throw new Error();
        before = cursor.before;
      } catch { throw new DataRequestError(400, "invalid_automation_cursor", "Invalid delivery cursor"); }
    }
    const rows = await this.database.select().from(deliveries).where(and(
      eq(deliveries.createdByUserId, owner), eq(deliveries.automationId, id),
      before ? lt(deliveries.id, before) : undefined)).orderBy(desc(deliveries.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const invocationIds = page.flatMap(row => row.invocationId ? [row.invocationId] : []);
    const runs = invocationIds.length ? await this.database.select({ id: invocations.id,
      thread_id: invocations.threadId, bud_id: invocations.budId, status: invocations.status,
      outcome_code: invocations.outcomeCode }).from(invocations)
      .where(and(eq(invocations.createdByUserId, owner), inArray(invocations.id, invocationIds))) : [];
    const byId = new Map(runs.map(run => [run.id, run]));
    return { items: page.map(row => ({ delivery_id: row.id, revision: row.revision,
      domain_event_id: row.domainEventId, invocation_id: row.invocationId, status: row.status,
      outcome_code: row.outcomeCode, latest_start_at: row.latestStartAt,
      invocation: row.invocationId ? byId.get(row.invocationId) ?? null : null,
      created_at: row.createdAt, updated_at: row.updatedAt })),
      next_cursor: rows.length > limit ? Buffer.from(JSON.stringify({ owner, automation: id,
        before: page[page.length - 1].id })).toString("base64url") : null };
  }

  private async lockOwner(tx: Transaction, owner: string) {
    await tx.insert(owners).values({ createdByUserId: owner }).onConflictDoNothing();
    const [row] = await tx.select().from(owners).where(eq(owners.createdByUserId, owner)).for("update");
    return row;
  }

  private async load(tx: Transaction, owner: string, id: string, includeDeleted = false) {
    const [row] = await tx.select().from(rules).where(and(eq(rules.id, id), eq(rules.createdByUserId, owner))).limit(1);
    if (!row || (!includeDeleted && row.state === "deleted")) throw new DataRequestError(404, "automation_not_found", "Automation not found");
    return row;
  }

  async validateTargetsInTransaction(tx: Transaction, owner: string, definition: AutomationDefinition) {
    const [bud] = await tx.select().from(buds).where(and(eq(buds.budId, definition.bud_id), eq(buds.createdByUserId, owner))).limit(1);
    if (!bud) throw new DataRequestError(404, "automation_target_not_found", "Bud not found");
    if (definition.target.mode === "existing_thread") {
      const [thread] = await tx.select({ id: threads.threadId }).from(threads).where(and(
        eq(threads.threadId, definition.target.thread_id), eq(threads.createdByUserId, owner),
        eq(threads.budId, definition.bud_id), isNull(threads.deletedAt))).limit(1);
      if (!thread) throw new DataRequestError(404, "automation_target_not_found", "Thread not found");
    }
    if (definition.sources.source_ids.length) {
      const visible = await tx.select({ id: sources.id }).from(sources)
        .innerJoin(epochs, and(eq(epochs.id, sources.epochId), eq(epochs.createdByUserId, owner)))
        .innerJoin(installations, and(eq(installations.id, epochs.installationId), eq(installations.createdByUserId, owner)))
        .where(and(eq(sources.createdByUserId, owner), inArray(sources.id, definition.sources.source_ids),
          isNull(epochs.revokedAt), isNull(installations.revokedAt)));
      if (visible.length !== definition.sources.source_ids.length) throw new DataRequestError(404, "automation_source_not_found", "Source not found or revoked");
    }
    const local = parseBudLocalModelId(definition.model);
    if (local?.budId && local.budId !== definition.bud_id) throw new DataRequestError(400, "invalid_automation_model", "Selected model belongs to a different Bud");
    registerBudLocalModelsFromCapabilities(definition.bud_id, bud.capabilities);
    try {
      const selected = resolveEffectiveModelSelection({ requestedModel: definition.model,
        requestedReasoning: definition.reasoning_effort, serviceDefaultModel: definition.model, validateAvailability: false });
      if (selected.model !== definition.model || selected.reasoningEffort !== definition.reasoning_effort) throw new Error("selection_changed");
    } catch { throw new DataRequestError(400, "invalid_automation_model", "Choose a supported model and reasoning level"); }
  }

  async create(owner: string, input: unknown, idempotencyKey?: string) {
    return this.database.transaction(tx => this.createInTransaction(tx, owner, input, idempotencyKey));
  }

  async createInTransaction(tx: Transaction, owner: string, input: unknown, idempotencyKey?: string) {
    const definition = parseAutomationInput(automationDefinitionSchema, input);
    if (idempotencyKey !== undefined && (!idempotencyKey || idempotencyKey.length > 256))
      throw new DataRequestError(400, "invalid_automation", "A valid creation retry key is required");
    const id = idempotencyKey === undefined ? ulid() : "auto_" + createHash("sha256")
      .update(JSON.stringify([owner, idempotencyKey])).digest("hex");
      await this.lockOwner(tx, owner);
      const [existing] = await tx.select().from(rules).where(and(eq(rules.id, id), eq(rules.createdByUserId, owner))).limit(1);
      if (existing) {
        // Once edited/activated, creation cannot overwrite the canonical rule.
        if (existing.version !== 0 || !isDeepStrictEqual(existing.draft, definition)) throw conflict();
        return serializeAutomation(existing);
      }
      const [count] = await tx.select({ value: sql<number>`count(*)::integer` }).from(rules).where(and(eq(rules.createdByUserId, owner), ne(rules.state, "deleted")));
      if (count.value >= AUTOMATION_LIMITS.rules_per_owner) throw new DataRequestError(409, "automation_limit_reached", "Automation limit reached");
      await this.validateTargetsInTransaction(tx, owner, definition);
      const [row] = await tx.insert(rules).values({ id, draft: definition,
        createdByUserId: owner, updatedByUserId: owner }).returning();
      return serializeAutomation(row);
  }

  async update(owner: string, id: string, input: unknown) {
    return this.database.transaction(tx => this.updateInTransaction(tx, owner, id, input));
  }

  async updateInTransaction(tx: Transaction, owner: string, id: string, input: unknown) {
    const value = parseAutomationInput(automationDraftSchema, input);
      await this.lockOwner(tx, owner);
      const prior = await this.load(tx, owner, id);
      if (prior.version !== value.expected_version) throw conflict();
      await this.validateTargetsInTransaction(tx, owner, value.definition);
      const [row] = await tx.update(rules).set({ draft: value.definition, version: prior.version + 1,
        updatedByUserId: owner, updatedAt: sql`clock_timestamp()` }).where(eq(rules.id, id)).returning();
      return serializeAutomation(row);
  }

  async activate(owner: string, id: string, input: unknown) {
    return this.database.transaction(tx => this.activateInTransaction(tx, owner, id, input));
  }

  async activateInTransaction(tx: Transaction, owner: string, id: string, input: unknown) {
    const value = parseAutomationInput(automationActivationSchema, input);
    const boundary = await this.lockOwner(tx, owner);
    const prior = await this.load(tx, owner, id);
    if (prior.version !== value.expected_version) throw conflict();
    const definition = parseAutomationInput(automationDefinitionSchema, prior.draft);
    await this.validateTargetsInTransaction(tx, owner, definition);
    const [grant] = await tx.select().from(grants).where(eq(grants.createdByUserId, owner));
    if ((grant?.version ?? 0) !== value.expected_grant_version) throw new DataRequestError(409, "grant_conflict", "Data permissions changed; reload before activating");
    if (!grant || !definition.data_access.scopes.every(scope => grant.scopes.includes(scope)) ||
      definition.data_access.history_days > grant.historyDays) throw new DataRequestError(403, "data_permission_required", "Approve the requested data access before activating");
    const revision = prior.version + 1;
    await tx.insert(revisions).values({ automationId: id, revision, definition,
      publicationBoundary: boundary.publicationSequence, grantVersion: grant.version,
      activatedByUserId: owner, createdByUserId: owner });
    const [row] = await tx.update(rules).set({ state: "enabled", activeRevision: revision, version: revision,
      updatedByUserId: owner, updatedAt: sql`clock_timestamp()` }).where(eq(rules.id, id)).returning();
    return serializeAutomation(row);
  }

  async delete(owner: string, id: string, input: unknown) {
    const value = parseAutomationInput(automationDeleteSchema, input);
    return this.database.transaction(async tx => {
      await this.lockOwner(tx, owner);
      const prior = await this.load(tx, owner, id, true);
      // Terminal tombstone makes a lost-response retry safe without canceling twice.
      if (prior.state === "deleted") return serializeAutomation(prior);
      if (prior.version !== value.expected_version) throw conflict();
      await this.pauseInTransaction(tx, owner, id, {
        expected_version: prior.version, cancel_pending: true, cancel_active: true,
      });
      await tx.update(bootstraps).set({ status: "canceled" }).where(and(
        eq(bootstraps.automationId, id), eq(bootstraps.createdByUserId, owner), eq(bootstraps.status, "pending")));
      // Release pending review continuations even if no client is open to reconcile them.
      for (const table of [proposals, bootstrapProposals]) {
        await tx.update(table).set({ status: "stale", version: sql`${table.version} + 1`, updatedAt: sql`clock_timestamp()` })
          .where(and(eq(table.automationId, id), eq(table.createdByUserId, owner), eq(table.status, "pending")));
      }
      const [row] = await tx.update(rules).set({ state: "deleted" })
        .where(and(eq(rules.id, id), eq(rules.createdByUserId, owner))).returning();
      return serializeAutomation(row);
    });
  }

  async pause(owner: string, id: string, input: unknown) {
    return this.database.transaction(tx => this.pauseInTransaction(tx, owner, id, input));
  }

  async pauseInTransaction(tx: Transaction, owner: string, id: string, input: unknown) {
    const value = parseAutomationInput(automationPauseSchema, input);
      await this.lockOwner(tx, owner);
      const prior = await this.load(tx, owner, id);
      if (prior.version !== value.expected_version) throw conflict();
      const [row] = await tx.update(rules).set({ state: "paused", version: prior.version + 1,
        updatedByUserId: owner, updatedAt: sql`clock_timestamp()` }).where(eq(rules.id, id)).returning();
      if (value.cancel_pending) {
        await tx.update(deliveries).set({ status: "canceled", outcomeCode: "user_canceled",
          updatedAt: sql`clock_timestamp()` }).where(and(eq(deliveries.automationId, id),
            eq(deliveries.createdByUserId, owner), eq(deliveries.status, "pending")));
      }
      if (value.cancel_pending) {
        await tx.update(groups).set({ status: "canceled", outcomeCode: "user_canceled", updatedAt: sql`clock_timestamp()` })
          .where(and(eq(groups.createdByUserId, owner), eq(groups.status, "pending"), sql`exists (
            select 1 from automation_bootstrap b where b.id = ${groups.bootstrapId}
              and b.created_by_user_id = ${owner} and b.automation_id = ${id})`));
      }
      const repository = new InvocationRepository(this.database);
      let canceled = 0;
      if (value.cancel_pending || value.cancel_active) {
        // Bound each read while holding the owner lock across the full decision.
        // Started continuations are active even while waiting for their model.
        while (true) {
          const batch = await tx.select({ id: invocations.id }).from(invocations)
            .innerJoin(messages, and(eq(messages.messageId, invocations.inputMessageId), eq(messages.createdByUserId, owner)))
            .where(and(eq(invocations.createdByUserId, owner), isNull(invocations.cancelRequestedAt),
              sql`(exists (select 1 from automation_delivery d where d.invocation_id = ${invocations.id}
                and d.created_by_user_id = ${owner} and d.automation_id = ${id})
                or exists (select 1 from automation_bootstrap_group g join automation_bootstrap b
                  on b.id = g.bootstrap_id and b.created_by_user_id = ${owner}
                  where g.invocation_id = ${invocations.id} and g.created_by_user_id = ${owner} and b.automation_id = ${id}))`,
              sql`${invocations.status} not in ('succeeded','failed','canceled','expired','needs_review')`,
              value.cancel_pending && value.cancel_active ? undefined : value.cancel_active
                ? sql`${messages.metadata}->>'model_context_at' is not null`
                : sql`${messages.metadata}->>'model_context_at' is null`))
            .orderBy(invocations.id).limit(100).for("update", { of: invocations });
          if (!batch.length) break;
          for (const invocation of batch) {
            await repository.requestCancelInTransaction(tx, owner, invocation.id);
            canceled++;
          }
        }
      }
      return { ...serializeAutomation(row), cancellation_requests: canceled };
  }
}
