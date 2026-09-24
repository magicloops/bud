import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool, type PoolClient} from 'pg';
import {config} from '../config.js';
import {BrowserStateEvents, type BrowserStateHint} from './state-events.js';

test('committed changes reach separate service listeners; rollback and sequence/heartbeat writes stay quiet', {
  skip: process.env.BUD_DATA_DB_TEST !== '1',
}, async t => {
  assert.ok(['localhost','127.0.0.1'].includes(new URL(config.databaseUrl).hostname));
  const schema = `browser_state_${randomUUID().replaceAll('-','')}`;
  const options = {connectionString:config.databaseUrl, options:`-c search_path=${schema}`, max:4};
  const writer = new Pool(options), reader = new Pool(options), second = new Pool(options);
  let listenerClient: PoolClient | undefined;
  reader.on('connect', client => { listenerClient = client; });
  const events = new BrowserStateEvents(reader), other = new BrowserStateEvents(second);
  t.after(async () => {
    await events.close(); await other.close(); await reader.end(); await second.end();
    await writer.query(`drop schema ${schema} cascade`); await writer.end();
  });
  await writer.query(`create schema ${schema}`);
  // Minimal rows exercise the exact trigger SQL independently of application emitters.
  for (const table of ['bud','thread','browser_resource','browser_session','browser_handoff'])
    await writer.query(`create table ${table}(bud_id text, thread_id text, created_by_user_id text,
      state text, status text, control_state text, revision int, sequence int, last_seen_at timestamptz)`);
  await writer.query(await readFile(new URL('../../drizzle/migrations/0042_browser_state_notifications.sql',import.meta.url),'utf8'));
  await events.ready(); await other.ready();
  const seen:BrowserStateHint[] = [], remote:BrowserStateHint[] = [];
  let losses = 0;
  events.subscribe(h => seen.push(h), () => { losses++; }); other.subscribe(h => remote.push(h), () => {});
  const c = await writer.connect();
  await c.query('begin');
  await c.query("insert into browser_session values('bud','thread','alice','ready')");
  await delay(30); assert.equal(seen.length,0);
  await c.query('commit');
  for (let n=0; n<50 && !seen.length; n++) await delay(10);
  assert.equal(seen.length,1); assert.deepEqual(remote,seen);
  assert.equal(seen[0].thread_id,'thread');
  await c.query('begin');
  await c.query("update browser_session set state='closed'");
  await c.query('rollback');
  await c.query('update browser_session set sequence=2,last_seen_at=now()');
  await delay(40); assert.equal(seen.length,1);
  await c.query("insert into browser_resource values('bud',null,'alice',null,null,'paused',1)");
  for (let n=0;n<50 && seen.length<2;n++) await delay(10);
  assert.equal(seen[1].thread_id,null,'resource transitions reach all threads');
  await c.query("update browser_session set created_by_user_id='bob'");
  for (let n=0;n<50 && seen.length<3;n++) await delay(10);
  assert.equal(seen.length,3,'owner changes invalidate without leaking identity');
  assert.equal(JSON.stringify(seen).includes('alice'),false);
  const pid = (await listenerClient!.query('select pg_backend_pid() pid')).rows[0].pid;
  await c.query('select pg_terminate_backend($1)', [pid]);
  for (let n=0;n<50 && !losses;n++) await delay(10);
  assert.equal(losses,1,'listener loss invalidates attached viewers');
  await events.ready();
  await c.query("update browser_session set state='closed'");
  for (let n=0;n<50 && seen.length<4;n++) await delay(10);
  assert.equal(seen.length,4,'a new LISTEN connection receives subsequent commits');
  c.release();
});
