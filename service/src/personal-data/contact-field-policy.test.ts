import assert from "node:assert/strict";
import { test } from "node:test";
import { ulid } from "ulid";
import { sql } from "drizzle-orm";
import { db, pool, type Database } from "../db/client.js";
import { config } from "../config.js";
import { ContactQueries } from "./contact-queries.js";
import { LocationQueries } from "./location.js";
import { contactTable, contactRevisionTable, contactScanTable, locationObservationTable } from "../db/schema.js";
import { DataRequestError } from "./contracts.js";

test("restricted contact fields affect SQL matching, current/history projection and cursor policy", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  try {
    await db.transaction(async tx => {
      // Temporary typed copies exercise the real query SQL without touching any
      // owner's source/scan lineage. They disappear when the transaction ends.
      for (const table of ["contact", "contact_revision", "contact_scan", "location_observation"])
        await tx.execute(sql.raw(`create temporary table ${table} (like public.${table} including defaults) on commit drop`));
      const ids = [ulid(), ulid()].sort();
      const scan = ulid();
      const fields = { given_name: "Ada", family_name: "Lovelace", organization: "HiddenCompany",
        phones: [{ label: "phone", value: "5559991234" }], emails: [{ label: "email", value: "private@example.invalid" }],
        postal_addresses: [{ label: "home", street: "HiddenStreet", city: "京都", sub_administrative_area: "", state: "", postal_code: "", country: "日本", iso_country_code: "JP" }],
        urls: [{ label: "web", value: "https://hidden.example.invalid" }] };
      const at = new Date("2026-09-03T12:00:00Z");
      await tx.insert(contactTable).values(ids.map(id => ({ id, sourceId: "source", sourceContactId: id, fields,
        visible: true, generation: 1, firstObservedAt: at, observedAt: at, createdByUserId: "owner-a" })));
      await tx.insert(contactTable).values({ id: ulid(), sourceId: "source-b", sourceContactId: "foreign", fields,
        visible: true, generation: 1, firstObservedAt: at, observedAt: at, createdByUserId: "owner-b" });
      await tx.insert(contactScanTable).values({ id: scan, sourceId: "source", scanId: "scan", generation: 1, createdByUserId: "owner-a" });
      await tx.insert(contactRevisionTable).values({ id: ulid(), contactId: ids[0], scanId: scan, fields,
        visible: true, observedAt: at, createdByUserId: "owner-a" });
      const query = new ContactQueries(tx as unknown as Database);
      const policy = { observedSince: new Date("2026-09-01T00:00:00Z"), cursorBinding: "app:key:1", contactFields: ["names"] as const };
      assert.equal((await query.list("owner-a", { search: "5559991234" }, policy)).items.length, 0);
      assert.equal((await query.list("owner-a", { search: "HiddenCompany" }, policy)).items.length, 0);
      assert.equal((await query.list("owner-a", { search: "private@example.invalid" }, policy)).items.length, 0);
      const legacyPolicy = { observedSince: policy.observedSince, cursorBinding: "old-agent-grant" };
      for (const search of ["HiddenStreet", "hidden.example.invalid", "京都"]) {
        assert.equal((await query.list("owner-a", { search }, policy)).items.length, 0);
        assert.equal((await query.list("owner-a", { search }, legacyPolicy)).items.length, 0);
      }
      const legacy = await query.get("owner-a", ids[0], legacyPolicy);
      assert.equal("postal_addresses" in legacy.fields, false);
      assert.equal("urls" in legacy.fields, false);
      const legacyHistory = await query.history("owner-a", ids[0], {}, legacyPolicy);
      assert.equal("urls" in legacyHistory.items[0].fields, false);
      const richPolicy = { ...policy, contactFields: ["postal_addresses", "urls"] as const };
      const richPage = await query.list("owner-a", { search: "HiddenStreet", limit: 1 }, richPolicy);
      assert.equal(richPage.items.length, 1);
      assert.deepEqual(richPage.items[0].fields, { postal_addresses: fields.postal_addresses, urls: fields.urls });
      assert.deepEqual((await query.history("owner-a", ids[0], {}, richPolicy)).items[0].fields, richPage.items[0].fields);
      assert.equal((await query.list("owner-a", { search: "hidden.example.invalid" }, richPolicy)).items.length, 2);
      assert.equal((await query.list("owner-a", { search: "Ada" }, richPolicy)).items.length, 0);
      assert.ok(richPage.next_cursor);
      await assert.rejects(query.list("owner-a", { search: "HiddenStreet", limit: 1, cursor: richPage.next_cursor }, legacyPolicy),
        (error: unknown) => error instanceof DataRequestError && error.code === "invalid_cursor");
      const page = await query.list("owner-a", { search: "Ada", limit: 1 }, policy);
      assert.equal(page.items.length, 1);
      assert.deepEqual(page.items[0].fields, { given_name: "Ada", family_name: "Lovelace" });
      assert.deepEqual((await query.get("owner-a", ids[0], policy)).fields, page.items[0].fields);
      assert.deepEqual((await query.history("owner-a", ids[0], {}, policy)).items[0].fields, page.items[0].fields);
      assert.equal((await query.list("owner-a", { search: "5559991234" })).items.length, 2, "first-party reads retain all approved fields");
      assert.ok(page.next_cursor);
      await assert.rejects(query.list("owner-a", { search: "Ada", limit: 1, cursor: page.next_cursor }, { ...policy, contactFields: ["phones"] }),
        (error: unknown) => error instanceof DataRequestError && error.code === "invalid_cursor");
      assert.equal((await query.list("owner-a", {}, { ...policy, observedSince: new Date("2026-09-04T00:00:00Z") })).items.length, 0);
      const locations = new LocationQueries(tx as unknown as Database);
      await tx.insert(locationObservationTable).values([0, 1].map(i => ({ id: ulid(), rawEventId: `event-${i}`, epochId: "epoch",
        kind: "visit", latitude: 1, longitude: 2, horizontalAccuracyM: 10, occurredAt: at, receivedAt: at, createdByUserId: "owner-a" })));
      const window = { from: "2026-09-03T00:00:00Z", to: "2026-09-04T00:00:00Z", limit: 1 };
      const locationPage = await locations.list("owner-a", window, policy);
      assert.ok(locationPage.next_cursor);
      await assert.rejects(locations.list("owner-a", { ...window, cursor: locationPage.next_cursor }, { cursorBinding: "app:other-key:1" }),
        (error: unknown) => error instanceof DataRequestError && error.code === "invalid_cursor");
      await assert.rejects(locations.list("owner-a", { ...window, cursor: locationPage.next_cursor }),
        (error: unknown) => error instanceof DataRequestError && error.code === "invalid_cursor");
    });
  } finally { await pool.end(); }
});
