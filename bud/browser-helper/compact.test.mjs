import test from 'node:test';
import assert from 'node:assert/strict';
import { compactNodes } from './compact.mjs';

test('pressed states protect otherwise empty wrappers and survive text serialization', () => {
  const nodes = compactNodes([
    {depth:0,role:'generic',pressed:false}, {depth:1,role:'button',pressed:true,reference:'s:b'},
    {depth:0,role:'button',pressed:'mixed'}, {depth:0,role:'checkbox',checked:'mixed'},
  ]);
  assert.equal(nodes[0].role, 'generic');
  assert.equal(nodes[1].depth, 1);
  assert.deepEqual(nodes.map(n=>n.pressed),[false,true,'mixed',undefined]);
  assert.equal(nodes[3].checked,'mixed');
});
test('promotes empty wrappers, preserves ranks, table structure, unnamed controls and state', () => {
  const nodes = compactNodes([
    {depth:0,role:'generic',reference:'x:1'}, {depth:1,role:'table',reference:'x:2'},
    {depth:2,role:'rowgroup'}, {depth:3,role:'row',reference:'x:3'},
    {depth:4,role:'cell',name:'3.'}, {depth:4,role:'cell'},
    {depth:5,role:'generic'}, {depth:6,role:'link',name:'Story 3',reference:'x:4'},
    {depth:0,role:'checkbox',checked:false,reference:'x:5'},
  ]);
  assert.deepEqual(nodes.map(n=>[n.depth,n.role]),[[0,'table'],[1,'row'],[2,'cell'],[2,'cell'],[3,'link'],[0,'checkbox']]);
  assert.equal(nodes[2].name,'3.'); assert.equal(nodes.at(-1).checked,false);
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
  assert.equal(compactNodes(deep).at(-1).depth,29);
});

test('complete link URLs survive tree normalization without a legacy page budget', () => {
  const url='https://example.test/post?q=a%2Fb&q=雪#part';
  const nodes=Array.from({length:600},(_,i)=>({depth:0,role:'link',name:`Post ${i}`,reference:`s:e${i}`,url:`${url}${i}`}));
  assert.deepEqual(compactNodes(nodes),nodes);
});
