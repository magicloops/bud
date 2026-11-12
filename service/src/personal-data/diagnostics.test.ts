import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import Fastify from "fastify";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { DailyDiagnosticsBudget, DeviceDiagnostics, fieldValue, parseDiagnostics, type ParsedDiagnostics } from "./diagnostics.js";
import { registerPersonalDataRoutes } from "./routes.js";

const now = new Date("2026-11-06T22:40:00Z");
const launch = "7d3e2f10-aa11-4b22-8c33-d44e55f66a77";
const journal = "4c0ffee0-0000-4000-8000-00000000a001";
const header = { type: "header", format: "bud.diagnostics.v1", journal, app_version: "1.0", build: "412", bundle_id: "chat.bud.app.local",
  os: "iOS 26.1", device: "iPhone17,1", environment: "local-https" };
const entry = (seq: number, fields: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ type: "entry", seq,
  at: "2026-11-06T12:19:51.812-08:00", uptime: 81234.5, launch, state: "background", area: "upload", level: "notice",
  event: "upload.handed_off", fields, ...extra });
const lines = (...rows: object[]) => Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");

test("diagnostics batches keep the phone's field rules: free text never gets stored", async () => {
  const batch = await parseDiagnostics(gzipSync(lines(header,
    { type: "launch", id: launch, at: "2026-11-06T12:18:38.100-08:00", reason: "location", app_version: "1.0", build: "412" },
    entry(1840, { batch: "6F2A9C11-1D2B-4C3D-8E4F-A1B2C3D4E5F6", cause: "connect_failed", error: "nsurlerrordomain:-1005", elapsed_ms: 812,
      cellular: true, route: "/api/threads/:id/turns", deadline: "2026-11-06T20:19:51Z", batches: "6F2A9C11-1D2B,0A1B2C3D-4E5F",
      // A modified client: content in place of tokens.
      place: "3327 26th Street", note: "Hello Ada", coordinate: "37.7749,-122.4194", nested: { a: 1 }, nan: null, "Bad Key": "x" }),
    entry(1841, {}, { event: "Not An Event" }),
    entry(1842, {}, { at: "2026-09-01T00:00:00Z" }),
    { type: "mystery" },
    entry(1843))), "gzip", now);
  assert.deepEqual(batch.header, { journalId: journal, appVersion: "1.0", build: "412", os: "iOS 26.1", device: "iPhone17,1", bundleId: "chat.bud.app.local",
    environment: "local-https" });
  assert.deepEqual(batch.launches.map(l => [l.id, l.reason, l.device]), [[launch, "location", "iPhone17,1"]]);
  assert.deepEqual(batch.entries.map(e => e.seq), [1840, 1843]);
  assert.equal(batch.rejected, 3, "a bad event name, a stale entry and an unknown line");
  assert.equal(batch.maxSeq, 1843, "rejected entries are still acknowledged");
  assert.deepEqual(batch.entries[0].fields, { batch: "6F2A9C11-1D2B-4C3D-8E4F-A1B2C3D4E5F6", cause: "connect_failed",
    error: "nsurlerrordomain:-1005", elapsed_ms: 812, cellular: true, route: "/api/threads/:id/turns", deadline: "2026-11-06T20:19:51Z",
    batches: "6F2A9C11-1D2B,0A1B2C3D-4E5F", place: "invalid", note: "invalid", coordinate: "invalid", nested: "invalid" });
  assert.equal(batch.entries[0].level, 2);
  for (const text of ["ada@example.com", "4158247877", "https://bud.dev/x", "Taquería", "x".repeat(129)]) assert.equal(fieldValue(text), "invalid", text);

  await assert.rejects(parseDiagnostics(lines(entry(1)), "", now), { code: "invalid_header" });
  await assert.rejects(parseDiagnostics(lines({ ...header, format: "v0" }), "", now), { code: "invalid_header" });
  await assert.rejects(parseDiagnostics(lines({ ...header, journal: "my journal" }), "", now), { code: "invalid_header" });
  await assert.rejects(parseDiagnostics(Buffer.from("not gzip"), "gzip", now), { code: "invalid_gzip" });
  await assert.rejects(parseDiagnostics(lines(header, ...Array.from({ length: 1001 }, (_, i) => entry(i + 1))), "", now),
    { code: "payload_too_large" });
  assert.deepEqual(await parseDiagnostics(lines(header), "", now).then(b => [b.entries.length, b.maxSeq]), [0, null]);
});

test("the phone's upload lines parse as sent (the fixture bud-mobile's DiagnosticsJournalTests writes)", async () => {
  const { readFile } = await import("node:fs/promises");
  const body = await readFile(new URL("./fixtures/diagnostics-upload-v1.jsonl", import.meta.url));
  const batch = await parseDiagnostics(body, "", new Date("2026-11-06T22:00:00Z"));
  assert.equal(batch.header.journalId, "4c0ffee0-0000-4000-8000-00000000a001");
  assert.deepEqual(batch.launches.map(l => [l.id, l.reason, l.build, l.device]), [["7d3e2f10-aa11-4b22-8c33-d44e55f66a77", "location", "412", "iPhone17,1"]]);
  assert.equal(batch.rejected, 0);
  assert.deepEqual(batch.entries.map(e => [e.seq, e.area, e.event, e.level, e.uptime, e.appState]),
    [[1840, "upload", "upload.handed_off", 2, 81234.5, "background"]]);
  assert.deepEqual(batch.entries[0].fields, { batch: "6F2A9C11-1D2B-4C3D-8E4F-A1B2C3D4E5F6", cause: "connect_failed",
    error: "nsurlerrordomain:-1005", elapsed_ms: 812, cellular: true });
  assert.equal(batch.entries[0].at.toISOString(), "2026-11-06T21:20:00.250Z");
});

test("the daily budget is per installation and resets each UTC day", () => {
  let clock = new Date("2026-11-06T23:59:00Z");
  const budget = new DailyDiagnosticsBudget(10, () => clock);
  assert.deepEqual([budget.take("a", 6), budget.take("a", 5), budget.take("b", 10), budget.take("a", 4)], [true, false, true, true]);
  clock = new Date("2026-11-07T00:00:01Z");
  assert.equal(budget.take("a", 10), true);
});

test("diagnostics routes: auth, idempotent acknowledgement, busy, daily limit and delete", async t => {
  const stored: ParsedDiagnostics[] = [];
  const deletes: string[] = [];
  const app = Fastify();
  t.after(() => app.close());
  await registerPersonalDataRoutes(app, {
    authenticate: async request => request.headers.authorization === "Bearer phone" ? { userId: "owner-a" } : null,
    repository: { persist: async () => { throw new Error("unused"); }, status: async () => ({}) },
    deviceDiagnostics: { store: async (_owner, _installation, batch) => { stored.push(batch); return stored.length === 1 ? batch.entries.length : 0; },
      delete: async (owner, installation) => { deletes.push(`${owner}/${installation}`); return 3; } },
    diagnosticsBudget: new DailyDiagnosticsBudget(3),
  });
  const headers = { authorization: "Bearer phone", "content-type": "application/x-ndjson", "content-encoding": "gzip", "x-installation-id": "phone-a" };
  const payload = gzipSync(lines(header, { ...entry(7), at: new Date().toISOString() }, { ...entry(8), at: new Date().toISOString() }));
  assert.equal((await app.inject({ method: "POST", url: "/v1/diagnostics/batches", headers: { ...headers, authorization: "Bearer x" }, payload })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/v1/diagnostics/batches", headers: { ...headers, "x-installation-id": "" }, payload })).statusCode, 400);
  const first = await app.inject({ method: "POST", url: "/v1/diagnostics/batches", headers, payload });
  assert.equal(first.statusCode, 200);
  assert.deepEqual([first.json().acked_through_seq, first.json().accepted, first.json().duplicates], [8, 2, 0]);
  // A retry: already stored, still acknowledged. Then the day's budget (3) runs out.
  const retry = await app.inject({ method: "POST", url: "/v1/diagnostics/batches", headers, payload });
  assert.equal(retry.statusCode, 429);
  assert.equal(retry.json().error, "daily_limit");
  assert.ok(retry.json().retry_after_s >= 60);
  const removed = await app.inject({ method: "DELETE", url: "/v1/diagnostics", headers: { authorization: "Bearer phone", "x-installation-id": "phone-a" } });
  assert.deepEqual([removed.statusCode, removed.json(), deletes], [200, { deleted: 3 }, ["owner-a/phone-a"]]);
});

test("diagnostics storage is idempotent by seq, fills an unknown launch reason, and deletes by installation", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `device_diagnostics_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}` });
  t.after(async () => {
    await pool.end();
    try { await admin.query(`drop schema if exists "${namespace}" cascade`); } finally { await admin.end(); }
  });
  await admin.query(`create schema "${namespace}"`);
  for (const table of ["device_diagnostic_entry", "device_diagnostic_launch"])
    await admin.query(`create table "${namespace}"."${table}" (like public."${table}" including all)`);
  const store = new DeviceDiagnostics(drizzle(pool, { schema: s }));
  const at = new Date().toISOString();
  const batch = async (reason: string, seqs: number[]) => parseDiagnostics(lines(header,
    { type: "launch", id: launch, at, reason }, ...seqs.map(seq => ({ ...entry(seq, { batch: "6F2A9C11-1D2B" }), at }))), "");
  assert.equal(await store.store("owner-a", "phone-a", await batch("unknown", [1, 2])), 2);
  assert.equal(await store.store("owner-a", "phone-a", await batch("location", [2, 3])), 1, "seq 2 was already stored");
  assert.equal(await store.store("owner-a", "phone-b", await batch("user", [1])), 1, "another installation's seq 1");
  // A reinstall keeps the installation ID but starts a new journal, whose seq 1 is new.
  const reinstalled = await batch("user", [1]);
  assert.equal(await store.store("owner-a", "phone-b", { ...reinstalled, header: { ...reinstalled.header, journalId: "4c0ffee0-0000-4000-8000-00000000b002" } }), 1);
  const rows = (await pool.query("select installation_id, seq, fields from device_diagnostic_entry order by installation_id, seq")).rows;
  assert.deepEqual(rows.map(row => [row.installation_id, Number(row.seq)]), [["phone-a", 1], ["phone-a", 2], ["phone-a", 3], ["phone-b", 1], ["phone-b", 1]]);
  assert.deepEqual(rows[0].fields, { batch: "6F2A9C11-1D2B" });
  const found = await pool.query(`select count(*)::int as n from device_diagnostic_entry where fields @> '{"batch": "6F2A9C11-1D2B"}'`);
  assert.equal(found.rows[0].n, 5, "the fields index answers containment lookups");
  assert.deepEqual((await pool.query("select installation_id, reason from device_diagnostic_launch order by installation_id")).rows
    .map(row => [row.installation_id, row.reason]), [["phone-a", "location"], ["phone-b", "user"]], "an unknown reason is filled in once");
  assert.equal(await store.delete("owner-a", "phone-a"), 3);
  assert.deepEqual((await pool.query("select installation_id from device_diagnostic_entry")).rows.map(row => row.installation_id), ["phone-b", "phone-b"]);
  assert.equal((await pool.query("select count(*)::int as n from device_diagnostic_launch where installation_id = 'phone-a'")).rows[0].n, 0);
});

test("the report: timeline by launch with gaps, errors with context, and a summary", async () => {
  const { timeline, errors, summary } = await import("./diagnostics-report.js");
  const at = (time: string) => new Date(`2026-11-06T${time}-08:00`);
  const row = (seq: number, time: string, area: string, level: number, event: string, fields: Record<string, unknown> = {}, launchId = launch) =>
    ({ seq, launchId, at: at(time), appState: "background", area, level, event, fields });
  const rows = [row(1, "12:18:38.200", "location", 2, "geofence.report", { transition: "entered" }),
    row(2, "12:19:51.812", "upload", 2, "upload.handed_off", { cause: "connect_failed" }),
    row(3, "12:19:51.820", "upload", 3, "upload.failed", { error: "nsurlerrordomain:-1001" }),
    row(4, "14:15:27.000", "sync", 1, "sync.skipped", { reason: "in_flight" })];
  const known = [{ id: launch, at: at("12:18:38.100"), reason: "location", build: "412", appVersion: "1.0" }];
  const tz = "America/Los_Angeles";
  assert.equal(timeline(rows, known, tz), [
    "── launch 7d3e2f10 at 2026-11-06 12:18:38 reason=location build=412",
    "12:18:38.200 notice ba location           geofence.report transition=entered",
    "   … 0:01:14 with nothing logged",
    "12:19:51.812 notice ba upload             upload.handed_off cause=connect_failed",
    "12:19:51.820 error  ba upload             upload.failed error=nsurlerrordomain:-1001",
    "   … 1:55:35 with nothing logged",
    "14:15:27.000 info   ba sync               sync.skipped reason=in_flight"].join("\n"));
  assert.match(errors(rows, known, tz, 1), / {3}12:19:51\.812 .*upload\.handed_off[\s\S]* ▶ 12:19:51\.820 error/);
  const text = summary(rows, known, tz);
  assert.match(text, /^4 entries, 1 launches/);
  assert.match(text, /entries by level: {3}info=1, notice=2, error=1/);
  assert.match(text, /1:55:35 {2}12:19:51 upload\.failed → 14:15:27 sync\.skipped/);
  assert.equal(timeline([], known, tz), "No entries.");
});
