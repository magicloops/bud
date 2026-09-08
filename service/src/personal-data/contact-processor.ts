import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { dataOwnerStateTable as owners, dataEventTable as events, dataProcessingJobTable as jobs, contactSourceTable as sources, contactScanTable as scans, contactScanRecordTable as records, contactTable as contacts, contactRevisionTable as revisions, dataDomainEventTable as domains, locationObservationTable as locations } from "../db/schema.js";
import { parseLocationPayload, LOCATION_TYPES } from "./location.js";
import { canonicalJson } from "./contracts.js";
import { parseContactPayload, verifyContactScan, type ContactManifest, type ContactRecord } from "./contacts.js";

const CONTACT_TYPES = ["contacts.record.v1", "contacts.scan.v1", "contacts.repair_record.v1", "contacts.repair_scan.v1",
  "contacts.record.v2", "contacts.scan.v2", "contacts.repair_record.v2", "contacts.repair_scan.v2"];
const PENDING_STATES = ["pending", "repair_pending", "v2_pending", "v2_repair_pending"];
const pendingState = (payload: ContactRecord | ContactManifest) =>
  `${payload.payload_version === 2 ? "v2_" : ""}${payload.repair ? "repair_pending" : "pending"}`;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** DB transactions are the claim: process death rolls back both work and receipt.
 * No network/model operations occur while a publication lock is held. */
export class ContactProcessor {
  constructor(private readonly database: Database = db) {}

  /** Recover observations ACKed by older processors. Historical method name is
   * retained for the lifecycle interface; recovery also includes source repair. */
  async requeueSupportedLocations(ownerFilter?: string): Promise<boolean> {
    const supported = and(eq(jobs.status, "unsupported"), eq(events.schemaVersion, 1),
      inArray(events.eventType, [...LOCATION_TYPES, ...CONTACT_TYPES]), ownerFilter ? eq(jobs.createdByUserId, ownerFilter) : undefined);
    const [candidate] = await this.database.select({ owner: jobs.createdByUserId }).from(jobs)
      .innerJoin(events, and(eq(events.id, jobs.eventId), eq(events.createdByUserId, jobs.createdByUserId)))
      .where(supported).orderBy(jobs.id).limit(1);
    if (!candidate) return false;
    return this.database.transaction(async tx => {
      await tx.select().from(owners).where(eq(owners.createdByUserId, candidate.owner)).for("update");
      const rows = await tx.select({ id: jobs.id }).from(jobs)
        .innerJoin(events, and(eq(events.id, jobs.eventId), eq(events.createdByUserId, jobs.createdByUserId)))
        .where(and(supported, eq(jobs.createdByUserId, candidate.owner))).orderBy(jobs.id).limit(100);
      if (!rows.length) return false;
      await tx.update(jobs).set({ status: "pending", errorCode: null, attemptCount: 0, nextAttemptAt: new Date() })
        .where(and(eq(jobs.createdByUserId, candidate.owner), eq(jobs.status, "unsupported"), inArray(jobs.id, rows.map(row => row.id))));
      return true;
    });
  }

  async processNext(ownerFilter?: string): Promise<boolean> {
    const [candidate] = await this.database.select({ owner: jobs.createdByUserId }).from(jobs)
      .where(and(eq(jobs.status, "pending"), lte(jobs.nextAttemptAt, new Date()), ownerFilter ? eq(jobs.createdByUserId, ownerFilter) : undefined))
      .orderBy(jobs.nextAttemptAt, jobs.id).limit(1);
    if (!candidate) return false;
    let failedJob: string | undefined;
    try { return await this.database.transaction(async tx => {
      // All publication/rule/bootstrap work uses this same owner lock first.
      await tx.select().from(owners).where(eq(owners.createdByUserId, candidate.owner)).for("update");
      const [job] = await tx.select().from(jobs).where(and(eq(jobs.createdByUserId, candidate.owner), eq(jobs.status, "pending"), lte(jobs.nextAttemptAt, new Date())))
        .orderBy(jobs.nextAttemptAt, jobs.id).limit(1).for("update");
      if (!job) return false;
      failedJob = job.id;
      await tx.execute(sql`set local statement_timeout = '30s'`);
      const [event] = await tx.select().from(events).where(and(eq(events.id, job.eventId), eq(events.createdByUserId, candidate.owner)));
      if (event.schemaVersion === 1 && LOCATION_TYPES.includes(event.eventType)) {
        const location = parseLocationPayload(event.eventType, event.rawEnvelope.payload);
        if (location) await tx.insert(locations).values({ id: ulid(), rawEventId: event.id, epochId: event.epochId,
          ...location, occurredAt: event.occurredAt, receivedAt: event.receivedAt, createdByUserId: candidate.owner }).onConflictDoNothing();
        await tx.update(jobs).set({ status: location ? "processed" : "invalid", errorCode: location ? null : "invalid_location", attemptCount: job.attemptCount + 1 }).where(eq(jobs.id, job.id));
        return true;
      }
      const payload = event.schemaVersion === 1 ? parseContactPayload(event.eventType, event.rawEnvelope.payload, { allowExpanded: true }) : null;
      if (!payload) {
        const unsupported = !CONTACT_TYPES.includes(event.eventType) || event.schemaVersion !== 1;
        await tx.update(jobs).set({ status: unsupported ? "unsupported" : "invalid", errorCode: unsupported ? "unsupported_processor" : "invalid_contact_payload", attemptCount: job.attemptCount + 1 }).where(eq(jobs.id, job.id));
        return true;
      }
      await tx.insert(sources).values({ id: ulid(), epochId: event.epochId, storeId: payload.contact_store_id, createdByUserId: candidate.owner }).onConflictDoNothing();
      const [source] = await tx.select().from(sources).where(and(eq(sources.epochId, event.epochId), eq(sources.storeId, payload.contact_store_id), eq(sources.createdByUserId, candidate.owner)));
      if (payload.generation <= source.generation) {
        const [repair] = await tx.select({ id: scans.id }).from(scans).where(and(eq(scans.sourceId, source.id),
          eq(scans.createdByUserId, candidate.owner), eq(scans.status, "published"),
          sql`${scans.manifest}->>'repair' = 'true'`, sql`${scans.generation} >= ${payload.generation}`)).limit(1);
        if (repair) {
          await tx.update(jobs).set({ status: "superseded", errorCode: "source_repaired" }).where(eq(jobs.id, job.id));
          return true;
        }
      }
      await tx.insert(scans).values({ id: ulid(), sourceId: source.id, scanId: payload.scan_id, generation: payload.generation,
        status: pendingState(payload), createdByUserId: candidate.owner }).onConflictDoNothing();
      const [scan] = await tx.select().from(scans).where(and(eq(scans.sourceId, source.id), eq(scans.generation, payload.generation), eq(scans.createdByUserId, candidate.owner)));
      if (scan.scanId !== payload.scan_id || (payload.kind === "manifest" && scan.manifest && canonicalJson(scan.manifest) !== canonicalJson(payload))) {
        await tx.update(scans).set({ status: "invalid", errorCode: "scan_identity_conflict" }).where(eq(scans.id, scan.id));
        await tx.update(jobs).set({ status: "invalid", errorCode: "scan_identity_conflict" }).where(eq(jobs.id, job.id));
        return true;
      }
      if (scan.status !== (pendingState(payload))) {
        await tx.update(jobs).set({ status: "invalid", errorCode: "scan_already_closed" }).where(eq(jobs.id, job.id));
        return true;
      }
      if (payload.kind === "manifest") {
        await tx.update(scans).set({ manifest: payload }).where(eq(scans.id, scan.id));
      } else {
        await tx.insert(records).values({ id: ulid(), scanId: scan.id, rawEventId: event.id, clientEventId: event.eventId, payload, createdByUserId: candidate.owner }).onConflictDoNothing();
      }
      await tx.update(jobs).set({ status: "processed", attemptCount: job.attemptCount + 1, errorCode: null }).where(eq(jobs.id, job.id));
      return true;
    }); } catch (error) {
      if (failedJob) {
        await this.database.update(jobs).set({
          attemptCount: sql`${jobs.attemptCount} + 1`,
          status: sql`case when ${jobs.attemptCount} >= 9 then 'failed' else 'pending' end`,
          nextAttemptAt: sql`now() + interval '30 seconds'`, errorCode: "processing_failed",
        }).where(and(eq(jobs.id, failedJob), eq(jobs.createdByUserId, candidate.owner), eq(jobs.status, "pending")));
      }
      throw error;
    }
  }

  /** Separate publication pass also drains chains after all raw jobs are finished. */
  async publishNext(rebuild = false, ownerFilter?: string): Promise<boolean> {
    const candidates = await this.database.select({ scan: scans, source: sources }).from(scans)
      .innerJoin(sources, and(eq(scans.sourceId, sources.id), eq(scans.createdByUserId, sources.createdByUserId)))
      .where(and(inArray(scans.status, PENDING_STATES), sql`${scans.manifest} is not null`,
        sql`(${scans.generation} = ${sources.generation} + 1 or (${scans.manifest}->>'repair' = 'true' and ${scans.generation} > ${sources.generation}))`, ownerFilter ? eq(scans.createdByUserId, ownerFilter) : undefined,
        sql`(select count(*) from contact_scan_record r where r.scan_id = ${scans.id} and r.created_by_user_id = ${scans.createdByUserId}) >= (${scans.manifest}->>'expected_event_count')::integer`))
      .orderBy(scans.createdAt, scans.id).limit(100);
    for (const candidate of candidates) {
      const published = await this.database.transaction(async tx => {
        const owner = candidate.scan.createdByUserId;
        await tx.select().from(owners).where(eq(owners.createdByUserId, owner)).for("update");
        const [source] = await tx.select().from(sources).where(and(eq(sources.id, candidate.source.id), eq(sources.createdByUserId, owner)));
        const [scan] = await tx.select().from(scans).where(and(eq(scans.id, candidate.scan.id), eq(scans.createdByUserId, owner)));
        if (!PENDING_STATES.includes(scan.status) || !scan.manifest) return false;
        const manifest = scan.manifest as ContactManifest;
        if (manifest.repair ? source.generation >= scan.generation : source.generation + 1 !== scan.generation) return false;
        const rows = await tx.select().from(records).where(and(eq(records.scanId, scan.id), eq(records.createdByUserId, owner))).limit(20_001);
        if (rows.length < manifest.expected_event_count) return false;
        if (!verifyContactScan(manifest, rows.map(row => ({ eventID: row.clientEventId, payload: row.payload as ContactRecord })))
          || (!manifest.repair && (source.observedAt?.getTime() ?? null) !== (manifest.previous_observed_at ? Date.parse(manifest.previous_observed_at) : null))) {
          await tx.update(scans).set({ status: "invalid", errorCode: "scan_manifest_mismatch" }).where(eq(scans.id, scan.id));
          return true;
        }
        for (const row of rows) await this.publishRecord(tx, owner, source.id, scan.id, manifest, row.payload as ContactRecord, rebuild);
        if (manifest.repair) {
          // Records in a repair are the complete permitted set. Preserve IDs and
          // historical revisions for prior contacts omitted from that set.
          const absent = await tx.select().from(contacts).where(and(eq(contacts.createdByUserId, owner),
            eq(contacts.sourceId, source.id), eq(contacts.visible, true), sql`${contacts.generation} < ${scan.generation}`));
          for (const contact of absent) await this.publishRecord(tx, owner, source.id, scan.id, manifest, {
            ...manifest, kind: "record", source_contact_id: contact.sourceContactId,
            change: "no_longer_visible", newly_observed: false,
          }, true);
          await tx.update(scans).set({ status: "superseded", errorCode: "source_repaired" }).where(and(
            eq(scans.createdByUserId, owner), eq(scans.sourceId, source.id), sql`${scans.generation} < ${scan.generation}`,
            inArray(scans.status, [...PENDING_STATES, "invalid"])));
        }
        await tx.update(sources).set({ generation: scan.generation, observedAt: new Date(manifest.observed_at) }).where(and(eq(sources.id, source.id), eq(sources.createdByUserId, owner)));
        await tx.update(scans).set({ status: "published", publishedAt: new Date(), errorCode: null }).where(and(eq(scans.id, scan.id), eq(scans.createdByUserId, owner)));
        return true;
      });
      if (published) return true;
    }
    return false;
  }

  private async publishRecord(tx: Transaction, owner: string, sourceId: string, scanId: string, manifest: ContactManifest, payload: ContactRecord, rebuild: boolean) {
    const [prior] = await tx.select().from(contacts).where(and(eq(contacts.sourceId, sourceId), eq(contacts.sourceContactId, payload.source_contact_id), eq(contacts.createdByUserId, owner)));
    const id = prior?.id ?? ulid();
    const visible = payload.change === "upsert";
    const fields = payload.contact ?? prior?.fields ?? {};
    const observedAt = new Date(manifest.observed_at);
    const values = { fields, visible, observedAt, generation: manifest.generation };
    if (prior) await tx.update(contacts).set(values).where(and(eq(contacts.id, id), eq(contacts.createdByUserId, owner)));
    else await tx.insert(contacts).values({ id, sourceId, sourceContactId: payload.source_contact_id, ...values, firstObservedAt: observedAt, createdByUserId: owner });
    const revisionId = ulid();
    await tx.insert(revisions).values({ id: revisionId, contactId: id, scanId, fields, visible, observedAt, createdByUserId: owner });
    // Independently check prior state: a producer claim alone cannot mint an addition.
    if (!rebuild && !prior && visible && payload.newly_observed && manifest.scan_mode === "incremental") {
      // The caller already holds this owner's publication lock. Allocate within
      // that transaction, so activation can capture a commit-safe boundary.
      const [sequence] = await tx.update(owners).set({ publicationSequence: sql`${owners.publicationSequence} + 1` })
        .where(eq(owners.createdByUserId, owner)).returning({ value: owners.publicationSequence });
      await tx.insert(domains).values({ id: ulid(), revisionId, eventType: "contact.added",
        publicationSequence: sequence.value, createdByUserId: owner });
    }
  }
}
