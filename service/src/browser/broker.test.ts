import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BrowserBroker } from './broker.js';
import { BrowserRepository } from './repository.js';
import { decodeBudFrame } from '../proto/wire.js';
import { sessions, type SessionTracker } from '../ws/session-trackers.js';
import { receiveBrowserResult } from './transport.js';

test('new observations are capability gated; legacy default and new default use supported forms', async t => {
  const budId = randomUUID();
  const commands: Record<string, unknown>[] = [];
  const capability = {version:1, available:true, boot_id:'boot', managed:true, profile_mode:'ephemeral'};
  const tracker = {
    budId, sessionId:'device', browserCapability:capability,
    socket:{readyState:1, OPEN:1, send(bytes:Buffer) {
      const frame = decodeBudFrame(bytes) as any;
      commands.push(frame.request.command);
      queueMicrotask(() => receiveBrowserResult(tracker,{browser_version:1,result:{...frame.request,ok:true,outcome:'completed',data:{}}}));
    }},
  } as unknown as SessionTracker;
  sessions.set(budId,tracker);
  t.after(()=>sessions.delete(budId));
  const repository = {
    async prepare(_context: unknown, _boot: string, command: Record<string,unknown>) {
      return { request_id:randomUUID(), session_id:'session', generation:'generation', command, expires_at_ms:Date.now()+2000 };
    },
    async complete() {}, async evidenceAllowed() { return true; },
  } as unknown as BrowserRepository;
  const broker = new BrowserBroker(repository);
  const context = {budId,threadId:'thread',ownerUserId:'alice',turnId:'turn',callId:'call',signal:new AbortController().signal};
  assert.equal((await broker.execute(context,'browser_observe',{})).ok,true);
  assert.equal(commands[0].action,'observe');
  assert.equal((await broker.execute(context,'browser_observe',{mode:'visible_dom'})).error,'browser_representation_unsupported');
  assert.equal((await broker.execute(context,'browser_act',{action:'fill',locator:{role:'textbox',name:'Search'},text:'test'})).error,'browser_representation_unsupported');
  assert.equal((await broker.execute(context,'browser_observe',{mode:'screenshot'})).error,'browser_image_unsupported');
  assert.equal((await broker.execute(context,'browser_act',{action:'click',reference:'obs:e1',target_id:'target',observation_id:'obs'})).error,'browser_representation_unsupported');
  assert.equal(commands.length,1);
  tracker.browserCapability = {...capability,semantic_observations:true};
  assert.equal((await broker.execute(context,'browser_observe',{})).ok,true);
  assert.deepEqual(commands[1],{action:'inspect',operation:'snapshot'});
  assert.equal((await broker.execute(context,'browser_observe',{mode:'page_info'})).ok,true);
  assert.deepEqual(commands[2],{action:'inspect',operation:'page_info'});
  tracker.browserCapability = {...capability,semantic_observations:true,compact_observations:true};
  await broker.execute(context,'browser_observe',{});
  assert.deepEqual(commands[3],{action:'inspect',operation:'snapshot',compact:true});
  await broker.execute(context,'browser_observe',{mode:'visible_dom',continuation:'short:10'});
  assert.deepEqual(commands[4],{action:'inspect',operation:'visible_dom',continuation:'short:10',compact:true});
  await broker.execute(context,'browser_observe',{mode:'page_info'});
  assert.deepEqual(commands[5],{action:'inspect',operation:'page_info'});
  await broker.execute(context,'browser_act',{action:'click',reference:'obs:e1',target_id:'target',observation_id:'obs'});
  assert.deepEqual(commands[6],{action:'inspect',operation:'click',reference:'obs:e1',target_id:'target',observation_id:'obs'});
  await broker.execute(context,'browser_act',{action:'click',reference:'obs:e1'});
  assert.deepEqual(commands[7],{action:'click',reference:'obs:e1'});
});
