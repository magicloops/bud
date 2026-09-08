import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { ContactProcessor } from "./contact-processor.js";
import { PostgresIngestRepository } from "./repository.js";
import { parseBatch } from "./parser.js";
import { contactManifestDigest } from "./contacts.js";

test("complete source repair skips broken scans without changing identities or emitting actions", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const fixtureSchema = `repair_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${fixtureSchema}` });
  const db = drizzle(pool, { schema: s });
  const owner = `repair-${randomUUID()}`;
  t.after(async () => {
    try {
      await pool.end();
      await admin.query(`drop schema if exists "${fixtureSchema}" cascade`);
    } finally { await admin.end(); }
  });
  // Owner filtering does not isolate fixtures from a running service's global
  // worker. Dedicated indexed copies preserve multi-connection transactions
  // without exposing these deliberately incomplete scans to that worker.
  await admin.query(`create schema "${fixtureSchema}"`);
  for (const table of ["data_owner_state", "data_installation", "data_collection_epoch", "data_event",
    "data_processing_job", "contact_source", "contact_scan", "contact_scan_record", "contact",
    "contact_revision", "data_domain_event", "location_observation"]) {
    await admin.query(`create table "${fixtureSchema}"."${table}" (like public."${table}" including all)`);
  }
  const context = { userId: owner, installationId: randomUUID(), collectionEpoch: "legacy", batchId: randomUUID() };
  const storeID = randomUUID();
  const repository = new PostgresIngestRepository(db);
  const processor = new ContactProcessor(db);
  const at = (generation: number) => new Date(1_780_000_000_000 + generation * 1000).toISOString();
  const scan = (generation: number, ids: string[], repair = false) => {
    const common = { payload_version: 1, contact_store_id: storeID, scan_id: randomUUID(), generation,
      previous_generation: generation - 1, scan_mode: repair ? "resync" : generation === 1 ? "baseline" : "incremental",
      observed_at: at(generation), previous_observed_at: generation === 1 ? null : at(generation - 1),
      time_basis: "observed", authorization: "3" };
    const wrap = (type: string, payload: object) => ({ schema_version: 1, event_id: randomUUID(), event_type: type,
      occurred_at: at(generation), recorded_at: at(generation), actor: { user_id: owner, installation_id: context.installationId }, payload });
    const records = ids.map(id => wrap(repair ? "contacts.repair_record.v1" : "contacts.record.v1", {
      ...common, source_contact_id: id, change: "upsert", newly_observed: !repair && generation > 1,
      contact: { given_name: id, family_name: "", organization: "", phones: [], emails: [] },
    }));
    return [...records, wrap(repair ? "contacts.repair_scan.v1" : "contacts.scan.v1", {
      ...common, expected_event_count: records.length, event_ids_sha256: contactManifestDigest(records.map(row => row.event_id)),
    })];
  };
  const upload = async (rows: object[], oldService = false) => {
    await repository.persist(context, await parseBatch(Buffer.from(rows.map(row => JSON.stringify(row)).join("\n")), "", context));
    if (oldService) {
      await db.update(s.dataProcessingJobTable).set({ status: "unsupported" }).where(and(
        eq(s.dataProcessingJobTable.createdByUserId, owner), eq(s.dataProcessingJobTable.status, "pending")));
      assert.equal(await processor.requeueSupportedLocations(owner + "-foreign"), false);
      assert.equal(await processor.requeueSupportedLocations(owner), true);
      assert.equal(await processor.requeueSupportedLocations(owner), false);
    }
    while (await processor.processNext(owner)) { /* fixture owner only */ }
  };
  await upload(scan(1, ["retained", "removed"]));
  assert.equal(await processor.publishNext(false, owner), true);
  const originals = await db.select().from(s.contactTable).where(eq(s.contactTable.createdByUserId, owner));
  const broken = scan(2, ["unpublished"]);
  await upload([broken.at(-1)!]);
  assert.equal(await processor.publishNext(false, owner), false);
  const replacement = scan(4, ["retained", "replacement"], true);
  await upload([replacement.at(-1)!], true);
  const staged = (await repository.status(owner)).scans.find(row => row.generation === 4)!;
  assert.equal(staged.status, "repair_pending");
  assert.equal(staged.waiting_reason, "missing_records", "repair does not wait for skipped predecessors");
  const oldCandidates = await db.select().from(s.contactScanTable).where(and(
    eq(s.contactScanTable.createdByUserId, owner), eq(s.contactScanTable.status, "pending")));
  assert.equal(oldCandidates.some(row => row.generation === 4), false, "old publisher cannot consume staged repair");
  assert.equal(await processor.publishNext(false, owner), false, "repair needs all original manifest members");
  await upload(replacement.slice(0, -1), true);
  assert.equal(await processor.publishNext(false, owner + "-foreign"), false);
  const publications = await Promise.all([processor.publishNext(false, owner), processor.publishNext(false, owner)]);
  assert.equal(publications.filter(Boolean).length, 1);
  let contacts = await db.select().from(s.contactTable).where(eq(s.contactTable.createdByUserId, owner));
  assert.deepEqual(contacts.filter(row => row.visible).map(row => row.sourceContactId).sort(), ["replacement", "retained"]);
  for (const original of originals) assert.equal(contacts.find(row => row.sourceContactId === original.sourceContactId)?.id, original.id);
  assert.equal(contacts.find(row => row.sourceContactId === "removed")?.visible, false);
  assert.equal((await db.select().from(s.dataDomainEventTable).where(eq(s.dataDomainEventTable.createdByUserId, owner))).length, 0);
  let scans = await db.select().from(s.contactScanTable).where(eq(s.contactScanTable.createdByUserId, owner));
  assert.equal(scans.find(row => row.generation === 2)?.status, "superseded");
  assert.equal(scans.find(row => row.generation === 1)?.status, "published");
  await upload(broken.slice(0, -1));
  await upload(scan(3, ["late-old"], true));
  assert.equal(await processor.publishNext(false, owner), false);
  assert.equal((await repository.status(owner)).projection_status, "ready");
  await upload(scan(5, ["new-live"]));
  assert.equal(await processor.publishNext(false, owner), true);
  const actions = await db.select().from(s.dataDomainEventTable).where(eq(s.dataDomainEventTable.createdByUserId, owner));
  assert.equal(actions.length, 1, "subsequent ordinary additions still trigger");
  await upload(scan(7, [], true));
  assert.equal(await processor.publishNext(false, owner), true);
  contacts = await db.select().from(s.contactTable).where(eq(s.contactTable.createdByUserId, owner));
  assert.equal(contacts.filter(row => row.visible).length, 0);
  assert.deepEqual(await db.select().from(s.dataDomainEventTable).where(eq(s.dataDomainEventTable.createdByUserId, owner)), actions);
  scans = await db.select().from(s.contactScanTable).where(eq(s.contactScanTable.createdByUserId, owner));
  assert.equal(scans.find(row => row.generation === 5)?.status, "published");
});
