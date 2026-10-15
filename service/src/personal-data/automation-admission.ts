import { invocationTimingTransaction } from "../agent/invocation-timing.js";
import { DataRequestError } from "./contracts.js";
import { automationModelResolver, type AutomationModelResolution } from "./automation-model.js";
import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { InvocationRepository } from "../agent/invocation-repository.js";
import { automationTable as rules, automationRevisionTable as revisions, automationDeliveryTable as deliveries,
  dataOwnerStateTable as owners, agentDataGrantTable as grants, dataDomainEventTable as events,
  contactRevisionTable as evidence, contactTable as contacts, contactSourceTable as sources,
  dataCollectionEpochTable as epochs, dataInstallationTable as installations, healthWorkoutTable as workouts,
  threadTable as threads, budTable as buds } from "../db/schema.js";
import { automationDefinitionSchema, AUTOMATION_LIMITS, grantCoversDefinition, parseAutomationInput,
  type AutomationDefinition } from "./automation-contracts.js";
import { describeLocalWindow } from "./automation-schedule.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Delivery = typeof deliveries.$inferSelect;

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
    return invocationTimingTransaction(this.database, async tx => {
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
      if (!grantCoversDefinition(grant, definition, policy.revision.grantVersion)) return finish("failed", "data_permission_changed");
      const [bud] = await tx.select({ id: buds.budId }).from(buds)
        .where(and(eq(buds.budId, definition.bud_id), eq(buds.createdByUserId, owner))).limit(1);
      if (!bud) return finish("failed", "automation_target_unavailable");
      if (definition.target.mode === "existing_thread") {
        const [thread] = await tx.select({ id: threads.threadId }).from(threads).where(and(
          eq(threads.threadId, definition.target.thread_id), eq(threads.budId, definition.bud_id),
          eq(threads.createdByUserId, owner), isNull(threads.deletedAt))).limit(1);
        if (!thread) return finish("failed", "automation_target_unavailable");
      }
      const trigger = await this.triggerInput(tx, owner, delivery, definition, grant?.healthTypes ?? []);
      if (typeof trigger === "string") return finish("failed", trigger);
      if (policy.rule.state !== "enabled") return wait("automation_paused");
      // Owner lock serializes all admission counts, including concurrent rules.
      // Conservatively budget admitted work across a rolling 24-hour window.
      const usage = await automationUsage(tx, owner, delivery.automationId);
      if (usage.ownerCount >= AUTOMATION_LIMITS.invocations_per_owner_day || usage.ruleCount >= definition.max_invocations_per_day)
        return wait("daily_work_limit");
      let modelResolution: AutomationModelResolution;
      try { modelResolution = (await automationModelResolver(tx, owner, [definition]))(definition); }
      catch (error) {
        if (error instanceof DataRequestError) return finish("failed", error.code);
        throw error;
      }
      let threadId: string;
      if (definition.target.mode === "existing_thread") threadId = definition.target.thread_id;
      else {
        const [thread] = await tx.insert(threads).values({ budId: definition.bud_id, title: definition.name,
          modelId: modelResolution.model, reasoningEffort: modelResolution.reasoning_effort, createdByUserId: owner }).returning();
        threadId = thread.threadId;
      }
      const admitted = await this.invocations.admitInTransaction(tx, { owner, threadId, origin: "automation",
        idempotencyKey: "automation-delivery:" + delivery.id, model: modelResolution.model, reasoningEffort: modelResolution.reasoning_effort,
        latestStartAt: delivery.latestStartAt,
        text: `Automation: ${definition.name}\n\n${definition.instruction}\n\n${trigger.text}`,
        metadata: { model_resolution: modelResolution, automation_id: delivery.automationId, automation_revision: delivery.revision,
          delivery_id: delivery.id, ...trigger.metadata, grant_version: grant?.version ?? 0 },
      });
      await tx.update(deliveries).set({ status: "admitted", invocationId: admitted.invocation.id,
        outcomeCode: null, updatedAt: sql`clock_timestamp()` }).where(eq(deliveries.id, delivery.id));
      return true;
    });
  }

  /** Trigger-specific admission text and metadata, or a failure outcome code. */
  private async triggerInput(tx: Transaction, owner: string, delivery: Delivery, definition: AutomationDefinition,
    healthTypes: string[]): Promise<{ text: string; metadata: Record<string, unknown> } | string> {
    if (definition.event_type === "workout.completed") {
      if (!delivery.domainEventId) return "automation_trigger_mismatch";
      if (!healthTypes.includes("workouts")) return "data_permission_changed";
      const [workout] = await tx.select({ id: workouts.id, activityType: workouts.activityType, startAt: workouts.startAt,
        endAt: workouts.endAt, durationS: workouts.durationS }).from(events)
        .innerJoin(workouts, and(eq(workouts.id, events.workoutId), eq(workouts.createdByUserId, owner)))
        .innerJoin(epochs, and(eq(epochs.id, workouts.epochId), eq(epochs.createdByUserId, owner), isNull(epochs.revokedAt)))
        .innerJoin(installations, and(eq(installations.id, epochs.installationId), eq(installations.createdByUserId, owner), isNull(installations.revokedAt)))
        .where(and(eq(events.id, delivery.domainEventId), eq(events.createdByUserId, owner),
          sql`not exists (select 1 from health_sample_deletion d where d.created_by_user_id = ${owner} and d.hk_uuid = ${workouts.hkUuid})`)).limit(1);
      if (!workout) return "workout_evidence_unavailable";
      return {
        text: `A workout was recorded: ${workout.activityType.replaceAll("_", " ")}, ${Math.round(workout.durationS / 60)} minutes, ` +
          `from ${workout.startAt.toISOString()} to ${workout.endAt.toISOString()}.\nWorkout ID: ${workout.id}\n` +
          "The workout record follows. HealthKit delivers new workouts about hourly, so this may arrive after the workout ended. " +
          "Do not repeat completed actions if the same workout is delivered again.",
        metadata: { domain_event_id: delivery.domainEventId, workout_id: workout.id },
      };
    }
    if (definition.event_type === "schedule") {
      if (!delivery.scheduledFor) return "automation_trigger_mismatch";
      const [previous] = await tx.select({ at: deliveries.scheduledFor }).from(deliveries).where(and(
        eq(deliveries.createdByUserId, owner), eq(deliveries.automationId, delivery.automationId),
        eq(deliveries.status, "admitted"), lt(deliveries.scheduledFor, delivery.scheduledFor)))
        .orderBy(desc(deliveries.scheduledFor)).limit(1);
      const { timezone } = definition.schedule;
      return {
        text: `Scheduled run for ${describeLocalWindow(delivery.scheduledFor, timezone)} (${delivery.scheduledFor.toISOString()}).\n` +
          (previous?.at ? `The previous scheduled run was for ${describeLocalWindow(previous.at, timezone)} (${previous.at.toISOString()}).\n`
            : "This is the first scheduled run of this automation.\n") +
          (definition.data_access.scopes.length
            ? `Approved data access: ${definition.data_access.scopes.join(", ")}, at most ${definition.data_access.history_days} days of history. Query it with your data tools as needed.`
            : "This automation has no personal-data access."),
        metadata: { scheduled_for: delivery.scheduledFor.toISOString(), schedule_timezone: timezone,
          previous_scheduled_for: previous?.at?.toISOString() ?? null },
      };
    }
    if (!delivery.domainEventId) return "automation_trigger_mismatch";
    const [contact] = await tx.select({ id: contacts.id, revisionId: evidence.id, observedAt: evidence.observedAt,
      sourceId: sources.id }).from(events)
      .innerJoin(evidence, and(eq(evidence.id, events.revisionId), eq(evidence.createdByUserId, owner)))
      .innerJoin(contacts, and(eq(contacts.id, evidence.contactId), eq(contacts.createdByUserId, owner)))
      .innerJoin(sources, and(eq(sources.id, contacts.sourceId), eq(sources.createdByUserId, owner)))
      .innerJoin(epochs, and(eq(epochs.id, sources.epochId), eq(epochs.createdByUserId, owner), isNull(epochs.revokedAt)))
      .innerJoin(installations, and(eq(installations.id, epochs.installationId), eq(installations.createdByUserId, owner), isNull(installations.revokedAt)))
      .where(and(eq(events.id, delivery.domainEventId), eq(events.createdByUserId, owner), eq(contacts.visible, true),
        sql`${evidence.observedAt} >= clock_timestamp() - ${definition.data_access.history_days} * interval '1 day'`)).limit(1);
    if (!contact) return "contact_evidence_unavailable";
    return {
      text: `A contact was newly observed, not necessarily created or met, at ${contact.observedAt.toISOString()}.\n` +
        `Contact ID: ${contact.id}\nContact revision ID: ${contact.revisionId}\n` +
        "Query available evidence now, label location uncertainty, and do not repeat completed actions when evidence is enriched.",
      metadata: { domain_event_id: delivery.domainEventId, contact_id: contact.id,
        contact_revision_id: contact.revisionId, source_id: contact.sourceId },
    };
  }
}
