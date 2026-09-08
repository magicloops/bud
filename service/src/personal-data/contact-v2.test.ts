import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { ContactProcessor } from "./contact-processor.js";
import { PostgresIngestRepository } from "./repository.js";
import { ContactQueries } from "./contact-queries.js";
import { parseBatch } from "./parser.js";
import { contactManifestDigest } from "./contacts.js";

test("v2 enrichment preserves identity/history, new additions and repair suppression", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const fixture = `contact_v2_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${fixture}` });
  t.after(async () => { await pool.end(); try { await admin.query(`drop schema if exists "${fixture}" cascade`); } finally { await admin.end(); } });
  await admin.query(`create schema "${fixture}"`);
  for (const table of ["data_owner_state", "data_installation", "data_collection_epoch", "data_event", "data_processing_job",
    "contact_source", "contact_scan", "contact_scan_record", "contact", "contact_revision", "data_domain_event", "location_observation"])
    await admin.query(`create table "${fixture}"."${table}" (like public."${table}" including all)`);
  const db = drizzle(pool, { schema: s });
  const owner = "v2-owner";
  const context = { userId: owner, installationId: randomUUID(), collectionEpoch: "legacy", batchId: randomUUID() };
  const repository = new PostgresIngestRepository(db);
  const processor = new ContactProcessor(db);
  const query = new ContactQueries(db);
  const store = randomUUID();
  const at = (n: number) => new Date(1_780_000_000_000 + n * 1000).toISOString();
  const scan = (generation: number, version: number, ids: string[], repair = false, empty = false) => {
    const common = { payload_version: version, contact_store_id: store, scan_id: randomUUID(), generation,
      previous_generation: generation - 1, previous_observed_at: generation === 1 ? null : at(generation - 1),
      observed_at: at(generation), scan_mode: generation === 1 ? "baseline" : repair ? "resync" : "incremental", time_basis: "observed", authorization: "3" };
    const wrap = (kind: string, payload: object) => ({ schema_version: 1, event_id: randomUUID(),
      event_type: `contacts.${repair ? "repair_" : ""}${kind}.v${version}`, occurred_at: at(generation), recorded_at: at(generation),
      actor: { user_id: owner, installation_id: context.installationId }, payload });
    const rows = ids.map(id => wrap("record", { ...common, source_contact_id: id, change: "upsert",
      newly_observed: !repair && generation > 1 && id === "new",
      contact: { given_name: id, family_name: "", organization: "", phones: [], emails: [],
        ...(version === 2 ? { postal_addresses: empty ? [] : [{ label: "home", street: "丸の内", city: "千代田区",
          sub_administrative_area: "", state: "東京都", postal_code: "100-0005", country: "日本", iso_country_code: "JP" }],
        urls: empty ? [] : [{ label: "website", value: "https://example.invalid/private" }] } : {}) } }));
    return [...rows, wrap("scan", { ...common, expected_event_count: rows.length, event_ids_sha256: contactManifestDigest(rows.map(row => row.event_id)) })];
  };
  const upload = async (rows: object[], olderProcessor = false) => {
    const result = await repository.persist(context, await parseBatch(Buffer.from(rows.map(row => JSON.stringify(row)).join("\n")), "", context));
    assert.equal(result.rejected.length, 0);
    if (olderProcessor) {
      await db.update(s.dataProcessingJobTable).set({ status: "unsupported" }).where(eq(s.dataProcessingJobTable.status, "pending"));
      assert.equal(await processor.requeueSupportedLocations("foreign"), false);
      assert.equal(await processor.requeueSupportedLocations(owner), true);
      assert.equal(await processor.requeueSupportedLocations(owner), false);
    }
    while (await processor.processNext(owner)) {}
    return result;
  };
  await upload(scan(1, 1, ["retained"]));
  assert.equal(await processor.publishNext(false, owner), true);
  const original = (await query.list(owner, {})).items[0];
  const rich = scan(2, 2, ["retained", "new"]);
  await upload([rich.at(-1)!], true);
  assert.equal(await processor.publishNext(false, owner), false);
  const pending = await repository.status(owner);
  assert.equal(pending.projection_status, "processing");
  assert.equal(pending.scans.find(row => row.generation === 2)?.waiting_reason, "missing_records");
  const stages = await db.select().from(s.contactScanTable);
  assert.equal(stages.find(row => row.generation === 2)?.status, "v2_pending", "older publishers cannot consume v2 staging");
  await upload(rich.slice(0, -1));
  const publications = await Promise.all([processor.publishNext(false, owner), processor.publishNext(false, owner)]);
  assert.equal(publications.filter(Boolean).length, 1);
  const enriched = await query.get(owner, original.id);
  assert.equal(enriched.source_contact_id, original.source_contact_id);
  assert.deepEqual(enriched.first_observed_at, original.first_observed_at);
  assert.ok(enriched.fields.postal_addresses);
  const history = await query.history(owner, original.id, {});
  assert.equal(history.items.length, 2);
  assert.equal(history.items[0].fields.urls, undefined);
  assert.ok(history.items[1].fields.urls);
  const actions = await db.select().from(s.dataDomainEventTable);
  assert.equal(actions.length, 1, "only the genuinely new contact emits an action");
  assert.equal((await upload(rich)).duplicate_count, rich.length);
  assert.equal(await processor.publishNext(false, owner), false);
  const legacyPolicy = { observedSince: new Date(0), cursorBinding: "legacy" };
  assert.equal((await query.list(owner, { search: "private" }, legacyPolicy)).items.length, 0);
  assert.equal((await query.get(owner, original.id, legacyPolicy)).fields.urls, undefined);
  assert.equal((await query.list("foreign", {})).items.length, 0);
  await upload(scan(3, 2, ["retained"], false, true));
  assert.equal(await processor.publishNext(false, owner), true);
  assert.deepEqual((await query.get(owner, original.id)).fields.urls, []);
  await upload(scan(5, 2, ["retained", "replacement"], true));
  assert.equal(await processor.publishNext(false, owner), true);
  assert.deepEqual(await db.select().from(s.dataDomainEventTable), actions);
  assert.equal((await repository.status(owner)).projection_status, "ready");
  await upload(scan(6, 1, ["retained"]));
  assert.equal(await processor.publishNext(false, owner), true);
  assert.equal((await query.get(owner, original.id)).fields.urls, undefined);
  assert.equal((await query.history(owner, original.id, {})).items.length, 5);
});
