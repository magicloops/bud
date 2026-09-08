import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { InvocationRepository } from "../agent/invocation-repository.js";
import { automationTable as rules, automationRevisionTable as revisions, automationDeliveryTable as deliveries,
  dataOwnerStateTable as owners, agentDataGrantTable as grants, dataDomainEventTable as events,
  contactRevisionTable as evidence, contactTable as contacts, contactSourceTable as sources,
  dataCollectionEpochTable as epochs, dataInstallationTable as installations,
  threadTable as threads, budTable as buds } from "../db/schema.js";
import { automationDefinitionSchema, AUTOMATION_LIMITS, parseAutomationInput } from "./automation-contracts.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Caller holds the owner lock across this count and invocation admission. */
export async function automationUsage(tx: Transaction, owner: string, automationId: string) {
  const result = await tx.execute<{ ownerCount: number; ruleCount: number }>(sql`
    select count(*)::integer as "ownerCount",
      count(*) filter (where work.automation_id = ${automationId})::integer as "ruleCount"
    from (
      select d.automation_id, d.invocation_id from automation_delivery d where d.created_by_user_id = ${owner}
      union all
      select b.automation_id, g.invocation_id from automation_bootstrap_group g
        join automation_bootstrap b on b.id = g.bootstrap_id and b.created_by_user_id = ${owner}
        where g.created_by_user_id = ${owner}
    ) work join agent_invocation i on i.id = work.invocation_id and i.created_by_user_id = ${owner}
    where i.created_at > clock_timestamp() - interval '24 hours'`);
  return result.rows[0];
}

/** Durable admission only. Dispatch must independently recheck current policy. */
export class AutomationAdmission {
  private readonly invocations: InvocationRepository;
  constructor(private readonly database: Database = db) {
    this.invocations = new InvocationRepository(database);
  }

  async admitNext(ownerFilter?: string): Promise<boolean> {
    const [candidate] = await this.database.select({ owner: deliveries.createdByUserId }).from(deliveries)
      .where(and(eq(deliveries.status, "pending"), sql`${deliveries.nextAttemptAt} <= clock_timestamp()`,
        ownerFilter ? eq(deliveries.createdByUserId, ownerFilter) : undefined))
      .orderBy(asc(deliveries.nextAttemptAt), asc(deliveries.id)).limit(1);
    if (!candidate) return false;
    return this.database.transaction(async tx => {
      const owner = candidate.owner;
      const [locked] = await tx.select().from(owners).where(eq(owners.createdByUserId, owner))
        .for("update", { skipLocked: true });
      if (!locked) return false;
      const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.createdByUserId, owner),
        eq(deliveries.status, "pending"), sql`${deliveries.nextAttemptAt} <= clock_timestamp()`))
        .orderBy(asc(deliveries.nextAttemptAt), asc(deliveries.id)).limit(1).for("update");
      if (!delivery) return false;
      const finish = async (status: "failed" | "expired", outcomeCode: string) => {
        await tx.update(deliveries).set({ status, outcomeCode, updatedAt: sql`clock_timestamp()` })
          .where(and(eq(deliveries.id, delivery.id), eq(deliveries.createdByUserId, owner)));
        return true;
      };
      const wait = async (outcomeCode: string) => {
        await tx.update(deliveries).set({ outcomeCode, nextAttemptAt: sql`clock_timestamp() + interval '15 seconds'`,
          updatedAt: sql`clock_timestamp()` }).where(eq(deliveries.id, delivery.id));
        return true;
      };
      const clock = await tx.execute<{ expired: boolean }>(sql`select clock_timestamp() >= ${delivery.latestStartAt.toISOString()}::timestamptz as expired`);
      if (clock.rows[0].expired) return finish("expired", "latest_start_elapsed");
      const [policy] = await tx.select({ rule: rules, revision: revisions }).from(rules)
        .innerJoin(revisions, and(eq(revisions.automationId, rules.id), eq(revisions.createdByUserId, owner),
          eq(revisions.revision, delivery.revision)))
        .where(and(eq(rules.id, delivery.automationId), eq(rules.createdByUserId, owner))).limit(1);
      if (!policy || policy.rule.state === "deleted") return finish("failed", "automation_unavailable");
      const definition = parseAutomationInput(automationDefinitionSchema, policy.revision.definition);
      const [grant] = await tx.select().from(grants).where(eq(grants.createdByUserId, owner));
      if (!grant || grant.version !== policy.revision.grantVersion ||
        !definition.data_access.scopes.every(scope => grant.scopes.includes(scope)) ||
        definition.data_access.history_days > grant.historyDays) return finish("failed", "data_permission_changed");
      const [bud] = await tx.select({ id: buds.budId }).from(buds)
        .where(and(eq(buds.budId, definition.bud_id), eq(buds.createdByUserId, owner))).limit(1);
      if (!bud) return finish("failed", "automation_target_unavailable");
      if (definition.target.mode === "existing_thread") {
        const [thread] = await tx.select({ id: threads.threadId }).from(threads).where(and(
          eq(threads.threadId, definition.target.thread_id), eq(threads.budId, definition.bud_id),
          eq(threads.createdByUserId, owner), isNull(threads.deletedAt))).limit(1);
        if (!thread) return finish("failed", "automation_target_unavailable");
      }
      const [contact] = await tx.select({ id: contacts.id, revisionId: evidence.id, observedAt: evidence.observedAt,
        sourceId: sources.id }).from(events)
        .innerJoin(evidence, and(eq(evidence.id, events.revisionId), eq(evidence.createdByUserId, owner)))
        .innerJoin(contacts, and(eq(contacts.id, evidence.contactId), eq(contacts.createdByUserId, owner)))
        .innerJoin(sources, and(eq(sources.id, contacts.sourceId), eq(sources.createdByUserId, owner)))
        .innerJoin(epochs, and(eq(epochs.id, sources.epochId), eq(epochs.createdByUserId, owner), isNull(epochs.revokedAt)))
        .innerJoin(installations, and(eq(installations.id, epochs.installationId), eq(installations.createdByUserId, owner), isNull(installations.revokedAt)))
        .where(and(eq(events.id, delivery.domainEventId), eq(events.createdByUserId, owner), eq(contacts.visible, true),
          sql`${evidence.observedAt} >= clock_timestamp() - ${definition.data_access.history_days} * interval '1 day'`)).limit(1);
      if (!contact) return finish("failed", "contact_evidence_unavailable");
      if (policy.rule.state !== "enabled") return wait("automation_paused");
      // Owner lock serializes all admission counts, including concurrent rules.
      // Conservatively budget admitted work across a rolling 24-hour window.
      const usage = await automationUsage(tx, owner, delivery.automationId);
      if (usage.ownerCount >= AUTOMATION_LIMITS.invocations_per_owner_day || usage.ruleCount >= definition.max_invocations_per_day)
        return wait("daily_work_limit");
      let threadId: string;
      if (definition.target.mode === "existing_thread") threadId = definition.target.thread_id;
      else {
        const [thread] = await tx.insert(threads).values({ budId: definition.bud_id, title: definition.name,
          modelId: definition.model, reasoningEffort: definition.reasoning_effort, createdByUserId: owner }).returning();
        threadId = thread.threadId;
      }
      const admitted = await this.invocations.admitInTransaction(tx, { owner, threadId, origin: "automation",
        idempotencyKey: "automation-delivery:" + delivery.id, model: definition.model, reasoningEffort: definition.reasoning_effort,
        latestStartAt: delivery.latestStartAt,
        text: `Automation: ${definition.name}\n\n${definition.instruction}\n\n` +
          `A contact was newly observed, not necessarily created or met, at ${contact.observedAt.toISOString()}.\n` +
          `Contact ID: ${contact.id}\nContact revision ID: ${contact.revisionId}\n` +
          "Query available evidence now, label location uncertainty, and do not repeat completed actions when evidence is enriched.",
        metadata: { automation_id: delivery.automationId, automation_revision: delivery.revision,
          delivery_id: delivery.id, domain_event_id: delivery.domainEventId, contact_id: contact.id,
          contact_revision_id: contact.revisionId, source_id: contact.sourceId, grant_version: grant.version },
      });
      await tx.update(deliveries).set({ status: "admitted", invocationId: admitted.invocation.id,
        outcomeCode: null, updatedAt: sql`clock_timestamp()` }).where(eq(deliveries.id, delivery.id));
      return true;
    });
  }
}
