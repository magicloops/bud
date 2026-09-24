import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserToolExecutor, type BrowserAgentBackend } from './browser-tool-executor.js';
import { AgentConversationLoader } from './conversation-loader.js';

const context={threadId:'thread',budId:'bud',ownerUserId:'alice',turnId:'turn',signal:new AbortController().signal};
const directive={type:'tool_call',tool:'browser_observe',callId:'call',args:{mode:'snapshot'}} as const;
const executor=(observation:Record<string,unknown>)=>new BrowserToolExecutor({
  available:async()=>true,
  execute:async()=>({ok:true,outcome:'completed',data:{observation}}),
} as BrowserAgentBackend,async()=>true);

test('compact output is bounded at the final tool envelope and preserved exactly in replay',async()=>{
  const observation={format:'compact_v1',text:'link "Story 16" [ref=short1:e16] url="https://example.test/post?q=a%2Fb&q=two#image"' ,observation_id:'short1',truncated:false};
  const result=await executor(observation).execute(context,directive);
  assert.equal(result.result.ok,true);
  const content=JSON.stringify(result.payload);
  assert.ok(Buffer.byteLength(content)<=36 * 1024);
  const replay:any[]=[]; const loader=new AgentConversationLoader();
  Reflect.get(loader,'appendStoredMessage').call(loader,(message:unknown)=>replay.push(message),
    {messageId:'message',clientId:'client',role:'tool',content,metadata:{}},{toolUseFromProviderLedger:false});
  assert.equal(replay[1].content[0].content,content);
  assert.deepEqual(JSON.parse(replay[1].content[0].content).data.observation,observation);
  const larger=await executor({...observation,text:'x'.repeat(32 * 1024 - 1024)}).execute(context,directive);
  assert.equal(larger.result.ok,true);
  assert.ok(Buffer.byteLength(JSON.stringify(larger.payload))>12 * 1024);
  const huge=await executor({...observation,text:'😀'.repeat(10000)}).execute(context,directive);
  assert.equal(huge.result.ok,false);assert.equal(huge.payload.error,'browser_observation_limit');
  assert.ok(Buffer.byteLength(JSON.stringify(huge.payload))<=36 * 1024);
  assert.equal((huge.payload.data as any).observation,undefined);
});


test('uncertain clicks retain honest outcomes without retry or invented success',async()=>{
  let calls=0;
  const executor=new BrowserToolExecutor({available:async()=>true,execute:async()=>{
    calls++; return {ok:false,outcome:'unknown',error:'browser_outcome_unknown'};
  }},async()=>true);
  const result=await executor.execute(context,{type:'tool_call',tool:'browser_act',callId:'click',args:{action:'click',reference:'s:e1'}});
  assert.equal(calls,1);assert.equal(result.result.retryable,false);
  assert.equal(result.payload.outcome,'unknown');assert.equal(result.payload.error,'browser_outcome_unknown');
  assert.match(result.summary,/Inspect state/);
  assert.doesNotMatch(result.summary,/not sent/);
});
