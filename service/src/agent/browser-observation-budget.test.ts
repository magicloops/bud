import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserToolExecutor, type BrowserAgentBackend } from './browser-tool-executor.js';

const context={threadId:'thread',budId:'bud',ownerUserId:'alice',turnId:'turn',signal:new AbortController().signal};
test('uncertain clicks retain honest outcomes without retry or invented success',async()=>{
  let calls=0;
  const executor=new BrowserToolExecutor({available:async()=>true,execute:async()=>{
    calls++; return {ok:false,outcome:'unknown',error:'browser_outcome_unknown'};
  }},async()=>true);
  const result=await executor.execute(context,{type:'tool_call',tool:'browser_exec',callId:'click',args:{code:'await handle.click()'}});
  assert.equal(calls,1);assert.equal(result.result.retryable,false);
  assert.equal(result.payload.outcome,'unknown');assert.equal(result.payload.error,'browser_outcome_unknown');
  assert.match(result.summary,/Inspect state/);
  assert.doesNotMatch(result.summary,/not sent/);
});
