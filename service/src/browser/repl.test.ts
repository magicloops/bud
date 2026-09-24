import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../config.js';
import * as schema from '../db/schema.js';
import { InvocationRepository } from '../agent/invocation-repository.js';
import { BrowserRepository } from './repository.js';
import { BrowserBroker } from './broker.js';
import { BrowserControl } from './control.js';
import { sessions, type SessionTracker } from '../ws/session-trackers.js';
import { decodeBudFrame } from '../proto/wire.js';
import { receiveBrowserResult, type BrowserCommand } from './transport.js';
import type { BrowserBackendResult } from '../agent/browser-tool-executor.js';

test('cell receipts preserve one dispatch across retries, lost acknowledgements and authority changes',
  { skip: process.env.BUD_DATA_DB_TEST !== '1' }, async t => {
  assert.ok(['localhost','127.0.0.1'].includes(new URL(config.databaseUrl).hostname));
  const name = `browser_repl_${randomUUID().replaceAll('-','')}`;
  const pool = new Pool({connectionString:config.databaseUrl,max:4,options:`-c search_path=${name}`});
  const budId = randomUUID(), thread = randomUUID();
  t.after(async () => { sessions.delete(budId); await pool.query(`drop schema ${name} cascade`); await pool.end(); });
  await pool.query(`create schema ${name}`);
  for (const {tablename} of (await pool.query("select tablename from pg_tables where schemaname='public'")).rows) {
    if (/^[a-z_]+$/.test(tablename)) await pool.query(`create table ${name}.${tablename} (like public.${tablename} including all)`);
  }
  const database = drizzle(pool,{schema}), invocations = new InvocationRepository(database);
  await database.insert(schema.budTable).values({budId,name:'Fixture',os:'test',arch:'test',createdByUserId:'alice'});
  await database.insert(schema.threadTable).values({threadId:thread,budId,createdByUserId:'alice'});
  await invocations.admit({owner:'alice',threadId:thread,origin:'human',idempotencyKey:thread,text:'Fixture',model:'fixture',reasoningEffort:'none'});
  const lease = await invocations.claim('worker','alice'); assert.ok(lease); await invocations.start(lease);
  const base = {budId,threadId:thread,ownerUserId:'alice',turnId:lease.turnId,
    invocation:{id:lease.id,fence:lease.fence,workerId:lease.workerId!},signal:new AbortController().signal};
  const context = async (kind='browser_exec') => {
    const callId=randomUUID(); await invocations.recordAction(lease,callId,kind); return {...base,callId};
  };
  const repository = new BrowserRepository(pool);
  const open = await repository.prepare(await context('browser_open'),'boot',{action:'open'});
  await repository.complete(open,{ok:true,outcome:'completed'});
  const receipt = async (callId:string) => (await pool.query('select evidence from agent_invocation_action where invocation_id=$1 and call_id=$2',[lease.id,callId])).rows[0].evidence.browser_cell;
  const healthy = async () => assert.equal((await pool.query('select state from browser_session where id=$1',[open.session_id])).rows[0].state,'ready');
  const success: BrowserBackendResult = {ok:true,outcome:'completed',data:{execution_state:'completed',text:'1\n',runtime_generation:'heap',truncated:false}};
  const sent: BrowserCommand[] = [];
  let reply: BrowserBackendResult | null = success;
  let onSend: (()=>void) | undefined;
  const tracker = {budId,sessionId:'device',browserCapability:{version:1,available:true,boot_id:'boot',managed:true,
    profile_mode:'persistent',semantic_observations:true,handoff:true,repl:true},socket:{readyState:1,OPEN:1,send(bytes:Buffer) {
      const frame=decodeBudFrame(bytes) as any;
      if(frame.request.command.action==='cancel') return;
      sent.push(frame.request); onSend?.();
      if(reply) queueMicrotask(()=>receiveBrowserResult(tracker,{browser_version:1,result:{...frame.request,...reply}}));
    }}} as unknown as SessionTracker;
  sessions.set(budId,tracker);
  const control={async ensure(){return {runtime_replaced:false};}} as unknown as BrowserControl;
  const broker=()=>new BrowserBroker(new BrowserRepository(pool),control);
  const first=await context();
  assert.equal((await broker().executeCell(first,'var n=0; console.log(++n)')).ok,true);
  await invocations.completeAction(lease,first.callId,{summary:'stored by executor'});
  assert.equal((await receipt(first.callId)).result.data.text,'1\n');
  assert.deepEqual((await receipt(first.callId)).request.command,{action:'exec'},'receipt must not duplicate source');
  assert.equal((await broker().executeCell(first,'var n=0; console.log(++n)')).data?.text,'1\n');
  assert.equal(sent.length,1,'new broker/repository must return receipt without redispatch');
  sessions.delete(budId);
  assert.equal((await broker().executeCell(first,'var n=0; console.log(++n)')).data?.text,'1\n','offline retry still returns completed receipt');
  assert.equal((await broker().executeCell(await context(),'n++')).error,'browser_unavailable');
  sessions.set(budId,tracker);
  assert.equal((await broker().executeCell(first,'n++')).error,'browser_cell_conflict');
  for(const invalid of [{ownerUserId:'bob'},{threadId:randomUUID()},{invocation:{...base.invocation,fence:99}},{invocation:{...base.invocation,workerId:'other'}}])
    assert.equal((await broker().executeCell({...first,...invalid},'var n=0; console.log(++n)')).ok,false);
  assert.equal(sent.length,1);

  // Two callers racing the same action cannot execute the code twice.
  reply=null; let accepted!:()=>void; const ready=new Promise<void>(r=>accepted=r); onSend=accepted;
  const racing=await context(); const running=broker().executeCell(racing,'n++'); await ready; onSend=undefined;
  assert.equal((await broker().executeCell(racing,'n++')).data?.execution_state,'unknown');
  assert.equal(sent.length,2);
  receiveBrowserResult(tracker,{browser_version:1,result:{...sent.at(-1),...success}});
  assert.equal((await running).ok,true);

  // A crash after recording dispatch but before an acknowledgement is ambiguous,
  // including after daemon restart. Never reconstruct/resend the saved code.
  const lost=await context(); const pending=await repository.prepare(lost,'boot',{action:'exec',code:'n++'});
  const retry=await broker().executeCell(lost,'n++');
  assert.equal(retry.data?.execution_state,'unknown'); assert.equal(sent.length,2);
  await repository.complete(pending,{ok:false,outcome:'unknown',error:'browser_outcome_unknown',data:{execution_state:'unknown'}});
  await repository.complete(pending,success);
  assert.equal((await receipt(lost.callId)).result.ok,false,'first result is immutable'); await healthy();
  (tracker.browserCapability as {boot_id:string}).boot_id='restarted';
  assert.equal((await broker().executeCell(lost,'n++')).data?.execution_state,'unknown');
  assert.equal(sent.length,2);
  (tracker.browserCapability as {boot_id:string}).boot_id='boot';

  // Lost transport acknowledgement sends no fallback. A new carrier still sees
  // the old receipt; cancellation also remains unknown once a frame was sent.
  const disconnected=await context(); onSend=()=>sessions.delete(budId);
  assert.equal((await broker().executeCell(disconnected,'n++')).data?.execution_state,'unknown'); onSend=undefined;
  sessions.set(budId,tracker); const count=sent.length;
  assert.equal((await broker().executeCell(disconnected,'n++')).data?.execution_state,'unknown'); assert.equal(sent.length,count);
  const aborted=await context(), cancel=new AbortController(); onSend=()=>queueMicrotask(()=>cancel.abort());
  assert.equal((await broker().executeCell({...aborted,signal:cancel.signal},'n++')).data?.execution_state,'unknown'); onSend=undefined;
  const canceledRequest=sent.at(-1)!;
  receiveBrowserResult(tracker,{browser_version:1,result:{...canceledRequest,...success}});
  assert.equal((await receipt(aborted.callId)).result.ok,false);
  const unstarted=await context(); const before=sent.length;
  assert.equal((await broker().executeCell({...unstarted,signal:AbortSignal.abort()},'n++')).data?.execution_state,'not_executed');
  assert.equal(sent.length,before);

  // A JavaScript exception, including partial effects, does not disconnect Chrome.
  reply={ok:false,outcome:'unknown',error:'browser_repl_execution_failed',data:{execution_state:'failed',text:'effect already happened',error:'later failure',runtime_generation:'heap'}};
  assert.equal((await broker().executeCell(await context(),'n++; throw Error()')).data?.execution_state,'failed'); await healthy();
  // UTF-8 text limits survive JSON escaping; arbitrary extra fields are refused.
  reply={...success,data:{...success.data,text:'\u0001'.repeat(32*1024)}};
  assert.equal((await broker().executeCell(await context(),'console.log(text)')).ok,true);
  reply={...success,data:{...success.data,text:'🙂'.repeat(8193)}};
  assert.equal((await broker().executeCell(await context(),'console.log(text)')).data?.execution_state,'unknown');
  reply={...success,data:{...success.data,unexpected:'page data'}};
  assert.equal((await broker().executeCell(await context(),'console.log(text)')).data?.execution_state,'unknown');
  reply=success;
  assert.equal((await broker().executeCell(await context(),'x'.repeat(64*1024+1))).error,'browser_invalid_arguments');
  await healthy();

  // Store the authoritative outcome after takeover has fenced the action, but
  // never disclose its text through the old authorization.
  const privateCell=await context(); const request=await repository.prepare(privateCell,'boot',{action:'exec',code:'n++'});
  await pool.query("update browser_resource set control_state='human_private',private_content=true,control_session_id=$2 where bud_id=$1",[budId,open.session_id]);
  await pool.query('update agent_invocation_action set fence=fence+1 where call_id=$1',[privateCell.callId]);
  await repository.complete(request,success);
  assert.equal((await receipt(privateCell.callId)).result.data.execution_state,'completed');
  assert.equal(await repository.evidenceAllowed(request),false);
  // Already recorded cells return only safe status while current private control
  // disallows their evidence; no new send or automatic replay follows Return.
  const withheld=await broker().executeCell(first,'var n=0; console.log(++n)');
  assert.equal(withheld.data?.output_withheld,true); assert.equal(withheld.data?.execution_state,'completed');
  assert.equal(withheld.data?.text,undefined);
});
