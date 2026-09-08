import test from "node:test";
import assert from "node:assert/strict";
import { contactManifestDigest, parseContactPayload, parseExpandedContactFields, verifyContactScan, type ContactManifest, type ContactRecord } from "./contacts.js";

const context = {
  payload_version: 1, contact_store_id: "00000000-0000-0000-0000-000000000001",
  scan_id: "00000000-0000-0000-0000-000000000002", generation: 1, previous_generation: 0,
  scan_mode: "baseline", observed_at: "2026-09-04T10:00:00.000Z", previous_observed_at: null,
  time_basis: "observed", authorization: "3",
};
const record = { ...context, source_contact_id: "source-a", change: "upsert", newly_observed: false,
  contact: { given_name: "A", family_name: "B", organization: "", phones: [], emails: [] } };
const id = "00000000-0000-0000-0000-000000000003";

test("large labeled contact lists remain ingestible without removing bounds", () => {
  const entries = Array.from({ length: 235 }, (_, i) => ({ label: "work", value: `555-${i}` }));
  const parsed = parseContactPayload("contacts.record.v1", { ...record, contact: { ...record.contact, phones: entries } }) as ContactRecord;
  assert.deepEqual(parsed.contact?.phones, entries);
  for (const key of ["phones", "emails"]) {
    assert.equal(parseContactPayload("contacts.record.v1", { ...record, contact: { ...record.contact,
      [key]: Array.from({ length: 1001 }, () => entries[0]) } }), null);
  }
});

test("parser rejects false baseline actions and unapproved fields", () => {
  assert.equal(parseContactPayload("contacts.record.v1", record)?.kind, "record");
  assert.equal(parseContactPayload("contacts.record.v1", { ...record, newly_observed: true }), null);
  assert.equal(parseContactPayload("contacts.record.v1", { ...record, contact: { ...record.contact, notes: "private" } }), null);
  assert.equal(parseContactPayload("contacts.record.v2", record), null);
  assert.equal(parseContactPayload("contacts.record.v1", { ...record, generation: 3 }), null);
  const incremental = { ...record, generation: 2, previous_generation: 1, scan_mode: "incremental", previous_observed_at: context.observed_at, newly_observed: true };
  assert.equal(parseContactPayload("contacts.record.v1", incremental)?.kind, "record");
  assert.equal(parseContactPayload("contacts.record.v1", { ...incremental, scan_mode: "resync" }), null);
  assert.equal("unexpected" in parseContactPayload("contacts.record.v1", { ...record, unexpected: "private" })!, false);
});

test("manifest requires all unique source records with matching context and digest", () => {
  const payload = parseContactPayload("contacts.record.v1", record) as ContactRecord;
  const manifest = parseContactPayload("contacts.scan.v1", { ...context, expected_event_count: 1, event_ids_sha256: contactManifestDigest([id]) }) as ContactManifest;
  assert.ok(manifest);
  assert.equal(verifyContactScan(manifest, [{ eventID: id, payload }]), true);
  assert.equal(verifyContactScan(manifest, []), false);
  assert.equal(verifyContactScan(manifest, [{ eventID: id, payload: { ...payload, authorization: "4" } }]), false);
  assert.equal(verifyContactScan({ ...manifest, expected_event_count: 2 }, [{ eventID: id, payload }, { eventID: id, payload }]), false);
});

test("empty scans complete and digest is order independent", () => {
  assert.equal(contactManifestDigest([]), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(contactManifestDigest(["b", "a"]), contactManifestDigest(["a", "b"]));
  const manifest = parseContactPayload("contacts.scan.v1", { ...context, expected_event_count: 0, event_ids_sha256: contactManifestDigest([]) }) as ContactManifest;
  assert.equal(verifyContactScan(manifest, []), true);
});

test("repair event types cannot be mixed with ordinary manifests or claim additions", () => {
  const repair = { ...record, generation: 3, previous_generation: 2, scan_mode: "resync", previous_observed_at: context.observed_at };
  const payload = parseContactPayload("contacts.repair_record.v1", repair) as ContactRecord;
  assert.equal(payload.repair, true);
  assert.equal(parseContactPayload("contacts.repair_record.v1", { ...repair, newly_observed: true }), null);
  assert.equal(parseContactPayload("contacts.repair_record.v1", { ...repair, scan_mode: "incremental" }), null);
  const manifestInput = { ...repair, expected_event_count: 1, event_ids_sha256: contactManifestDigest([id]) };
  const manifest = parseContactPayload("contacts.repair_scan.v1", manifestInput) as ContactManifest;
  assert.equal(verifyContactScan(manifest, [{ eventID: id, payload }]), true);
  const ordinary = parseContactPayload("contacts.record.v1", repair) as ContactRecord;
  assert.equal(verifyContactScan(manifest, [{ eventID: id, payload: ordinary }]), false);
  assert.equal(verifyContactScan(parseContactPayload("contacts.scan.v1", manifestInput) as ContactManifest, [{ eventID: id, payload }]), false);
});


test("expanded fields preserve international structure and keep v1 strict", () => {
  const address = { label: "自宅", street: "千代田1-1\n建物", city: "千代田区", sub_administrative_area: "", state: "東京都", postal_code: "100-0001", country: "日本", iso_country_code: "JP" };
  const fields = { ...record.contact, postal_addresses: [address], urls: [{ label: "profile", value: "https://example.invalid/contact" }] };
  assert.deepEqual(parseExpandedContactFields(fields), fields);
  assert.equal(parseContactPayload("contacts.record.v1", { ...record, contact: fields }), null);
  assert.deepEqual(parseExpandedContactFields({ ...fields, postal_addresses: [], urls: [] }), { ...fields, postal_addresses: [], urls: [] });
  for (const bad of [{ ...record.contact }, { ...fields, urls: null }, { ...fields, photos: [] }, { ...fields, notes: "private" },
    { ...fields, postal_addresses: [{ ...address, latitude: 1 }] }, { ...fields, urls: [{ value: "https://example.invalid" }] },
    { ...fields, postal_addresses: [{ ...address, street: "x".repeat(4097) }] },
    { ...fields, urls: Array.from({ length: 1001 }, () => fields.urls[0]) },
    { ...fields, postal_addresses: Array.from({ length: 1000 }, () => ({ ...address, street: "界".repeat(4096) })) }])
    assert.equal(parseExpandedContactFields(bad), null);
});


test("v2 parsing is opt-in, requires observed rich fields, and rejects mixed-version manifests", () => {
  const options = { allowExpanded: true };
  const rich = { ...record, payload_version: 2, contact: { ...record.contact, postal_addresses: [], urls: [] } };
  assert.equal(parseContactPayload("contacts.record.v2", rich), null, "no production processing before permission integration");
  const parsed = parseContactPayload("contacts.record.v2", rich, options) as ContactRecord;
  assert.equal(parsed.payload_version, 2);
  assert.deepEqual(parsed.contact, rich.contact);
  assert.equal(parseContactPayload("contacts.record.v2", { ...rich, contact: record.contact }, options), null);
  assert.equal(parseContactPayload("contacts.record.v1", rich, options), null);
  assert.equal(parseContactPayload("contacts.record.v2", record, options), null);
  assert.equal(parseContactPayload("contacts.record.v3", rich, options), null);
  const manifestInput = { ...context, payload_version: 2, expected_event_count: 1, event_ids_sha256: contactManifestDigest([id]) };
  const manifest = parseContactPayload("contacts.scan.v2", manifestInput, options) as ContactManifest;
  assert.equal(verifyContactScan(manifest, [{ eventID: id, payload: parsed }]), true);
  const legacy = parseContactPayload("contacts.record.v1", record) as ContactRecord;
  assert.equal(verifyContactScan(manifest, [{ eventID: id, payload: legacy }]), false);
  const legacyManifest = parseContactPayload("contacts.scan.v1", { ...manifestInput, payload_version: 1 }) as ContactManifest;
  assert.equal(verifyContactScan(legacyManifest, [{ eventID: id, payload: parsed }]), false);
  assert.equal(verifyContactScan(legacyManifest, [{ eventID: id, payload: legacy }]), true);
});

test("v2 incremental removals and repairs preserve existing action eligibility rules", () => {
  const options = { allowExpanded: true };
  const rich = { ...record, payload_version: 2, generation: 2, previous_generation: 1, previous_observed_at: context.observed_at,
    scan_mode: "incremental", contact: { ...record.contact, postal_addresses: [], urls: [] } };
  assert.equal(parseContactPayload("contacts.record.v2", { ...rich, newly_observed: true }, options)?.kind, "record");
  const { contact, ...removed } = rich;
  assert.equal(parseContactPayload("contacts.record.v2", { ...removed, change: "no_longer_visible" }, options)?.kind, "record");
  assert.equal(parseContactPayload("contacts.record.v2", { ...removed, change: "no_longer_visible", newly_observed: true }, options), null);
  const repair = { ...rich, scan_mode: "resync" };
  const parsed = parseContactPayload("contacts.repair_record.v2", repair, options) as ContactRecord;
  assert.equal(parsed.repair, true);
  assert.equal(parseContactPayload("contacts.repair_record.v2", { ...repair, newly_observed: true }, options), null);
  const manifest = parseContactPayload("contacts.repair_scan.v2", { ...repair, expected_event_count: 1, event_ids_sha256: contactManifestDigest([id]) }, options) as ContactManifest;
  assert.equal(verifyContactScan(manifest, [{ eventID: id, payload: parsed }]), true);
  assert.equal(verifyContactScan(manifest, [{ eventID: id, payload: { ...parsed, repair: undefined } }]), false);
});
