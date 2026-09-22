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
  assert.throws(()=>compactPage(snapshot([{depth:0,role:'text',text:'x'.repeat(OBSERVATION_BYTES + 1)}]),0),/browser_observation_limit/);
});

test('removes only empty structural leaves and redundant single-cell table chains', () => {
  const input = [
    {depth:0,role:'table',reference:'s:outer'},
    {depth:1,role:'row'}, {depth:2,role:'cell'},
    {depth:3,role:'table',name:'Scores',reference:'s:table'},
    {depth:4,role:'row',reference:'s:row'},
    {depth:5,role:'columnheader',name:'Name'}, {depth:5,role:'columnheader',name:'Score'},
    {depth:4,role:'row'}, {depth:5,role:'cell',name:'A'}, {depth:5,role:'cell'},
    {depth:4,role:'row'},
    {depth:4,role:'row',selected:false},
    {depth:4,role:'row'}, {depth:5,role:'cell'},
    {depth:0,role:'button',reference:'s:button'},
  ];
  const result = compactNodes(input);
  assert.equal(result[0].name,'Scores'); assert.equal(result[0].depth,0);
  assert.ok(!result.some(n=>n.reference==='s:outer'));
  assert.equal(result.filter(n=>n.role==='row').length,4);
  assert.equal(result.filter(n=>n.role==='cell' && !n.name).length,2);
  assert.equal(result.at(-1).reference,'s:button');
  assert.equal(result.at(-1).depth,0);
  assert.deepEqual(input[0],{depth:0,role:'table',reference:'s:outer'});
  const text=compactPage(snapshot(result),0).text;
  assert.match(text,/table "Scores" \[s:table\]\n row/);
  assert.match(text,/selected=false/);
  for (const protectedNode of [{name:'Named'}, {selected:false}]) {
    const protectedInput=input.map(n=>({...n})); Object.assign(protectedInput[0],protectedNode);
    assert.equal(compactNodes(protectedInput)[0].reference,'s:outer');
  }
});

test('preserves list scope, duplicate names, deep hierarchy and visible geometry', () => {
  const nodes=compactNodes([
    {depth:0,role:'list',reference:'s:list'},
    {depth:1,role:'listitem',name:'1.',reference:'s:first'},
    {depth:2,role:'link',name:'Same',reference:'s:a',box:{x:1,y:2,width:3,height:4}},
    {depth:1,role:'listitem',name:'2.',reference:'s:second'},
    {depth:2,role:'link',name:'Same',reference:'s:b'},
  ]);
  assert.deepEqual(nodes.map(n=>n.reference),['s:list','s:first','s:a','s:second','s:b']);
  assert.deepEqual(nodes[2].box,{x:1,y:2,width:3,height:4});
  const deep=Array.from({length:30},(_,depth)=>({depth,role:'group',name:`Level ${depth}`}));
  const text=compactPage(snapshot(compactNodes(deep)),0).text;
  assert.equal(text.split('\n').at(-1).match(/^ */)[0].length,29);
});
