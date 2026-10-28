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
  locationVisitTable as locationVisits, locationVisitNameTable as visitNames, placeTable as placeRows,
  placePresenceEventTable as presenceEvents,
  threadTable as threads, budTable as buds } from "../db/schema.js";
import { automationDefinitionSchema, AUTOMATION_LIMITS, grantCoversDefinition, parseAutomationInput, withinHistory,
  type AutomationDefinition } from "./automation-contracts.js";
import { describeLocalWindow } from "./automation-schedule.js";
import { presenceReading } from "./place-presence.js";
import { admissionText, duration, lateReport, localTime, phoneTimeZone, timeZoneLine } from "./automation-trigger-text.js";

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
      const trigger = await this.triggerInput(tx, owner, delivery, definition, grant?.healthTypes ?? [], grant?.historyDays ?? 0);
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
        text: admissionText({ event: trigger.event, instruction: definition.instruction, automationName: definition.name,
          automationId: delivery.automationId, reference: trigger.reference }),
        metadata: { model_resolution: modelResolution, automation_id: delivery.automationId, automation_name: definition.name,
          automation_revision: delivery.revision,
          delivery_id: delivery.id, ...trigger.metadata, grant_version: grant?.version ?? 0 },
      });
      await tx.update(deliveries).set({ status: "admitted", invocationId: admitted.invocation.id,
        outcomeCode: null, updatedAt: sql`clock_timestamp()` }).where(eq(deliveries.id, delivery.id));
      return true;
    });
  }

  /** The trigger's event line (plain language, local time), reference details and metadata, or a
   * failure outcome code. */
  private async triggerInput(tx: Transaction, owner: string, delivery: Delivery, definition: AutomationDefinition,
    healthTypes: string[], grantHistoryDays: number): Promise<{ event: string; reference: string[]; metadata: Record<string, unknown> } | string> {
    const now = new Date();
    const late = (happenedAt: Date, reportedAt: Date) => { const line = lateReport(happenedAt, reportedAt); return line ? [line] : []; };
    if (definition.event_type === "place.arrived" || definition.event_type === "place.departed") {
      if (!delivery.domainEventId) return "automation_trigger_mismatch";
      const [row] = await tx.select({ event: events, change: presenceEvents,
        now: sql<Date>`clock_timestamp()`.mapWith(presenceEvents.occurredAt) }).from(events)
        .innerJoin(presenceEvents, and(eq(presenceEvents.id, events.presenceEventId), eq(presenceEvents.createdByUserId, owner)))
        .where(and(eq(events.id, delivery.domainEventId), eq(events.createdByUserId, owner))).limit(1);
      if (!row) return "presence_evidence_unavailable";
      if (!withinHistory(row.change.occurredAt, row.now, Math.min(grantHistoryDays, definition.data_access.history_days)))
        return "history_outside_grant";
      const [place] = await tx.select().from(placeRows).where(and(eq(placeRows.id, row.change.placeId),
        eq(placeRows.createdByUserId, owner), isNull(placeRows.deletedAt))).limit(1);
      if (!place) return "place_unavailable";
      const [visit] = row.change.visitId ? await tx.select().from(locationVisits)
        .where(and(eq(locationVisits.id, row.change.visitId), eq(locationVisits.createdByUserId, owner))).limit(1) : [];
      const stayed = visit?.arrivalAt && visit.departureAt ? duration((visit.departureAt.getTime() - visit.arrivalAt.getTime()) / 1000) : null;
      const zone = await phoneTimeZone(tx, owner, row.event.publishedAt);
      const at = localTime(row.change.occurredAt, zone, now);
      const event = definition.event_type === "place.arrived"
        ? `Arrived at ${place.name} at ${at}.`
        : `Left ${place.name} at ${at}${stayed ? `, after ${stayed} there` : ""}.`;
      const reading = row.change.source === "visit" ? null : await presenceReading(tx, owner, row.change.rawEventId, place);
      const measured = reading ? `a precise reading ${reading.distance_m} m from its centre (±${reading.accuracy_m} m)` : null;
      const how = row.change.source === "visit"
        ? "Detected from an iOS visit report, which arrives several minutes after the fact, then uploads."
        : row.change.source === "reading"
          ? `Detected from ${measured ?? "a precise reading from the phone"}.`
          : measured
            ? `Detected by the phone's geofence for this place and confirmed by ${measured}.`
            : "Detected by the phone's geofence for this place, usually within a minute or two.";
      return {
        event,
        reference: [timeZoneLine(zone), how, ...late(row.change.occurredAt, row.event.publishedAt), ...(visit ? [`Visit ID: ${visit.id}.`] : []),
          "Places are the user's saved labels."],
        metadata: { domain_event_id: delivery.domainEventId, presence_event_id: row.change.id, place_id: place.id,
          visit_id: row.change.visitId },
      };
    }
    if (definition.event_type === "visit.ended") {
      if (!delivery.domainEventId) return "automation_trigger_mismatch";
      const [row] = await tx.select({ visit: locationVisits, name: visitNames, publishedAt: events.publishedAt,
        now: sql<Date>`clock_timestamp()`.mapWith(locationVisits.startedAt) }).from(events)
        .innerJoin(locationVisits, and(eq(locationVisits.id, events.visitId), eq(locationVisits.createdByUserId, owner)))
        .leftJoin(visitNames, and(eq(visitNames.createdByUserId, owner), eq(visitNames.visitKey, locationVisits.visitKey)))
        .where(and(eq(events.id, delivery.domainEventId), eq(events.createdByUserId, owner))).limit(1);
      if (!row) return "visit_evidence_unavailable";
      if (!withinHistory(row.visit.startedAt, row.now, Math.min(grantHistoryDays, definition.data_access.history_days)))
        return "history_outside_grant";
      const where = (row.name?.address as { short?: string } | null)?.short ?? "a place";
      const stayed = row.visit.arrivalAt && row.visit.departureAt
        ? duration((row.visit.departureAt.getTime() - row.visit.arrivalAt.getTime()) / 1000) : null;
      const zone = await phoneTimeZone(tx, owner, row.publishedAt);
      return {
        event: `A visit at ${where} ended at ${localTime(row.visit.departureAt!, zone, now)}${stayed ? `, after ${stayed}` : ""}.`,
        reference: [timeZoneLine(zone), ...late(row.visit.departureAt!, row.publishedAt), `Visit ID: ${row.visit.id}.`,
          "iOS reports visits several minutes after they happen, then uploads, so this may arrive late.",
          "Places are the user's saved labels; a likely place from Apple Maps is not verified."],
        metadata: { domain_event_id: delivery.domainEventId, visit_id: row.visit.id },
      };
    }
    if (definition.event_type === "workout.completed") {
      if (!delivery.domainEventId) return "automation_trigger_mismatch";
      if (!healthTypes.includes("workouts")) return "data_permission_changed";
      const [workout] = await tx.select({ id: workouts.id, activityType: workouts.activityType, startAt: workouts.startAt,
        endAt: workouts.endAt, durationS: workouts.durationS, publishedAt: events.publishedAt,
        now: sql<Date>`clock_timestamp()`.mapWith(workouts.startAt) }).from(events)
        .innerJoin(workouts, and(eq(workouts.id, events.workoutId), eq(workouts.createdByUserId, owner)))
        .innerJoin(epochs, and(eq(epochs.id, workouts.epochId), eq(epochs.createdByUserId, owner), isNull(epochs.revokedAt)))
        .innerJoin(installations, and(eq(installations.id, epochs.installationId), eq(installations.createdByUserId, owner), isNull(installations.revokedAt)))
        .where(and(eq(events.id, delivery.domainEventId), eq(events.createdByUserId, owner),
          sql`not exists (select 1 from health_sample_deletion d where d.created_by_user_id = ${owner} and d.hk_uuid = ${workouts.hkUuid})`)).limit(1);
      if (!workout) return "workout_evidence_unavailable";
      // The same approved-history bound the health tools apply (by workout start).
      if (!withinHistory(workout.startAt, workout.now, Math.min(grantHistoryDays, definition.data_access.history_days)))
        return "history_outside_grant";
      const zone = await phoneTimeZone(tx, owner, workout.publishedAt);
      return {
        event: `Finished a ${Math.max(1, Math.round(workout.durationS / 60))}-minute ${workout.activityType.replaceAll("_", " ")} workout at ${localTime(workout.endAt, zone, now)}.`,
        reference: [timeZoneLine(zone), `It started at ${localTime(workout.startAt, zone, now)}.`, ...late(workout.endAt, workout.publishedAt),
          `Workout ID: ${workout.id}.`,
          "HealthKit delivers new workouts about hourly, so this may arrive after the workout ended.",
          "Don't repeat completed actions if the same workout is delivered again."],
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
        event: `Scheduled run for ${describeLocalWindow(delivery.scheduledFor, timezone)}.`,
        reference: [`Times are in ${timezone}, the automation's time zone.`,
          previous?.at ? `The previous scheduled run was for ${describeLocalWindow(previous.at, timezone)}.`
            : "This is the first scheduled run of this automation.",
          definition.data_access.scopes.length
            ? `Approved data access: ${definition.data_access.scopes.join(", ")}, at most ${definition.data_access.history_days} days of history. Query it with your data tools as needed.`
            : "This automation has no personal-data access."],
        metadata: { scheduled_for: delivery.scheduledFor.toISOString(), schedule_timezone: timezone,
          previous_scheduled_for: previous?.at?.toISOString() ?? null },
      };
    }
    if (!delivery.domainEventId) return "automation_trigger_mismatch";
    const [contact] = await tx.select({ id: contacts.id, revisionId: evidence.id, observedAt: evidence.observedAt,
      sourceId: sources.id, publishedAt: events.publishedAt }).from(events)
      .innerJoin(evidence, and(eq(evidence.id, events.revisionId), eq(evidence.createdByUserId, owner)))
      .innerJoin(contacts, and(eq(contacts.id, evidence.contactId), eq(contacts.createdByUserId, owner)))
      .innerJoin(sources, and(eq(sources.id, contacts.sourceId), eq(sources.createdByUserId, owner)))
      .innerJoin(epochs, and(eq(epochs.id, sources.epochId), eq(epochs.createdByUserId, owner), isNull(epochs.revokedAt)))
      .innerJoin(installations, and(eq(installations.id, epochs.installationId), eq(installations.createdByUserId, owner), isNull(installations.revokedAt)))
      .where(and(eq(events.id, delivery.domainEventId), eq(events.createdByUserId, owner), eq(contacts.visible, true),
        sql`${evidence.observedAt} >= clock_timestamp() - ${definition.data_access.history_days} * interval '1 day'`)).limit(1);
    if (!contact) return "contact_evidence_unavailable";
    const zone = await phoneTimeZone(tx, owner, contact.publishedAt);
    return {
      event: `A contact was newly observed at ${localTime(contact.observedAt, zone, now)}.`,
      reference: [timeZoneLine(zone), "Newly observed means first seen on the phone, not necessarily created or met.",
        `Contact ID: ${contact.id}. Contact revision ID: ${contact.revisionId}.`,
        "Query the available evidence now, label location uncertainty, and don't repeat completed actions when the evidence is enriched."],
      metadata: { domain_event_id: delivery.domainEventId, contact_id: contact.id,
        contact_revision_id: contact.revisionId, source_id: contact.sourceId },
    };
  }
}
