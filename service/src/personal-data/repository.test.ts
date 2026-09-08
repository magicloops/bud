import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { PostgresIngestRepository } from "./repository.js";
import { parseBatch } from "./parser.js";
import { DataRequestError } from "./contracts.js";
import { config } from "../config.js";
import * as schema from "../db/schema.js";

// Explicit opt-in: writes only generated fixture owners, never existing rows.
// Requires the local main schema created by db:push or migrations.
test("Postgres ingestion: atomic jobs, retries, conflicts, owner boundaries and revocation", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async (t) => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(config.databaseUrl).hostname), "Database integration tests require a local DB");
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
  const database = drizzle(pool, { schema });
  const owners = ["data-test-" + randomUUID(), "data-test-" + randomUUID()];
  t.after(async () => {
    try {
      await database.transaction(async (tx) => {
        await tx.delete(schema.contactScanTable).where(inArray(schema.contactScanTable.createdByUserId, owners));
        await tx.delete(schema.contactSourceTable).where(inArray(schema.contactSourceTable.createdByUserId, owners));
        await tx.delete(schema.dataProcessingJobTable).where(inArray(schema.dataProcessingJobTable.createdByUserId, owners));
        await tx.delete(schema.dataEventTable).where(inArray(schema.dataEventTable.createdByUserId, owners));
        await tx.delete(schema.dataCollectionEpochTable).where(inArray(schema.dataCollectionEpochTable.createdByUserId, owners));
        await tx.delete(schema.dataInstallationTable).where(inArray(schema.dataInstallationTable.createdByUserId, owners));
        await tx.delete(schema.dataOwnerStateTable).where(inArray(schema.dataOwnerStateTable.createdByUserId, owners));
        await tx.delete(schema.authUserTable).where(inArray(schema.authUserTable.id, owners));
      });
    } finally { await pool.end(); }
  });
  await database.insert(schema.authUserTable).values(owners.map((id) => ({ id, name: "Ingestion fixture", emailVerified: false, email: `${id}@example.invalid` })));
  const repository = new PostgresIngestRepository(database);
  const context = { userId: owners[0], installationId: "same-physical-phone", collectionEpoch: "legacy", batchId: "batch-a" };
  const value = { schema_version: 1, event_id: "same-client-event", event_type: "location.visit", occurred_at: "2026-09-04T10:00:00Z", recorded_at: "2026-09-04T10:00:00Z", actor: { installation_id: context.installationId }, payload: { latitude: 37.7 } };
  const batch = await parseBatch(Buffer.from(JSON.stringify(value)), "", context);
  const concurrent = await Promise.all([repository.persist(context, batch), repository.persist(context, batch)]);
  assert.equal(concurrent.reduce((sum, r) => sum + r.accepted_count, 0), 1);
  assert.equal(concurrent.reduce((sum, r) => sum + r.duplicate_count, 0), 1);
  assert.ok(concurrent.every((r) => r.acked_event_ids[0] === value.event_id));
  let jobs = await database.select().from(schema.dataProcessingJobTable).where(eq(schema.dataProcessingJobTable.createdByUserId, owners[0]));
  assert.equal(jobs.length, 1);
  const changed = await parseBatch(Buffer.from(JSON.stringify({ ...value, payload: { latitude: 1 } })), "", context);
  const conflict = await repository.persist(context, changed);
  assert.deepEqual(conflict.acked_event_ids, []);
  assert.equal(conflict.rejected[0].code, "event_id_conflict");
  const internalConflict = await repository.persist(context, { events: [...batch.events, ...changed.events], rejected: [] });
  assert.deepEqual(internalConflict.acked_event_ids, []);
  const other = await repository.persist({ ...context, userId: owners[1] }, batch);
  assert.equal(other.accepted_count, 1);
  const rows = await database.select().from(schema.dataEventTable).where(inArray(schema.dataEventTable.createdByUserId, owners));
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].epochId, rows[1].epochId);
  assert.ok(rows.every((r) => r.rawEnvelope.payload && (r.rawEnvelope.payload as { latitude: number }).latitude === 37.7));

  const sourceID = randomUUID();
  await database.insert(schema.contactSourceTable).values({ id: sourceID,
    epochId: rows.find(row => row.createdByUserId === owners[0])!.epochId, storeId: randomUUID(), createdByUserId: owners[0] });
  const missingManifest = randomUUID(), missingPredecessor = randomUUID();
  await database.insert(schema.contactScanTable).values([
    { id: missingManifest, sourceId: sourceID, scanId: randomUUID(), generation: 1, createdByUserId: owners[0] },
    { id: missingPredecessor, sourceId: sourceID, scanId: randomUUID(), generation: 2, createdByUserId: owners[0],
      createdAt: new Date(Date.now() - 25 * 3600_000) },
  ]);
  let status = await repository.status(owners[0]);
  assert.equal(status.projection_status, "needs_reconciliation");
  assert.equal(status.reconciliation_scan_count, 1);
  assert.equal(status.scans.find(row => row.generation === 1)?.waiting_reason, "missing_manifest");
  assert.equal(status.scans.find(row => row.generation === 2)?.waiting_reason, "missing_predecessor");
  assert.equal(status.scans.find(row => row.generation === 2)?.reconciliation_required, true);
  const foreignStatus = await repository.status(owners[1]);
  assert.equal(foreignStatus.reconciliation_scan_count, 0);
  assert.deepEqual(foreignStatus.scans, []);
  await database.update(schema.contactScanTable).set({ manifest: { expected_event_count: 1 } })
    .where(eq(schema.contactScanTable.id, missingManifest));
  status = await repository.status(owners[0]);
  assert.equal(status.scans.find(row => row.generation === 1)?.waiting_reason, "missing_records");
  assert.equal(status.scans.find(row => row.generation === 1)?.received_record_count, 0);
  assert.equal(status.scans.find(row => row.generation === 1)?.expected_record_count, 1);
  // Bounded detail pages must not hide older broken work from the aggregate.
  await database.insert(schema.contactScanTable).values(Array.from({ length: 201 }, (_, index) => ({
    id: randomUUID(), sourceId: sourceID, scanId: randomUUID(), generation: index + 3,
    status: "published", createdByUserId: owners[0],
  })));
  status = await repository.status(owners[0]);
  assert.equal(status.scans.length, 200);
  assert.equal(status.scans.some(row => row.generation === 2), false);
  assert.equal(status.projection_status, "needs_reconciliation");
  await database.update(schema.contactScanTable).set({ status: "published" }).where(eq(schema.contactScanTable.sourceId, sourceID));
  await database.update(schema.dataProcessingJobTable).set({ status: "failed" }).where(eq(schema.dataProcessingJobTable.createdByUserId, owners[0]));
  status = await repository.status(owners[0]);
  assert.equal(status.failed_processing_count, 1);
  assert.equal(status.projection_status, "needs_reconciliation");
  await database.update(schema.dataProcessingJobTable).set({ status: "processed" }).where(eq(schema.dataProcessingJobTable.createdByUserId, owners[0]));
  assert.equal((await repository.status(owners[0])).projection_status, "ready");

  // Throw at job persistence inside a real PostgreSQL transaction, after event
  // insertion. Verifies the repository does not commit events independently.
  const failingDatabase = Object.create(database) as typeof database;
  failingDatabase.transaction = ((work: (tx: unknown) => Promise<unknown>) => database.transaction(async (tx) => work(new Proxy(tx, {
    get(target, key) {
      if (key === "insert") return (table: unknown) => {
        if (table === schema.dataProcessingJobTable) throw new Error("injected job persistence failure");
        return target.insert(table as typeof schema.dataEventTable);
      };
      const member = Reflect.get(target, key);
      return typeof member === "function" ? member.bind(target) : member;
    },
  })))) as typeof database.transaction;
  const fresh = await parseBatch(Buffer.from(JSON.stringify({ ...value, event_id: "rollback-event" })), "", context);
  await assert.rejects(new PostgresIngestRepository(failingDatabase).persist(context, fresh), /injected job persistence failure/);
  const rolledBack = await database.select().from(schema.dataEventTable).where(and(eq(schema.dataEventTable.createdByUserId, owners[0]), eq(schema.dataEventTable.eventId, "rollback-event")));
  assert.equal(rolledBack.length, 0);
  jobs = await database.select().from(schema.dataProcessingJobTable).where(eq(schema.dataProcessingJobTable.createdByUserId, owners[0]));
  assert.equal(jobs.length, 1);

  await database.update(schema.dataCollectionEpochTable).set({ revokedAt: new Date() }).where(eq(schema.dataCollectionEpochTable.createdByUserId, owners[0]));
  await assert.rejects(repository.persist(context, batch), (error: unknown) => error instanceof DataRequestError && error.code === "epoch_revoked");
  assert.equal((await repository.persist({ ...context, userId: owners[1] }, batch)).duplicate_count, 1);
});
