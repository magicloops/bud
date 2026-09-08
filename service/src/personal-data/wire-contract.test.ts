import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import Fastify from "fastify";
import { parseBatch } from "./parser.js";
import { parseContactPayload, verifyContactScan, type ContactManifest, type ContactRecord } from "./contacts.js";
import { registerPersonalDataRoutes } from "./routes.js";

test("shared mobile/service fixture preserves envelopes, manifest and HTTP ACK", async t => {
  const bytes = await readFile(new URL("./wire-contract-v1.json", import.meta.url));
  // Same reviewed bytes are bundled into TimelineCoreTests; neither test suite
  // requires the other checkout at runtime.
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "0e03793494fd91c453aa4f51d991777947430ff5d3794b042ecabe3463d75515");
  const fixture = JSON.parse(bytes.toString());
  const raw = Buffer.from(fixture.events.map((event: unknown) => JSON.stringify(event)).join("\n") + "\n");
  for (const encoding of ["identity", "gzip"]) {
    const parsed = await parseBatch(encoding === "gzip" ? gzipSync(raw) : raw, encoding, fixture.context);
    assert.deepEqual(parsed.rejected, []);
    assert.deepEqual(parsed.events.map(event => event.envelope), fixture.events);
  }
  const record = fixture.events[2];
  const manifest = fixture.events[3];
  assert.equal(verifyContactScan(parseContactPayload(manifest.event_type, manifest.payload) as ContactManifest,
    [{ eventID: record.event_id, payload: parseContactPayload(record.event_type, record.payload) as ContactRecord }]), true);
  const app = Fastify();
  t.after(() => app.close());
  await registerPersonalDataRoutes(app, {
    authenticate: async () => ({ userId: fixture.context.userId }),
    repository: {
      persist: async (_context, batch) => ({ accepted_count: batch.events.length, duplicate_count: 0,
        acked_event_ids: batch.events.map(event => event.eventId), rejected: batch.rejected }),
      status: async () => ({}),
    },
  });
  const response = await app.inject({ method: "POST", url: "/v1/events/batches", payload: gzipSync(raw),
    headers: { "content-type": "application/x-ndjson", "content-encoding": "gzip",
      "x-installation-id": fixture.context.installationId, "x-batch-id": fixture.context.batchId } });
  assert.equal(response.statusCode, 200);
  const actual = response.json();
  delete actual.server_time;
  assert.deepEqual(actual, fixture.ack_cases[0].response);
});


test("shared v2 corpus preserves rich and empty fields and verifies its complete manifest", async () => {
  const bytes = await readFile(new URL("./wire-contract-v2.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "e69399c080d8bde576e4d3b5562a1e99f51a9a876afe816d4c7be1e771746b99");
  const fixture = JSON.parse(bytes.toString());
  const raw = Buffer.from(fixture.events.map((event: unknown) => JSON.stringify(event)).join("\n") + "\n");
  for (const encoding of ["identity", "gzip"]) {
    const parsed = await parseBatch(encoding === "gzip" ? gzipSync(raw) : raw, encoding, fixture.context);
    assert.deepEqual(parsed.rejected, []);
    assert.deepEqual(parsed.events.map(event => event.envelope), fixture.events);
  }
  const records = fixture.events.slice(0, 2).map((event: { event_id: string; event_type: string; payload: unknown }) => {
    assert.equal(parseContactPayload(event.event_type, event.payload), null, "v1 processing cannot silently consume rich records");
    const payload = parseContactPayload(event.event_type, event.payload, { allowExpanded: true }) as ContactRecord;
    assert.ok(payload);
    assert.deepEqual(payload.contact, (event.payload as { contact: unknown }).contact);
    return { eventID: event.event_id, payload };
  });
  const event = fixture.events[2];
  const manifest = parseContactPayload(event.event_type, event.payload, { allowExpanded: true }) as ContactManifest;
  assert.ok(manifest);
  assert.equal(verifyContactScan(manifest, records), true);
  assert.equal(verifyContactScan(manifest, [records[0]]), false);
});
