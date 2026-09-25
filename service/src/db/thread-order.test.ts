import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { config } from '../config.js';

test('conversation ordering backfill, atomic promotion, replay and notification filtering', {
  skip: process.env.BUD_DATA_DB_TEST !== '1',
}, async t => {
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(config.databaseUrl).hostname));
  const schema = `thread_order_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema}`, max: 2 });
  await pool.query(`create schema ${schema}`);
  const writer = await pool.connect(), reader = await pool.connect();
  t.after(async () => {
    reader.release(); writer.release();
    await pool.query(`drop schema ${schema} cascade`); await pool.end();
  });
  await writer.query(`create table thread(thread_id text primary key, bud_id text, created_by_user_id text,
    title text, deleted_at timestamptz, created_at timestamptz default now(), last_activity_at timestamptz);
    create table message(message_id text primary key, thread_id text, role text, metadata jsonb, created_at timestamptz);
    insert into thread(thread_id,bud_id,created_at) values ('a','bud','2026-01-01'),('b','bud','2026-01-01');
    insert into message values ('u','a','user',null,'2026-01-02'),('c','a','assistant','{"segment_kind":"commentary"}','2026-01-05'),
      ('f','b','assistant','{"segment_kind":"final"}','2026-01-03');`);
  await writer.query(await readFile(new URL('../../drizzle/migrations/0043_tired_mauler.sql', import.meta.url), 'utf8'));
  const order = async () => (await writer.query(`select thread_id from thread order by date_trunc('milliseconds', last_conversation_at) desc, date_trunc('milliseconds', created_at) desc, thread_id desc`)).rows.map(r => r.thread_id);
  assert.deepEqual(await order(), ['b', 'a']);
  const hints: string[] = [];
  reader.on('notification', n => hints.push(n.payload!));
  await reader.query('listen bud_thread_list');
  await writer.query(`insert into message values ('t','a','tool',null,'2026-01-06');
    update thread set last_activity_at=now();`);
  await delay(30); assert.equal(hints.length, 0);
  await writer.query('begin');
  await writer.query(`insert into message values ('next','a','assistant','{"segment_kind":"final"}','2026-01-07')`);
  await delay(30); assert.equal(hints.length, 0, 'no uncommitted notification');
  await writer.query('rollback');
  assert.deepEqual(await order(), ['b', 'a']);
  await writer.query(`insert into message values ('next','a','assistant','{"segment_kind":"final"}','2026-01-07')`);
  for (let i=0;i<50 && !hints.length;i++) await delay(10);
  assert.equal(hints.length, 1);
  assert.deepEqual(JSON.parse(hints[0]), {schema, bud_id: 'bud'});
  assert.deepEqual(await order(), ['a', 'b']);
  await writer.query(`insert into message values ('next','a','user',null,'2026-01-10') on conflict do nothing;
    insert into message values ('late','a','user',null,'2026-01-04');`);
  await delay(30); assert.equal(hints.length, 1, 'duplicates and delayed messages do not promote');
  await writer.query(`insert into message values ('new-user','b','user',null,'2026-01-07')`);
  assert.deepEqual(await order(), ['b', 'a'], 'equal timestamps use deterministic ID tie-break');
});
