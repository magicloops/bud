import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../../config.js";
import { pool as servicePool } from "../../db/client.js";
import * as schema from "../../db/schema.js";
import { InvocationRepository } from "../../agent/invocation-repository.js";
import { subscribeInvocationChanges } from "../../agent/invocation-timing.js";
import { creationFingerprint, ThreadCreationRepository } from "./creation-repository.js";
import { CreateThreadSchema } from "./shared.js";

test("creation fingerprints preserve intent and ignore JSON key ordering", () => {
  assert.equal(creationFingerprint({ a: 1, b: { c: 2, d: 3 } }), creationFingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(creationFingerprint({}), creationFingerprint({ model: null }));
  assert.notEqual(creationFingerprint({ text: "a" }), creationFingerprint({ text: "b" }));
  assert.equal(CreateThreadSchema.safeParse({ bud_id: "bud", opening_message: { text: "a" } }).success, false);
  assert.equal(CreateThreadSchema.safeParse({ bud_id: "bud", creation_key: "k", opening_message: {
    text: "a", browser_viewport: { width: 100, height: 800 },
  } }).success, false);
});

test("atomic creation: race, current-state retry, owner isolation, rollback and deletion", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(config.databaseUrl).hostname));
  const pool = new Pool({ connectionString: config.databaseUrl, max: 6 });
  const database = drizzle(pool, { schema });
  const owners = [0, 1].map(() => `creation-test-${randomUUID()}`);
  const buds = owners.map(() => `bud-${randomUUID()}`);
  const notifications: string[][] = [];
  const unsubscribe = subscribeInvocationChanges(database, ids => notifications.push(ids));
  t.after(async () => {
    unsubscribe();
    try {
      await database.delete(schema.threadCreationReceiptTable).where(inArray(schema.threadCreationReceiptTable.createdByUserId, owners));
      await database.delete(schema.agentInvocationTable).where(inArray(schema.agentInvocationTable.createdByUserId, owners));
      await database.delete(schema.messageTable).where(inArray(schema.messageTable.createdByUserId, owners));
      await database.delete(schema.threadTable).where(inArray(schema.threadTable.createdByUserId, owners));
      await database.delete(schema.budTable).where(inArray(schema.budTable.budId, buds));
      await database.delete(schema.authUserTable).where(inArray(schema.authUserTable.id, owners));
    } finally { await pool.end(); await servicePool.end(); }
  });
  await database.insert(schema.authUserTable).values(owners.map(id => ({ id, name: "Creation fixture", email: `${id}@example.invalid`, emailVerified: false })));
  await database.insert(schema.budTable).values(owners.map((owner, i) => ({ budId: buds[i], name: "Fixture", os: "test", arch: "test", createdByUserId: owner, tenantId: "fixture-tenant" })));

  // Execute the exact generated SQL against isolated representative parents.
  await database.transaction(async tx => {
    const namespace = `creation_migration_${randomUUID().replaceAll("-", "")}`;
    await tx.execute(sql`create schema ${sql.identifier(namespace)}`);
    await tx.execute(sql`set local search_path to ${sql.identifier(namespace)}`);
    await tx.execute(sql`create table thread (thread_id uuid primary key)`);
    await tx.execute(sql`create table message (message_id uuid primary key)`);
    await tx.execute(sql`create table agent_invocation (id text primary key)`);
    const migration = await readFile(new URL("../../../drizzle/migrations/0048_lush_timeslip.sql", import.meta.url), "utf8");
    await tx.execute(sql.raw(migration.replaceAll('"public".', `"${namespace}".`)));
    await tx.execute(sql`drop schema ${sql.identifier(namespace)} cascade`);
  });

  const repo = new ThreadCreationRepository(database);
  const input = { owner: owners[0], budId: buds[0], key: "same-key", fingerprint: creationFingerprint({ text: "Hello" }) };
  const prepared = { title: "Opening", modelId: null, reasoningEffort: null,
    admission: { text: "Hello", model: "fixture", reasoningEffort: "none" } };
  let preparations = 0;
  const prepare = async () => { preparations++; return prepared; };
  await assert.rejects(repo.create({ ...input, owner: owners[1] }, prepare), /bud_not_found/);
  assert.equal(preparations, 0);
  const results = await Promise.all(Array.from({ length: 4 }, () => repo.create(input, prepare)));
  assert.equal(preparations, 1);
  assert.equal(results.filter(row => !row!.duplicate).length, 1);
  assert.equal(new Set(results.map(row => row!.thread.threadId)).size, 1);
  const first = results[0]!;
  assert.equal(notifications.length, 1, "only the committed admission publishes");
  for (const row of [first.thread, first.message, first.invocation]) {
    assert.equal(row.createdByUserId, owners[0]); assert.equal(row.tenantId, "fixture-tenant");
  }
  assert.equal(first.thread.messageCount, 1);
  await assert.rejects(repo.create({ ...input, fingerprint: creationFingerprint({ text: "Changed" }) }, prepare), /creation_key_conflict/);
  const other = await repo.create({ ...input, owner: owners[1], budId: buds[1] }, prepare);
  assert.notEqual(other!.thread.threadId, first.thread.threadId);
  const invocations = new InvocationRepository(database);
  const lease = await invocations.claim("creation-worker", owners[0]);
  assert.equal(lease?.id, first.invocation.id);
  await invocations.start(lease!);
  await invocations.finish(lease!, "succeeded", "completed");
  const noPreparation = async (): Promise<never> => { throw new Error("retry must not resolve defaults"); };
  const retry = await repo.create(input, noPreparation);
  assert.equal(retry!.invocation.status, "succeeded");
  assert.equal(retry!.message.messageId, first.message.messageId);

  for (const failTable of [schema.threadTable, schema.messageTable, schema.agentInvocationTable, schema.threadCreationReceiptTable]) {
    const failing = Object.create(database) as typeof database;
    failing.transaction = ((work: (tx: unknown) => Promise<unknown>) => database.transaction(async tx => work(new Proxy(tx, {
      get(target, key) {
        if (key === "insert") return (table: unknown) => {
          if (table === failTable) throw new Error("injected creation failure");
          return target.insert(table as typeof schema.threadTable);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    })))) as typeof database.transaction;
    const hints: string[][] = [];
    const stop = subscribeInvocationChanges(failing, ids => hints.push(ids));
    await assert.rejects(new ThreadCreationRepository(failing).create({ ...input, key: "rollback" }, prepare), /injected creation failure/);
    stop(); assert.deepEqual(hints, []);
    assert.equal((await database.select().from(schema.threadTable).where(eq(schema.threadTable.createdByUserId, owners[0]))).length, 1);
    assert.equal((await database.select().from(schema.messageTable).where(eq(schema.messageTable.createdByUserId, owners[0]))).length, 1);
    assert.equal((await database.select().from(schema.agentInvocationTable).where(eq(schema.agentInvocationTable.createdByUserId, owners[0]))).length, 1);
  }
  await database.update(schema.threadTable).set({ deletedAt: new Date() }).where(eq(schema.threadTable.threadId, first.thread.threadId));
  await assert.rejects(repo.create(input, noPreparation), /thread_not_found/);
  await database.delete(schema.agentInvocationTable).where(eq(schema.agentInvocationTable.id, first.invocation.id));
  await database.delete(schema.messageTable).where(eq(schema.messageTable.messageId, first.message.messageId));
  await database.delete(schema.threadTable).where(eq(schema.threadTable.threadId, first.thread.threadId));
  await assert.rejects(repo.create(input, noPreparation), /thread_not_found/);
  const [receipt] = await database.select().from(schema.threadCreationReceiptTable).where(eq(schema.threadCreationReceiptTable.createdByUserId, owners[0]));
  assert.equal(receipt.threadId, null); assert.equal(receipt.creationKey, input.key);
});
