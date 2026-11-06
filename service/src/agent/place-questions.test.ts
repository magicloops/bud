import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { pool as servicePool } from "../db/client.js";
import * as schema from "../db/schema.js";
import { Places } from "../personal-data/places.js";
import { acceptAgentQuestionResponse, createAgentQuestionRequest } from "./user-question-repository.js";
import { ASK_USER_QUESTIONS_RESPONSE_SCHEMA, normalizeAskUserQuestionsRequest } from "./user-question-contracts.js";

test("answering a place question saves the user's pin: a new place, or the asked-about place updated", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(config.databaseUrl).hostname));
  // Its own schema, for this test and the service pool the question repository uses.
  const isolated = "place_questions_" + randomUUID().replaceAll("-", "");
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${isolated},public` });
  servicePool.on("connect", client => { void client.query(`set search_path to "${isolated}", public`); });
  const db = drizzle(pool, { schema });
  const owner = `place-question-${randomUUID()}`;
  t.after(async () => {
    try {
      await pool.query(`drop schema if exists "${isolated}" cascade`);
      // Users live in the shared auth schema, outside the isolated one.
      await pool.query(`delete from auth."user" where id = any($1)`, [[owner]]);
    }
    finally { await pool.end(); await servicePool.end(); }
  });
  await pool.query(`create schema "${isolated}"`);
  for (const { tablename } of (await pool.query("select tablename from pg_tables where schemaname='public'")).rows) {
    assert.match(tablename, /^[a-zA-Z0-9_]+$/);
    await pool.query(`create table "${isolated}"."${tablename}" (like public."${tablename}" including all)`);
  }

  const threadId = randomUUID(), places = new Places(db);
  await db.insert(schema.authUserTable).values({ id: owner, name: "Fixture", email: `${owner}@example.invalid`, emailVerified: false });
  await db.insert(schema.budTable).values({ budId: "bud", name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
  await db.insert(schema.threadTable).values({ threadId, budId: "bud", createdByUserId: owner });
  const office = await places.create(owner, { name: "Office", latitude: 37.749033, longitude: -122.417815, radius_m: 50 }, "agent");
  await db.insert(schema.placePresenceTable).values({ placeId: office.id, createdByUserId: owner, state: "inside", since: new Date() });

  const ask = async (questions: unknown[]) => (await createAgentQuestionRequest({ threadId, turnId: randomUUID(), callId: randomUUID(),
    clientId: randomUUID(), request: normalizeAskUserQuestionsRequest({ questions }), ownerUserId: owner })).row.questionRequestId;
  const answer = (questionRequestId: string, answers: unknown[]) => acceptAgentQuestionResponse({ threadId, questionRequestId,
    answeredByUserId: owner, response: { schema: ASK_USER_QUESTIONS_RESPONSE_SCHEMA, client_response_id: randomUUID(), answers } });

  const asked = await ask([
    { question_id: "home", kind: "place", label: "Where's home?", place: { name: "Home", query: "3327 26th St, San Francisco" } },
    { question_id: "office", kind: "place", label: "Check the office pin", place: { name: "Office", place_id: office.id } },
  ]);
  const accepted = await answer(asked, [
    { question_id: "home", status: "answered", answer: { kind: "place", name: "Home", latitude: 37.749003, longitude: -122.416487, radius_m: 60 } },
    { question_id: "office", status: "answered", answer: { kind: "place", name: "Office", latitude: 37.74904, longitude: -122.4178, radius_m: 50 } },
  ]);
  const saved = await db.select().from(schema.placeTable);
  const home = saved.find(row => row.name === "Home")!;
  assert.deepEqual([home.latitude, home.longitude, home.radiusM, home.createdBy], [37.749003, -122.416487, 60, "user"], "saved as the user's place");
  const moved = saved.find(row => row.id === office.id)!;
  assert.deepEqual([moved.latitude, moved.longitude, moved.createdBy], [37.74904, -122.4178, "agent"]);
  assert.equal((await db.select().from(schema.placePresenceTable).where(eq(schema.placePresenceTable.placeId, office.id))).length, 0,
    "moving restarts presence");
  assert.deepEqual(accepted.toolResult.responses.map(row => [(row.answer as { place_id?: string }).place_id, (row.answer as { operation?: string }).operation]),
    [[home.id, "created"], [office.id, "updated"]]);

  // The same pin for a saved place changes nothing (its presence isn't restarted).
  await db.insert(schema.placePresenceTable).values({ placeId: office.id, createdByUserId: owner, state: "inside", since: new Date() });
  const again = await ask([{ question_id: "office", kind: "place", label: "Check the office pin", place: { name: "Office", place_id: office.id } }]);
  await answer(again, [{ question_id: "office", status: "answered", answer: { kind: "place", name: "Office", latitude: 37.74904, longitude: -122.4178, radius_m: 50 } }]);
  assert.equal((await db.select().from(schema.placePresenceTable).where(eq(schema.placePresenceTable.placeId, office.id))).length, 1);

  // A place deleted meanwhile refuses the whole answer: nothing is saved and the prompt stays.
  await places.delete(owner, office.id);
  const stale = await ask([
    { question_id: "gym", kind: "place", label: "Your gym", place: { name: "Gym" } },
    { question_id: "office", kind: "place", label: "Move the office", place: { name: "Office", place_id: office.id } },
  ]);
  await assert.rejects(answer(stale, [
    { question_id: "gym", status: "answered", answer: { kind: "place", name: "Gym", latitude: 37.76, longitude: -122.42, radius_m: 100 } },
    { question_id: "office", status: "answered", answer: { kind: "place", name: "Office", latitude: 37.75, longitude: -122.41, radius_m: 50 } },
  ]), { code: "place_not_found", statusCode: 409 });
  assert.equal((await db.select().from(schema.placeTable).where(eq(schema.placeTable.name, "Gym"))).length, 0);
  const [prompt] = await db.select().from(schema.agentQuestionRequestTable).where(eq(schema.agentQuestionRequestTable.questionRequestId, stale));
  assert.equal(prompt.status, "pending");
  // Skipping saves nothing.
  await answer(stale, [{ question_id: "gym", status: "skipped" }, { question_id: "office", status: "skipped" }]);
  assert.equal((await db.select().from(schema.placeTable).where(eq(schema.placeTable.name, "Gym"))).length, 0);

  // Phase 10: a place keeps the address the user gave. Blank clears it; an address change alone
  // keeps presence and the geometry; a move past 50 m without one drops it.
  const north = (metres: number) => 37.80 + metres / 111_195;
  const shop = await places.create(owner, { name: "Shop", latitude: north(0), longitude: -122.4, address: "  1 Main St  " }, "user");
  assert.equal(shop.address, "1 Main St");
  await assert.rejects(places.create(owner, { name: "Long", latitude: 1, longitude: 1, address: "x".repeat(301) }, "user"), { code: "invalid_place" });
  const [before] = await db.select().from(schema.placeTable).where(eq(schema.placeTable.id, shop.id));
  await db.insert(schema.placePresenceTable).values({ placeId: shop.id, createdByUserId: owner, state: "inside", since: new Date() });
  assert.equal((await places.update(owner, shop.id, { address: "1 Main Street" })).address, "1 Main Street");
  const [renamed] = await db.select().from(schema.placeTable).where(eq(schema.placeTable.id, shop.id));
  assert.equal(renamed.geometryChangedAt.getTime(), before.geometryChangedAt.getTime(), "an address change isn't a move");
  assert.equal((await db.select().from(schema.placePresenceTable).where(eq(schema.placePresenceTable.placeId, shop.id))).length, 1);
  assert.equal((await places.update(owner, shop.id, { latitude: north(30), longitude: -122.4 })).address, "1 Main Street", "30 m keeps it");
  assert.equal((await places.update(owner, shop.id, { latitude: north(110), longitude: -122.4 })).address, null, "80 m more drops it");
  assert.equal((await places.update(owner, shop.id, { latitude: north(300), longitude: -122.4, address: "9 Far St" })).address, "9 Far St",
    "a move that sends an address keeps it");
  assert.equal((await places.update(owner, shop.id, { address: "" })).address, null, "blank clears it");

  // A place answer saves the address the user accepted, and shows it.
  const named = await ask([{ question_id: "cafe", kind: "place", label: "Your café", place: { name: "Café", query: "500 Valencia St" } },
    { question_id: "shop", kind: "place", label: "Move the shop", place: { name: "Shop", place_id: shop.id } }]);
  const withAddress = await answer(named, [
    { question_id: "cafe", status: "answered", answer: { kind: "place", name: "Café", latitude: 37.76, longitude: -122.42, radius_m: 50, address: "500 Valencia St, San Francisco" } },
    { question_id: "shop", status: "answered", answer: { kind: "place", name: "Shop", latitude: north(300), longitude: -122.4, radius_m: 100, address: "9 Far Street" } },
  ]);
  const cafe = (await db.select().from(schema.placeTable).where(eq(schema.placeTable.name, "Café")))[0];
  assert.equal(cafe.address, "500 Valencia St, San Francisco");
  assert.equal((await db.select().from(schema.placeTable).where(eq(schema.placeTable.id, shop.id)))[0].address, "9 Far Street");
  assert.match(withAddress.toolResult.responses[0].display_answer!, /^Saved Café, 500 Valencia St, San Francisco, at 37\.760000/);
  // Moving it without an address in the answer clears the old one (the editor dropped it).
  const movedAgain = await ask([{ question_id: "shop", kind: "place", label: "Move the shop", place: { name: "Shop", place_id: shop.id } }]);
  await answer(movedAgain, [{ question_id: "shop", status: "answered", answer: { kind: "place", name: "Shop", latitude: north(600), longitude: -122.4, radius_m: 100 } }]);
  assert.equal((await db.select().from(schema.placeTable).where(eq(schema.placeTable.id, shop.id)))[0].address, null);
});
