import { and, asc, eq, ne, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { dataOwnerStateTable as owners, dataDomainEventTable as events,
  contactRevisionTable as contactRevisions, contactTable as contacts,
  automationTable as rules, automationRevisionTable as revisions, automationDeliveryTable as deliveries,
  automationBootstrapTable as bootstraps, automationBootstrapMemberTable as members } from "../db/schema.js";
import { automationDefinitionSchema, AUTOMATION_LIMITS, parseAutomationInput } from "./automation-contracts.js";

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
      if (event.publicationSequence !== null && event.eventType === "contact.added") {
        const [contact] = await tx.select({ id: contacts.id, sourceId: contacts.sourceId }).from(contactRevisions)
          .innerJoin(contacts, and(eq(contacts.id, contactRevisions.contactId), eq(contacts.createdByUserId, event.createdByUserId)))
          .where(and(eq(contactRevisions.id, event.revisionId), eq(contactRevisions.createdByUserId, event.createdByUserId))).limit(1);
        if (!contact) throw new Error("contact_event_evidence_missing");
        // Use the revision in force at publication, even if matching was delayed
        // until after another activation. Draft edits alone cannot affect it.
        const applicable = await tx.select({ revision: revisions }).from(revisions)
          .innerJoin(rules, and(eq(rules.id, revisions.automationId), eq(rules.createdByUserId, revisions.createdByUserId)))
          .where(and(eq(revisions.createdByUserId, event.createdByUserId), ne(rules.state, "deleted"),
            sql`${revisions.publicationBoundary} < ${event.publicationSequence}`,
            sql`not exists (select 1 from automation_revision newer where newer.automation_id = ${revisions.automationId}
              and newer.created_by_user_id = ${event.createdByUserId} and newer.revision > ${revisions.revision}
              and newer.publication_boundary < ${event.publicationSequence})`))
          .limit(AUTOMATION_LIMITS.rules_per_owner + 1);
        if (applicable.length > AUTOMATION_LIMITS.rules_per_owner) throw new Error("automation_rule_limit_exceeded");
        for (const { revision } of applicable) {
          const definition = parseAutomationInput(automationDefinitionSchema, revision.definition);
          const matches = !definition.sources.source_ids.length || definition.sources.source_ids.includes(contact.sourceId);
          const [captured] = await tx.select({ id: bootstraps.id }).from(bootstraps)
            .innerJoin(members, and(eq(members.bootstrapId, bootstraps.id), eq(members.createdByUserId, event.createdByUserId)))
            .innerJoin(contactRevisions, and(eq(contactRevisions.id, members.contactRevisionId), eq(contactRevisions.createdByUserId, event.createdByUserId)))
            .where(and(eq(bootstraps.createdByUserId, event.createdByUserId), eq(bootstraps.automationId, revision.automationId),
              eq(bootstraps.revision, revision.revision), eq(contactRevisions.contactId, contact.id),
              sql`${bootstraps.publicationBoundary} >= ${event.publicationSequence}`)).limit(1);
          const deadline = new Date(event.publishedAt.getTime() + definition.latest_start_seconds * 1000);
          const [clock] = await tx.execute<{ expired: boolean }>(sql`select clock_timestamp() >= ${deadline.toISOString()}::timestamptz as expired`).then(result => result.rows);
          await tx.insert(deliveries).values({ id: ulid(), automationId: revision.automationId, revision: revision.revision,
            domainEventId: event.id, latestStartAt: deadline, createdByUserId: event.createdByUserId,
            status: !matches || captured ? "suppressed" : clock.expired ? "expired" : "pending",
            outcomeCode: !matches ? "source_filter_mismatch" : captured ? "bootstrap_snapshot_selected" : clock.expired ? "latest_start_elapsed" : null,
          }).onConflictDoNothing();
        }
      }
      await tx.update(events).set({ status: "matched" }).where(and(eq(events.id, event.id), eq(events.createdByUserId, event.createdByUserId)));
      return true;
    });
  }
}
