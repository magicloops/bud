import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BrowserBroker } from './broker.js';
import { BrowserControl } from './control.js';
import { BrowserRepository } from './repository.js';
import { decodeBudFrame } from '../proto/wire.js';
import { sessions, type SessionTracker } from '../ws/session-trackers.js';
import { receiveBrowserResult } from './transport.js';

test('REPL requires capability and retired calls never allocate or dispatch', async t => {
  const budId = randomUUID();
  const commands: Record<string, unknown>[] = [];
  let runtimeReplaced = false;
  const capability = {version:1, available:true, boot_id:'boot', managed:true, profile_mode:'persistent', semantic_observations:true};
  const tracker = {
    budId, sessionId:'device', browserCapability:capability,
    socket:{readyState:1, OPEN:1, send(bytes:Buffer) {
      const frame = decodeBudFrame(bytes) as any;
      commands.push(frame.request.command);
      queueMicrotask(() => receiveBrowserResult(tracker,{browser_version:1,result:{...frame.request,ok:true,outcome:'completed',data:{execution_state:'completed'}}}));
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
  const broker = new BrowserBroker(repository, { async ensure() { return {runtime_replaced:runtimeReplaced}; } } as unknown as BrowserControl);
  const context = {budId,threadId:'thread',ownerUserId:'alice',turnId:'turn',callId:'call',signal:new AbortController().signal};
  // A daemon without structured observations is not a browser carrier at all.
  tracker.browserCapability = {...capability, semantic_observations: undefined};
  assert.equal((await broker.execute(context,'browser_exec',{code:'1'})).error,'browser_unavailable');
  assert.equal(commands.length,0);
  tracker.browserCapability = capability;
  assert.equal(await broker.available(context), false);
  assert.equal((await broker.execute(context, 'browser_exec', {code:'1'})).error, 'browser_repl_unsupported');
  tracker.browserCapability = {...capability, repl:true};
  assert.equal(await broker.available(context), true);
  assert.equal((await broker.execute(context, 'browser_exec', {code:'1'})).ok, true);
  assert.deepEqual(commands[0], {action:'exec', code:'1'});
  const before = commands.length;
  for (const name of ['browser_open','browser_observe','browser_act','browser_close']) {
    assert.equal((await broker.execute(context, name as never, {})).error, 'unsupported_tool');
  }
  assert.equal(commands.length, before);
});
