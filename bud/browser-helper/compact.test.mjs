import test from 'node:test';
import assert from 'node:assert/strict';
import { compactNodes, compactPage, OBSERVATION_BYTES } from './compact.mjs';

const snapshot = nodes => ({id:'short1',target:'target',document:'document',viewport:{width:800,height:600,scroll_x:0,scroll_y:0},at:Date.now(),mode:'snapshot',nodes});
test('promotes empty wrappers, preserves ranks, table structure, unnamed controls and state', () => {
  const nodes = compactNodes([
    {depth:0,role:'generic',reference:'x:1'}, {depth:1,role:'table',reference:'x:2'},
    {depth:2,role:'rowgroup'}, {depth:3,role:'row',reference:'x:3'},
    {depth:4,role:'cell',name:'3.'}, {depth:4,role:'cell'},
    {depth:5,role:'generic'}, {depth:6,role:'link',name:'Story 3',reference:'x:4'},
    {depth:0,role:'checkbox',checked:false,reference:'x:5'},
  ]);
  assert.deepEqual(nodes.map(n=>[n.depth,n.role]),[[0,'table'],[1,'row'],[2,'cell'],[2,'cell'],[3,'link'],[0,'checkbox']]);
  const result = compactPage(snapshot(nodes),0);
  assert.equal(result.nodes,undefined);
  assert.match(result.text,/3\./); assert.match(result.text,/checked=false/);
});
test('budget includes Unicode escaping, context, envelope and advancing continuations', () => {
  const nodes = [{depth:0,role:'list',reference:'short1:list'}, ...Array.from({length:600},(_,i)=>({depth:1,role:'link',name:`Story ${i} 😀 "quoted"\n`,reference:`short1:e${i}`}))];
  const s = snapshot(nodes); let offset=0; const seen=[];
  do {
    const result=compactPage(s,offset);
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=OBSERVATION_BYTES);
    if(offset)assert.match(result.text,/continued within/);
    seen.push(...result.text.matchAll(/Story (\d+)/g));
    if(!result.continuation)break;
    const next=Number(result.continuation.split(':')[1]); assert.ok(next>offset);offset=next;
  }while(true);
  assert.deepEqual(seen.map(x=>Number(x[1])),Array.from({length:600},(_,i)=>i));
});
test('visible DOM has one representation and honest viewport coverage; limits are explicit', () => {
  const s={...snapshot([{depth:0,role:'button',reference:'short1:e1',box:{x:0,y:0,width:30,height:20}}]),mode:'visible_dom'};
  const result=compactPage(s,0);assert.equal(result.text,undefined);assert.equal(result.coverage,'viewport');assert.equal(result.nodes.length,1);
  assert.equal(compactPage(snapshot([]),0).truncated,false);
  assert.throws(()=>compactPage(snapshot([{depth:0,role:'text',text:'x'.repeat(20000)}]),0),/browser_observation_limit/);
});
