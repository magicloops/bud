import { and, eq, inArray, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { dataOwnerStateTable as ownerState, dataInstallationTable as installation, dataCollectionEpochTable as epoch, dataEventTable as event, dataProcessingJobTable as job, contactScanTable as scan, contactSourceTable as contactSource } from "../db/schema.js";
import { DataRequestError, type BatchResult, type IngestContext, type ParsedBatch } from "./contracts.js";

export interface IngestRepository {
  persist(context: IngestContext, batch: ParsedBatch): Promise<BatchResult>;
  status(userId: string): Promise<unknown>;
}

export class PostgresIngestRepository implements IngestRepository {
  constructor(private readonly database: Database = db, private readonly maxStoredBytes = 1024 * 1024 * 1024) {}

  async persist(context: IngestContext, batch: ParsedBatch): Promise<BatchResult> {
    return this.database.transaction(async (tx) => {
      // Serializes owner quota accounting and source registration, independently
      // of future projection publication. No data is read outside owner filters.
      await tx.insert(ownerState).values({ createdByUserId: context.userId }).onConflictDoNothing();
      const [state] = await tx.select().from(ownerState).where(eq(ownerState.createdByUserId, context.userId)).for("update");
      const now = new Date();
      const inWindow = now.getTime() - state.requestWindowAt.getTime() < 60_000;
      if (inWindow && state.requestCount >= 60) throw new DataRequestError(429, "rate_limited", "Upload rate limit reached", true, 60);
      await tx.update(ownerState).set({ requestCount: inWindow ? state.requestCount + 1 : 1, requestWindowAt: inWindow ? state.requestWindowAt : now }).where(eq(ownerState.createdByUserId, context.userId));

      await tx.insert(installation).values({ id: ulid(), installationId: context.installationId, createdByUserId: context.userId }).onConflictDoNothing();
      const [source] = await tx.select().from(installation).where(and(eq(installation.installationId, context.installationId), eq(installation.createdByUserId, context.userId)));
      if (source.revokedAt) throw new DataRequestError(403, "installation_revoked", "Collection installation has been revoked");
      await tx.insert(epoch).values({ id: ulid(), installationId: source.id, collectionEpoch: context.collectionEpoch, createdByUserId: context.userId }).onConflictDoNothing();
      const [collection] = await tx.select().from(epoch).where(and(eq(epoch.installationId, source.id), eq(epoch.collectionEpoch, context.collectionEpoch), eq(epoch.createdByUserId, context.userId)));
      if (collection.revokedAt) throw new DataRequestError(403, "epoch_revoked", "Collection epoch has been revoked");
      const result: BatchResult = { accepted_count: 0, duplicate_count: 0, acked_event_ids: [], rejected: [...batch.rejected] };
      const ids = [...new Set(batch.events.map((e) => e.eventId))];
      const existing = ids.length ? await tx.select({ eventId: event.eventId, payloadHash: event.payloadHash }).from(event).where(and(eq(event.createdByUserId, context.userId), inArray(event.eventId, ids))) : [];
      const hashes = new Map(existing.map((e) => [e.eventId, e.payloadHash]));
      const submitted = new Map<string, string>();
      const conflicts = new Set<string>();
      for (const e of batch.events) {
        if (submitted.has(e.eventId) && submitted.get(e.eventId) !== e.payloadHash) conflicts.add(e.eventId);
        submitted.set(e.eventId, e.payloadHash);
      }
      const rows: (typeof event.$inferInsert)[] = [];
      let addedBytes = 0;
      for (const e of batch.events) {
        if (conflicts.has(e.eventId) || (hashes.has(e.eventId) && hashes.get(e.eventId) !== e.payloadHash)) {
          result.rejected.push({ line: e.line, event_id: e.eventId, code: "event_id_conflict", message: "Event ID already identifies different content", retryable: false });
          continue;
        }
        if (hashes.has(e.eventId)) result.duplicate_count++;
        else {
          hashes.set(e.eventId, e.payloadHash);
          rows.push({ id: ulid(), eventId: e.eventId, epochId: collection.id, createdByUserId: context.userId, eventType: e.eventType, schemaVersion: e.schemaVersion, occurredAt: e.occurredAt, recordedAt: e.recordedAt, batchId: context.batchId, payloadHash: e.payloadHash, byteLength: e.byteLength, rawEnvelope: e.envelope });
          result.accepted_count++;
          addedBytes += e.byteLength;
        }
        if (!result.acked_event_ids.includes(e.eventId)) result.acked_event_ids.push(e.eventId);
      }
      if (state.storedBytes + addedBytes > this.maxStoredBytes) throw new DataRequestError(429, "storage_budget_exceeded", "Personal-data storage budget reached", true, 3600);
      if (rows.length) {
        await tx.insert(event).values(rows);
        await tx.insert(job).values(rows.map((row) => ({ id: ulid(), eventId: row.id, createdByUserId: context.userId })));
        await tx.update(ownerState).set({ storedBytes: state.storedBytes + addedBytes }).where(eq(ownerState.createdByUserId, context.userId));
      }
      await tx.update(installation).set({ lastReceivedAt: now }).where(and(eq(installation.id, source.id), eq(installation.createdByUserId, context.userId)));
      result.rejected.sort((a, b) => a.line - b.line);
      return result;
    });
  }

  async status(userId: string) {
    const sources = await this.database.select({ installation_id: installation.installationId, last_received_at: installation.lastReceivedAt, revoked_at: installation.revokedAt }).from(installation).where(eq(installation.createdByUserId, userId)).limit(200);
    const [counts] = await this.database.select({
      count: sql<number>`count(*) filter (where ${job.status} = 'pending')::integer`,
      failed: sql<number>`count(*) filter (where ${job.status} in ('failed', 'invalid'))::integer`,
    }).from(job).where(eq(job.createdByUserId, userId));
    const overdue = sql`${scan.status} in ('pending', 'repair_pending', 'v2_pending', 'v2_repair_pending') and ${scan.createdAt} < now() - interval '24 hours'`;
    const [scanCounts] = await this.database.select({
      pending: sql<number>`count(*) filter (where ${scan.status} in ('pending', 'repair_pending', 'v2_pending', 'v2_repair_pending'))::integer`,
      repair: sql<number>`count(*) filter (where ${scan.status} = 'invalid' or (${overdue}))::integer`,
    }).from(scan).where(eq(scan.createdByUserId, userId));
    const received = sql<number>`(select count(*)::integer from contact_scan_record r where r.scan_id = ${scan.id} and r.created_by_user_id = ${scan.createdByUserId})`;
    const scans = await this.database.select({ scan_id: scan.scanId, source_id: scan.sourceId, generation: scan.generation,
      status: sql<string>`case when ${scan.status} = 'v2_pending' then 'pending' when ${scan.status} = 'v2_repair_pending' then 'repair_pending' else ${scan.status} end`, error_code: scan.errorCode, published_at: scan.publishedAt, received_at: scan.createdAt,
      reconciliation_required: sql<boolean>`${scan.status} = 'invalid' or (${overdue})`,
      waiting_reason: sql<string | null>`case when ${scan.status} not in ('pending', 'repair_pending', 'v2_pending', 'v2_repair_pending') then null
        when ${scan.status} in ('pending', 'v2_pending') and ${scan.generation} > ${contactSource.generation} + 1 then 'missing_predecessor'
        when ${scan.manifest} is null then 'missing_manifest'
        when ${received} < (${scan.manifest}->>'expected_event_count')::integer then 'missing_records'
        else 'awaiting_publication' end`,
      received_record_count: received,
      expected_record_count: sql<number | null>`(${scan.manifest}->>'expected_event_count')::integer`,
    }).from(scan).innerJoin(contactSource, and(eq(contactSource.id, scan.sourceId), eq(contactSource.createdByUserId, userId)))
      .where(eq(scan.createdByUserId, userId)).orderBy(sql`${scan.createdAt} desc`, scan.id).limit(200);
    const contactSources = await this.database.select({ source_id: contactSource.id,
      installation_id: installation.installationId, collection_epoch: epoch.collectionEpoch,
      revoked: sql<boolean>`${epoch.revokedAt} is not null or ${installation.revokedAt} is not null` })
      .from(contactSource).innerJoin(epoch, and(eq(epoch.id, contactSource.epochId), eq(epoch.createdByUserId, userId)))
      .innerJoin(installation, and(eq(installation.id, epoch.installationId), eq(installation.createdByUserId, userId)))
      .where(eq(contactSource.createdByUserId, userId)).orderBy(contactSource.id).limit(201);
    return { sources, contact_sources: contactSources.slice(0, 200), contact_sources_truncated: contactSources.length > 200,
      scans, pending_processing_count: counts.count, failed_processing_count: counts.failed,
      reconciliation_scan_count: scanCounts.repair,
      projection_status: counts.failed || scanCounts.repair ? "needs_reconciliation" : counts.count || scanCounts.pending ? "processing" : "ready" };
  }
}
