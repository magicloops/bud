import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { dataOwnerStateTable as owners, dataDomainEventTable as events,
  contactRevisionTable as contactRevisions, contactTable as contacts,
  automationTable as rules, automationRevisionTable as revisions, automationDeliveryTable as deliveries,
  automationBootstrapTable as bootstraps, automationBootstrapMemberTable as members,
  healthWorkoutTable as workouts, healthSampleDeletionTable as healthDeletions,
  locationVisitTable as visits, placeTable as places } from "../db/schema.js";
import { visitAtPlace } from "./places.js";
import { automationDefinitionSchema, AUTOMATION_LIMITS, parseAutomationInput, type AutomationDefinition } from "./automation-contracts.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DomainEvent = typeof events.$inferSelect;
type Revision = typeof revisions.$inferSelect;
type Outcome = { status: "pending" | "suppressed" | "expired"; outcomeCode: string | null };

/** Only durable matching: no model calls, thread creation or terminal dispatch. */
export class AutomationMatcher {
  constructor(private readonly database: Database = db) {}

  async matchNext(ownerFilter?: string): Promise<boolean> {
    const [candidate] = await this.database.select({ owner: events.createdByUserId }).from(events)
      .where(and(eq(events.status, "pending"), ownerFilter ? eq(events.createdByUserId, ownerFilter) : undefined))
      .orderBy(asc(events.publishedAt), asc(events.id)).limit(1);
    if (!candidate) return false;
    return this.database.transaction(async tx => {
      // Same lock order as publication, rule edits, activation and bootstrap.
      const [owner] = await tx.select().from(owners).where(eq(owners.createdByUserId, candidate.owner))
        .for("update", { skipLocked: true });
      if (!owner) return false;
      const [event] = await tx.select().from(events).where(and(eq(events.createdByUserId, candidate.owner), eq(events.status, "pending")))
        .orderBy(asc(events.publicationSequence), asc(events.id)).limit(1).for("update");
      if (!event) return false;
      if (event.publicationSequence !== null) {
        if (event.eventType === "contact.added") await this.matchContact(tx, event);
        else if (event.eventType === "workout.completed") await this.matchWorkout(tx, event);
        else if (event.eventType === "place.arrived" || event.eventType === "place.departed") await this.matchPlace(tx, event);
        else if (event.eventType === "visit.ended") await this.matchVisitEnded(tx, event);
      }
      await tx.update(events).set({ status: "matched" }).where(and(eq(events.id, event.id), eq(events.createdByUserId, event.createdByUserId)));
      return true;
    });
  }

  /** Revisions in force at publication, even if matching was delayed until after
   * another activation. Draft edits alone cannot affect it. Only rules for this
   * event type see the event, not even as suppressed deliveries. */
  private async applicable(tx: Transaction, event: DomainEvent) {
    const rows = await tx.select({ revision: revisions }).from(revisions)
      .innerJoin(rules, and(eq(rules.id, revisions.automationId), eq(rules.createdByUserId, revisions.createdByUserId)))
      .where(and(eq(revisions.createdByUserId, event.createdByUserId), ne(rules.state, "deleted"),
        sql`${revisions.publicationBoundary} < ${event.publicationSequence}`,
        sql`not exists (select 1 from automation_revision newer where newer.automation_id = ${revisions.automationId}
          and newer.created_by_user_id = ${event.createdByUserId} and newer.revision > ${revisions.revision}
          and newer.publication_boundary < ${event.publicationSequence})`))
      .limit(AUTOMATION_LIMITS.rules_per_owner + 1);
    if (rows.length > AUTOMATION_LIMITS.rules_per_owner) throw new Error("automation_rule_limit_exceeded");
    return rows.map(({ revision }) => ({ revision, definition: parseAutomationInput(automationDefinitionSchema, revision.definition) }))
      .filter(({ definition }) => definition.event_type === event.eventType);
  }

  /** `notAfter` can only tighten the publication deadline. */
  private async insertDelivery(tx: Transaction, event: DomainEvent, revision: Revision, definition: AutomationDefinition,
    outcome: Outcome, notAfter?: Date) {
    const published = event.publishedAt.getTime() + definition.latest_start_seconds * 1000;
    const deadline = new Date(notAfter ? Math.min(published, notAfter.getTime()) : published);
    const [clock] = await tx.execute<{ expired: boolean }>(sql`select clock_timestamp() >= ${deadline.toISOString()}::timestamptz as expired`).then(result => result.rows);
    const status = outcome.status === "pending" && clock.expired ? "expired" : outcome.status;
    await tx.insert(deliveries).values({ id: ulid(), automationId: revision.automationId, revision: revision.revision,
      domainEventId: event.id, latestStartAt: deadline, createdByUserId: event.createdByUserId, status,
      outcomeCode: status === "expired" && outcome.status === "pending" ? "latest_start_elapsed" : outcome.outcomeCode,
    }).onConflictDoNothing();
  }

  private async matchContact(tx: Transaction, event: DomainEvent) {
    const [contact] = await tx.select({ id: contacts.id, sourceId: contacts.sourceId }).from(contactRevisions)
      .innerJoin(contacts, and(eq(contacts.id, contactRevisions.contactId), eq(contacts.createdByUserId, event.createdByUserId)))
      .where(and(eq(contactRevisions.id, event.revisionId!), eq(contactRevisions.createdByUserId, event.createdByUserId))).limit(1);
    if (!contact) throw new Error("contact_event_evidence_missing");
    for (const { revision, definition } of await this.applicable(tx, event)) {
      if (definition.event_type !== "contact.added") continue;
      const matches = !definition.sources.source_ids.length || definition.sources.source_ids.includes(contact.sourceId);
      const [captured] = await tx.select({ id: bootstraps.id }).from(bootstraps)
        .innerJoin(members, and(eq(members.bootstrapId, bootstraps.id), eq(members.createdByUserId, event.createdByUserId)))
        .innerJoin(contactRevisions, and(eq(contactRevisions.id, members.contactRevisionId), eq(contactRevisions.createdByUserId, event.createdByUserId)))
        .where(and(eq(bootstraps.createdByUserId, event.createdByUserId), eq(bootstraps.automationId, revision.automationId),
          eq(bootstraps.revision, revision.revision), eq(contactRevisions.contactId, contact.id),
          sql`${bootstraps.publicationBoundary} >= ${event.publicationSequence}`)).limit(1);
      await this.insertDelivery(tx, event, revision, definition, !matches ? { status: "suppressed", outcomeCode: "source_filter_mismatch" }
        : captured ? { status: "suppressed", outcomeCode: "bootstrap_snapshot_selected" } : { status: "pending", outcomeCode: null });
    }
  }

  private async visitWithAge(tx: Transaction, event: DomainEvent) {
    const [visit] = await tx.select({ visit: visits,
      arrivalAge: sql<number | null>`extract(epoch from clock_timestamp() - ${visits.arrivalAt})`.mapWith(Number),
      departureAge: sql<number | null>`extract(epoch from clock_timestamp() - ${visits.departureAt})`.mapWith(Number) }).from(visits)
      .where(and(eq(visits.id, event.visitId!), eq(visits.createdByUserId, event.createdByUserId))).limit(1);
    if (!visit) throw new Error("visit_event_evidence_missing");
    return visit;
  }

  /** Rules list the places they react to. Age runs from arrival (or departure), and the
   * maximum age also bounds the first start. A deleted place stops matching. */
  private async matchPlace(tx: Transaction, event: DomainEvent) {
    const { visit, arrivalAge, departureAge } = await this.visitWithAge(tx, event);
    const [place] = await tx.select({ deletedAt: places.deletedAt }).from(places)
      .where(and(eq(places.id, event.placeId!), eq(places.createdByUserId, event.createdByUserId))).limit(1);
    const arrived = event.eventType === "place.arrived";
    const at = arrived ? visit.arrivalAt ?? visit.startedAt : visit.departureAt!;
    const age = arrived ? arrivalAge ?? 0 : departureAge ?? 0;
    for (const { revision, definition } of await this.applicable(tx, event)) {
      if (definition.event_type !== "place.arrived" && definition.event_type !== "place.departed") continue;
      if (!definition.place_trigger.place_ids.includes(event.placeId!)) continue;
      await this.insertDelivery(tx, event, revision, definition,
        !place || place.deletedAt ? { status: "suppressed", outcomeCode: "place_deleted" }
        : age > definition.max_event_age_seconds ? { status: "suppressed", outcomeCode: "event_too_old" }
        : { status: "pending", outcomeCode: null },
        new Date(at.getTime() + definition.max_event_age_seconds * 1000));
    }
  }

  /** Optional place and minimum-duration filters; age runs from departure. */
  private async matchVisitEnded(tx: Transaction, event: DomainEvent) {
    const { visit, departureAge } = await this.visitWithAge(tx, event);
    const durationMinutes = visit.arrivalAt && visit.departureAt ? (visit.departureAt.getTime() - visit.arrivalAt.getTime()) / 60_000 : null;
    for (const { revision, definition } of await this.applicable(tx, event)) {
      if (definition.event_type !== "visit.ended") continue;
      const filter = definition.visit_filter;
      let atPlace = !filter.place_ids.length;
      if (!atPlace) {
        const listed = await tx.select().from(places).where(and(eq(places.createdByUserId, event.createdByUserId),
          inArray(places.id, filter.place_ids), isNull(places.deletedAt)));
        atPlace = listed.some(place => visitAtPlace(visit, place));
      }
      const long = filter.min_duration_minutes === 0 || (durationMinutes !== null && durationMinutes >= filter.min_duration_minutes);
      await this.insertDelivery(tx, event, revision, definition,
        !atPlace || !long ? { status: "suppressed", outcomeCode: "visit_filter_mismatch" }
        : (departureAge ?? 0) > definition.max_event_age_seconds ? { status: "suppressed", outcomeCode: "event_too_old" }
        : { status: "pending", outcomeCode: null },
        new Date(visit.departureAt!.getTime() + definition.max_event_age_seconds * 1000));
    }
  }

  /** Filters on activity and duration; suppresses deleted or stale workouts (age
   * measured from the workout's end, against the database clock). */
  private async matchWorkout(tx: Transaction, event: DomainEvent) {
    const [workout] = await tx.select({ hkUuid: workouts.hkUuid, activityType: workouts.activityType, durationS: workouts.durationS,
      endAt: workouts.endAt,
      stale: sql<number>`extract(epoch from clock_timestamp() - ${workouts.endAt})`.mapWith(Number) }).from(workouts)
      .where(and(eq(workouts.id, event.workoutId!), eq(workouts.createdByUserId, event.createdByUserId))).limit(1);
    if (!workout) throw new Error("workout_event_evidence_missing");
    // A separate lookup: column references inside selected sql are not table-qualified.
    const [deletion] = await tx.select({ id: healthDeletions.id }).from(healthDeletions).where(and(
      eq(healthDeletions.createdByUserId, event.createdByUserId), eq(healthDeletions.hkUuid, workout.hkUuid))).limit(1);
    const deleted = Boolean(deletion);
    for (const { revision, definition } of await this.applicable(tx, event)) {
      if (definition.event_type !== "workout.completed") continue;
      const filter = definition.workout_filter;
      const matches = (!filter.activity_types.length || filter.activity_types.includes(workout.activityType))
        && workout.durationS >= filter.min_duration_minutes * 60;
      await this.insertDelivery(tx, event, revision, definition,
        deleted ? { status: "suppressed", outcomeCode: "sample_deleted" }
        : !matches ? { status: "suppressed", outcomeCode: "workout_filter_mismatch" }
        : workout.stale > definition.max_event_age_seconds ? { status: "suppressed", outcomeCode: "event_too_old" }
        : { status: "pending", outcomeCode: null },
        // Maximum age also bounds the first start, not only matching.
        new Date(workout.endAt.getTime() + definition.max_event_age_seconds * 1000));
    }
  }
}
