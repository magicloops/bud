import { invocationTimingTransaction } from "../agent/invocation-timing.js";
import { DataRequestError } from "./contracts.js";
import { automationModelResolver, type AutomationModelResolution } from "./automation-model.js";
import { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { InvocationRepository } from "../agent/invocation-repository.js";
import { automationTable as rules, automationRevisionTable as revisions, automationDeliveryTable as deliveries,
  dataOwnerStateTable as owners, agentDataGrantTable as grants, dataDomainEventTable as events,
  contactRevisionTable as evidence, contactTable as contacts, contactSourceTable as sources,
  dataCollectionEpochTable as epochs, dataInstallationTable as installations, healthWorkoutTable as workouts,
  locationVisitTable as locationVisits, locationVisitNameTable as visitNames, placeTable as placeRows,
  placePresenceEventTable as presenceEvents,
  threadTable as threads, budTable as buds, agentInvocationTable as invocationRows, messageTable as messages } from "../db/schema.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import { automationDefinitionSchema, AUTOMATION_LIMITS, grantCoversDefinition, parseAutomationInput, withinHistory,
  type AutomationDefinition } from "./automation-contracts.js";
import { describeLocalWindow } from "./automation-schedule.js";
import { presenceReading } from "./place-presence.js";
import { admissionText, duration, lateReport, localTime, phoneTimeZone, timeZoneLine, timelineAdmissionText } from "./automation-trigger-text.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Delivery = typeof deliveries.$inferSelect;
type Prepared = { delivery: Delivery; definition: AutomationDefinition; trigger: TriggerInput; modelResolution: AutomationModelResolution;
  grantVersion: number };
type TriggerInput = { event: string; at: Date; reference: string[]; metadata: Record<string, unknown> };

/** Location triggers for a conversation form one timeline (Phase 7.3). */
const LOCATION_TRIGGERS = new Set(["place.arrived", "place.departed", "visit.ended"]);
const isLocationTrigger = (definition: AutomationDefinition) => LOCATION_TRIGGERS.has(definition.event_type ?? "");
/** The conversation a run goes to; rules that open a new conversation per run group on their own. */
const groupKey = (definition: AutomationDefinition, automationId: string) =>
  definition.target.mode === "existing_thread" ? `thread:${definition.target.thread_id}` : `rule:${automationId}`;
/** At most this many deliveries share one run. */
const GROUP_LIMIT = 20;
/** A run in these states hasn't read its input yet (its start takes the owner lock first). */
const UNSTARTED_INVOCATION_STATES = ["pending", "retry_wait", "leased"] as const;
const ACTIVE_INVOCATION_STATES = ["pending", "retry_wait", "leased", "waiting_for_bud", "waiting_for_model", "running",
  "waiting_for_user"] as const;
const joinNames = (names: string[]) => names.length <= 1 ? names.join("")
  : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

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
      const first = await this.prepare(tx, owner, delivery);
      if (!("trigger" in first)) return true;
      let group = [first];
      if (isLocationTrigger(first.definition) && first.definition.target.mode === "existing_thread") {
        // A straggler (older than an event already told to this conversation) never starts a run:
        // it joins one that hasn't started, or becomes a quiet entry in the conversation.
        const threadId = first.definition.target.thread_id;
        const newest = await this.newestToldAt(tx, owner, threadId);
        if (newest && first.trigger.at < newest) {
          const run = await this.unstartedRun(tx, owner, threadId, first);
          if (run) await this.joinRun(tx, owner, run, first);
          else await this.fold(tx, owner, threadId, first);
          return true;
        }
      }
      if (isLocationTrigger(first.definition)) {
        // One location run at a time per conversation: what arrives meanwhile forms the next one.
        if (await this.locationRunActive(tx, owner, groupKey(first.definition, delivery.automationId))) {
          await this.wait(tx, delivery, "location_run_in_progress", 5);
          return true;
        }
        group = [first, ...await this.locationSiblings(tx, owner, first)];
        group.sort((a, b) => a.trigger.at.getTime() - b.trigger.at.getTime());
      }
      const { definition, modelResolution, grantVersion } = first;
      let threadId: string;
      if (definition.target.mode === "existing_thread") threadId = definition.target.thread_id;
      else {
        const [thread] = await tx.insert(threads).values({ budId: definition.bud_id, title: definition.name,
          modelId: modelResolution.model, reasoningEffort: modelResolution.reasoning_effort, createdByUserId: owner }).returning();
        threadId = thread.threadId;
      }
      const single = group.length === 1;
      const ruleNames = [...new Map(group.map(item => [item.delivery.automationId, item.definition.name])).values()];
      const admitted = await this.invocations.admitInTransaction(tx, { owner, threadId, origin: "automation",
        idempotencyKey: "automation-delivery:" + delivery.id, model: modelResolution.model, reasoningEffort: modelResolution.reasoning_effort,
        latestStartAt: new Date(Math.min(...group.map(item => item.delivery.latestStartAt.getTime()))),
        text: single
          ? admissionText({ event: first.trigger.event, instruction: definition.instruction, automationName: definition.name,
            automationId: delivery.automationId, reference: first.trigger.reference })
          : timelineAdmissionText(group.map(item => ({ event: item.trigger.event, instruction: item.definition.instruction,
            automationName: item.definition.name, automationId: item.delivery.automationId, reference: item.trigger.reference }))),
        metadata: { model_resolution: modelResolution, automation_id: delivery.automationId,
          automation_name: single ? definition.name : joinNames(ruleNames), automation_revision: delivery.revision,
          delivery_id: delivery.id, ...first.trigger.metadata, grant_version: grantVersion,
          ...(single ? {} : { automation_ids: [...new Set(group.map(item => item.delivery.automationId))], automation_names: ruleNames,
            delivery_ids: group.map(item => item.delivery.id), domain_event_ids: group.map(item => item.delivery.domainEventId) }) },
      });
      for (const item of group) {
        await tx.update(deliveries).set({ status: "admitted", invocationId: admitted.invocation.id,
          outcomeCode: null, updatedAt: sql`clock_timestamp()` }).where(eq(deliveries.id, item.delivery.id));
      }
      return true;
    });
  }

  /**
   * One delivery's admission checks: deadline, rule, grant, Bud and target, trigger evidence,
   * pause, daily limits and model. A failure finishes or defers the delivery and returns its
   * outcome; otherwise everything needed to admit it.
   */
  private async prepare(tx: Transaction, owner: string, delivery: Delivery) {
    const finish = async (status: "failed" | "expired", outcomeCode: string) => {
      await tx.update(deliveries).set({ status, outcomeCode, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(deliveries.id, delivery.id), eq(deliveries.createdByUserId, owner)));
      return { outcome: outcomeCode };
    };
    const wait = async (outcomeCode: string) => { await this.wait(tx, delivery, outcomeCode, 15); return { outcome: outcomeCode }; };
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
    return { delivery, definition, trigger, modelResolution, grantVersion: grant?.version ?? 0 };
  }

  private async wait(tx: Transaction, delivery: Delivery, outcomeCode: string, seconds: number) {
    await tx.update(deliveries).set({ outcomeCode, nextAttemptAt: sql`clock_timestamp() + ${seconds} * interval '1 second'`,
      updatedAt: sql`clock_timestamp()` }).where(eq(deliveries.id, delivery.id));
  }

  /** The newest location event time among runs already admitted to this conversation. */
  private async newestToldAt(tx: Transaction, owner: string, threadId: string) {
    const result = await tx.execute<{ at: string | null }>(sql`
      select max(coalesce(pe.occurred_at, v.departure_at)) as at
      from automation_delivery d
      join agent_invocation i on i.id = d.invocation_id and i.created_by_user_id = ${owner}
      join data_domain_event e on e.id = d.domain_event_id and e.created_by_user_id = ${owner}
      left join place_presence_event pe on pe.id = e.presence_event_id and pe.created_by_user_id = ${owner}
      left join location_visit v on v.id = e.visit_id and e.event_type = 'visit.ended' and v.created_by_user_id = ${owner}
      where d.created_by_user_id = ${owner} and d.status = 'admitted' and i.thread_id = ${threadId}
        and e.event_type in ('place.arrived', 'place.departed', 'visit.ended')`);
    const at = result.rows[0]?.at;
    return at ? new Date(at) : null;
  }

  /** A location run in this conversation that hasn't started yet and can take this delivery
   * (the same Bud, model and data access). The owner lock keeps it from starting meanwhile. */
  private async unstartedRun(tx: Transaction, owner: string, threadId: string, item: Prepared) {
    const runs = await tx.select({ invocation: invocationRows, definition: revisions.definition }).from(deliveries)
      .innerJoin(invocationRows, and(eq(invocationRows.id, deliveries.invocationId), eq(invocationRows.createdByUserId, owner)))
      .innerJoin(revisions, and(eq(revisions.automationId, deliveries.automationId), eq(revisions.revision, deliveries.revision),
        eq(revisions.createdByUserId, owner)))
      .where(and(eq(deliveries.createdByUserId, owner), eq(deliveries.status, "admitted"), eq(invocationRows.threadId, threadId),
        inArray(invocationRows.status, UNSTARTED_INVOCATION_STATES)));
    return runs.find(run => {
      const definition = parseAutomationInput(automationDefinitionSchema, run.definition);
      return isLocationTrigger(definition) && definition.bud_id === item.definition.bud_id
        && run.invocation.model === item.modelResolution.model && run.invocation.reasoningEffort === item.modelResolution.reasoning_effort
        && JSON.stringify(definition.data_access) === JSON.stringify(item.definition.data_access);
    })?.invocation ?? null;
  }

  /** Adds a straggler to a run that hasn't started, rewriting its input as the timeline. */
  private async joinRun(tx: Transaction, owner: string, run: typeof invocationRows.$inferSelect, item: Prepared) {
    await tx.update(deliveries).set({ status: "admitted", invocationId: run.id, outcomeCode: "joined_unstarted_run",
      updatedAt: sql`clock_timestamp()` }).where(eq(deliveries.id, item.delivery.id));
    const members = await tx.select().from(deliveries).where(and(eq(deliveries.createdByUserId, owner),
      eq(deliveries.invocationId, run.id), eq(deliveries.status, "admitted")));
    const items: Array<{ event: string; at: Date; instruction: string; automationName: string; automationId: string; reference: string[];
      deliveryId: string; domainEventId: string | null }> = [];
    const [grant] = await tx.select().from(grants).where(eq(grants.createdByUserId, owner));
    for (const member of members) {
      const [revision] = await tx.select({ definition: revisions.definition }).from(revisions).where(and(
        eq(revisions.automationId, member.automationId), eq(revisions.revision, member.revision), eq(revisions.createdByUserId, owner))).limit(1);
      if (!revision) continue;
      const definition = parseAutomationInput(automationDefinitionSchema, revision.definition);
      const trigger = await this.triggerInput(tx, owner, member, definition, grant?.healthTypes ?? [], grant?.historyDays ?? 0);
      if (typeof trigger === "string") continue;
      items.push({ event: trigger.event, at: trigger.at, instruction: definition.instruction, automationName: definition.name,
        automationId: member.automationId, reference: trigger.reference, deliveryId: member.id, domainEventId: member.domainEventId });
    }
    items.sort((a, b) => a.at.getTime() - b.at.getTime());
    const names = [...new Map(items.map(entry => [entry.automationId, entry.automationName])).values()];
    const [input] = await tx.select().from(messages).where(and(eq(messages.messageId, run.inputMessageId), eq(messages.createdByUserId, owner)));
    await tx.update(messages).set({ content: timelineAdmissionText(items), metadata: { ...input.metadata,
      automation_name: joinNames(names), automation_names: names, automation_ids: [...new Set(items.map(entry => entry.automationId))],
      delivery_ids: items.map(entry => entry.deliveryId), domain_event_ids: items.map(entry => entry.domainEventId) } })
      .where(and(eq(messages.messageId, run.inputMessageId), eq(messages.createdByUserId, owner)));
  }

  /** A straggler with no run to join: a quiet entry in the conversation (no run, no push). The
   * agent sees it in the conversation history, in order, on its next run. */
  private async fold(tx: Transaction, owner: string, threadId: string, item: Prepared) {
    const [thread] = await tx.select({ tenantId: threads.tenantId }).from(threads)
      .where(and(eq(threads.threadId, threadId), eq(threads.createdByUserId, owner))).limit(1);
    const [entry] = await tx.insert(messages).values({ clientId: generateMessageClientId(), threadId, role: "system", displayRole: "Automation",
      content: `Earlier: ${item.trigger.event}`, createdByUserId: owner, tenantId: thread?.tenantId ?? null,
      metadata: { origin: "automation", timeline_entry: true, automation_id: item.delivery.automationId, automation_name: item.definition.name,
        automation_revision: item.delivery.revision, delivery_id: item.delivery.id, domain_event_id: item.delivery.domainEventId,
        ...item.trigger.metadata } }).returning();
    await tx.update(threads).set({ messageCount: sql`${threads.messageCount} + 1` }).where(eq(threads.threadId, threadId));
    await tx.update(deliveries).set({ status: "folded", timelineMessageId: entry.messageId, outcomeCode: "older_than_last_update",
      updatedAt: sql`clock_timestamp()` }).where(eq(deliveries.id, item.delivery.id));
  }

  /** Whether a location run for this conversation is still queued or running. */
  private async locationRunActive(tx: Transaction, owner: string, key: string) {
    const active = await tx.select({ definition: revisions.definition, automationId: deliveries.automationId }).from(deliveries)
      .innerJoin(invocationRows, and(eq(invocationRows.id, deliveries.invocationId), eq(invocationRows.createdByUserId, owner)))
      .innerJoin(revisions, and(eq(revisions.automationId, deliveries.automationId), eq(revisions.revision, deliveries.revision),
        eq(revisions.createdByUserId, owner)))
      .where(and(eq(deliveries.createdByUserId, owner), eq(deliveries.status, "admitted"),
        inArray(invocationRows.status, ACTIVE_INVOCATION_STATES)));
    return active.some(row => {
      const definition = parseAutomationInput(automationDefinitionSchema, row.definition);
      return isLocationTrigger(definition) && groupKey(definition, row.automationId) === key;
    });
  }

  /**
   * The other location deliveries already due for the same conversation that can share the run:
   * the same Bud, target, resolved model and data access (so the run's model and data ceiling
   * are those of every rule in it). Each passes its own admission checks; one that doesn't is
   * finished or deferred on its own and left out.
   */
  private async locationSiblings(tx: Transaction, owner: string, first: Prepared) {
    const pending = await tx.select().from(deliveries).where(and(eq(deliveries.createdByUserId, owner),
      eq(deliveries.status, "pending"), sql`${deliveries.nextAttemptAt} <= clock_timestamp()`, ne(deliveries.id, first.delivery.id)))
      .orderBy(asc(deliveries.nextAttemptAt), asc(deliveries.id)).limit(GROUP_LIMIT).for("update");
    const siblings: Prepared[] = [];
    for (const delivery of pending) {
      const [revision] = await tx.select({ definition: revisions.definition }).from(revisions).where(and(
        eq(revisions.automationId, delivery.automationId), eq(revisions.revision, delivery.revision), eq(revisions.createdByUserId, owner))).limit(1);
      if (!revision) continue;
      const definition = parseAutomationInput(automationDefinitionSchema, revision.definition);
      if (!isLocationTrigger(definition)
        || groupKey(definition, delivery.automationId) !== groupKey(first.definition, first.delivery.automationId)) continue;
      const prepared = await this.prepare(tx, owner, delivery);
      if (!("trigger" in prepared)) continue;
      if (prepared.definition.bud_id !== first.definition.bud_id
        || prepared.modelResolution.model !== first.modelResolution.model
        || prepared.modelResolution.reasoning_effort !== first.modelResolution.reasoning_effort
        || JSON.stringify(prepared.definition.data_access) !== JSON.stringify(first.definition.data_access)) continue;
      siblings.push(prepared);
    }
    return siblings;
  }

  /** The trigger's event line (plain language, local time), reference details and metadata, or a
   * failure outcome code. */
  private async triggerInput(tx: Transaction, owner: string, delivery: Delivery, definition: AutomationDefinition,
    healthTypes: string[], grantHistoryDays: number): Promise<TriggerInput | string> {
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
        event, at: row.change.occurredAt,
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
        at: row.visit.departureAt!,
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
        at: workout.endAt,
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
        at: delivery.scheduledFor,
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
      at: contact.observedAt,
      event: `A contact was newly observed at ${localTime(contact.observedAt, zone, now)}.`,
      reference: [timeZoneLine(zone), "Newly observed means first seen on the phone, not necessarily created or met.",
        `Contact ID: ${contact.id}. Contact revision ID: ${contact.revisionId}.`,
        "Query the available evidence now, label location uncertainty, and don't repeat completed actions when the evidence is enriched."],
      metadata: { domain_event_id: delivery.domainEventId, contact_id: contact.id,
        contact_revision_id: contact.revisionId, source_id: contact.sourceId },
    };
  }
}
