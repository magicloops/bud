import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CALENDAR_TOOLS } from "./calendar.js";
import { GoogleOAuth } from "./oauth.js";
import { googleFixture } from "./test-fixture.js";
import { calendarGranted, GoogleHttpError } from "./config.js";
import { decryptGoogleCredentials, encryptGoogleCredentials } from "./credentials.js";
import { googleFetch, googleJson } from "./http.js";

test("real Google OAuth SDK produces PKCE, exchanges a code, resolves identity and refreshes", async () => {
  const fixture = googleFixture(), oauth = new GoogleOAuth(fixture.config, fixture.fetcher);
  const flow = await oauth.authorize("fixture-state"), url = new URL(flow.url);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("state"), "fixture-state");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.ok(!url.searchParams.get("scope")!.includes("gmail"));
  fixture.authorize(flow.url, "alice");
  const grant = await oauth.exchange("alice", flow.verifier, new AbortController().signal);
  assert.equal(grant.email, "alice@example.com"); assert.ok(calendarGranted(grant.scopes));
  const refreshed = await oauth.refresh(grant.tokens, new AbortController().signal);
  assert.equal(refreshed.refresh_token, "refresh-alice"); assert.equal(fixture.refreshCount, 1);
});

test("encrypted Google credentials bind owner, row and client", () => {
  const key = randomBytes(32), value = { tokens: { access_token: "private-token" } };
  const encrypted = encryptGoogleCredentials(value, "alice:row:client", key);
  assert.ok(!encrypted.includes("private-token"));
  assert.deepEqual(decryptGoogleCredentials(encrypted, "alice:row:client", key), value);
  for (const aad of ["bob:row:client", "alice:other:client", "alice:row:other"]) {
    assert.throws(() => decryptGoogleCredentials(encrypted, aad, key), /google_credentials_unreadable/);
  }
});

test("Calendar validates boundaries, preserves paging and patches only requested fields", () => {
  const prepare = (name: string, args: unknown) => CALENDAR_TOOLS.find(tool => tool.name === name)!.prepare(args, "operation");
  const event = { summary: "Test", start: { date_time: "2030-11-13T15:00:00-08:00", time_zone: "America/Los_Angeles" },
    end: { date_time: "2030-11-13T15:15:00-08:00", time_zone: "America/Los_Angeles" } };
  const create = prepare("calendar_create_event", { calendar_id: "primary", event });
  assert.equal(create.query?.sendUpdates, "none");
  assert.match((create.body as { id: string }).id, /^[a-f0-9]{64}$/);
  assert.deepEqual(create, prepare("calendar_create_event", { calendar_id: "primary", event }));
  assert.throws(() => prepare("calendar_create_event", { calendar_id: "primary", event: { ...event, end: event.start } }));
  assert.throws(() => prepare("calendar_create_event", { calendar_id: "primary", event: { ...event, start: { date_time: "2030-11-13T15:00:00" } } }));
  assert.throws(() => prepare("calendar_create_event", { calendar_id: "primary", event: { ...event, start: { date: "2030-02-31" } } }));
  assert.throws(() => prepare("calendar_update_event", { calendar_id: "primary", event_id: "event", expected_etag: '"old"', changes: {} }));
  const update = prepare("calendar_update_event", { calendar_id: "primary", event_id: "event", expected_etag: '"old"', changes: { summary: "New" } });
  assert.equal(update.etag, '"old"'); assert.equal(JSON.stringify(update.body), '{"summary":"New"}');
  const list = prepare("calendar_list_events", { calendar_id: "primary", time_min: "2030-01-01T00:00:00Z", time_max: "2030-01-02T00:00:00Z", page_token: "next", max_results: 2 });
  assert.equal(list.query?.pageToken, "next"); assert.equal(list.query?.maxResults, 2);
  assert.throws(() => prepare("calendar_get_event", { calendar_id: "primary", event_id: "event", token: "untrusted" }));
});

test("Google network transport refuses external URLs, redirects and excess bytes; never retries writes", async () => {
  let count = 0;
  const bounded = googleFetch(async () => { count++; return Response.json({ ok: true }); });
  await assert.rejects(bounded("https://attacker.example"), /google_destination_denied/); assert.equal(count, 0);
  await assert.rejects(googleFetch(async () => new Response(null, { status: 302 }))("https://oauth2.googleapis.com/token"), /google_redirect_denied/);
  const large = await googleFetch(async () => new Response("x".repeat(1024 * 1024 + 1)))("https://oauth2.googleapis.com/token");
  await assert.rejects(large.text(), /google_response_too_large/);
  const fixture = googleFixture(); fixture.loseReply();
  await assert.rejects(googleJson(googleFetch(fixture.fetcher), "https://www.googleapis.com/calendar/v3/calendars/primary/events", "alice", { method: "POST", body: "{}" }));
  assert.equal(fixture.calls.length, 1);
});

test("disabled Calendar API is distinguished from denied access without exposing provider error data", async () => {
  const url = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
  const cases = [
    [{ error: { errors: [{ reason: "accessNotConfigured", message: "private provider text" }] } }, "google_api_disabled"],
    [{ error: { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", metadata: { private: "private provider text" } }] } }, "google_api_disabled"],
    [{ error: { errors: [{ reason: "insufficientPermissions" }], message: "SERVICE_DISABLED" } }, "google_access_denied"],
    [{ error: { errors: "SERVICE_DISABLED", details: [null, "SERVICE_DISABLED", {}] } }, "google_access_denied"],
    [null, "google_access_denied"],
  ] as const;
  for (const [body, code] of cases) {
    await assert.rejects(googleJson(googleFetch(async () => Response.json(body, { status: 403 })), url, "fixture-token"), error => {
      assert.ok(error instanceof GoogleHttpError);
      assert.equal(error.status, 403); assert.equal(error.code, code);
      assert.doesNotMatch(JSON.stringify(error), /private provider text|fixture-token/);
      return true;
    });
  }
  // An unreadable body must still preserve a definite HTTP rejection.
  for (const text of ["not JSON", "x".repeat(1024 * 1024 + 1)]) {
    await assert.rejects(googleJson(googleFetch(async () => new Response(text, { status: 403 })), url, "fixture-token"),
      error => error instanceof GoogleHttpError && error.status === 403 && error.code === "google_access_denied");
  }
});
