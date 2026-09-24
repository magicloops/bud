import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, traceSnapshot } from './engine.mjs';

test('raw diagnostic preserves upstream structure/state but excludes field values', () => {
  const raw = [{role:'group',name:'Record',children:['Inline',{role:'button',expanded:false,name:'Expand'},
    {role:'textbox',name:'Password',text:'secret',value:'secret',children:['secret']},
    {role:'slider',name:'Value',text:'private',children:['private']}]}];
  const result = traceSnapshot(raw);
  assert.equal(result.truncated, false);
  assert.doesNotMatch(result.content,/secret|private/);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed[0].children[0], 'Inline');
  assert.equal(parsed[0].children[1].expanded, false);
  assert.equal(parsed[0].children[2].name, 'Password');
  assert.equal(raw[0].children[2].text, 'secret', 'never mutate source');
});

test('raw diagnostic bounds UTF-8 and cannot fail a browser operation', () => {
  const result = traceSnapshot(['🐱'.repeat(300000)]);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.content) <= 1024 * 1024);
  assert.doesNotMatch(result.content,/�/);
  const cycle = {}; cycle.children=[cycle];
  assert.deepEqual(traceSnapshot([cycle]), {unavailable:true});
});

test('trace uses the same snapshot and preserves the normal returned observation', async () => {
  let reads = 0;
  const raw = [{role:'group',children:['body',{role:'button',name:'Expand',expanded:false}]}];
  const page = {locator:()=>({ariaSnapshotJSON:async()=>{reads++;return raw;}}),
    title:async()=> 'Fixture',evaluate:async()=>({width:800,height:600,scroll_x:0,scroll_y:0})};
  const engine = new Engine({}); engine.page=async()=>page; engine.document=async()=> 'doc';
  const normal=await engine.execute({operation:'snapshot',target_id:'owned',full:true});
  assert.equal(normal._bud_trace, undefined);
  const traced=await engine.execute({operation:'snapshot',target_id:'owned',full:true,trace:true});
  assert.equal(reads,2, 'one capture per request');
  assert.deepEqual(JSON.parse(traced._bud_trace.content), raw);
  const clean = nodes => nodes.map(({reference,...rest})=>rest);
  assert.deepEqual(clean(traced.nodes),clean(normal.nodes));
  assert.equal(traced.document_id, 'doc');
});


test('Chrome trace distinguishes collapsed content from an evaluation extracting it', {skip:!process.env.BUD_BROWSER_EXECUTABLE}, async () => {
  const {chromium}=await import('playwright-core');
  const browser=await chromium.launch({executablePath:process.env.BUD_BROWSER_EXECUTABLE,
    headless:true,args:['--use-mock-keychain','--password-store=basic']});
  try {
    const page=await browser.newPage();
    await page.setContent('<details><summary>Expand record</summary><p>Hidden evidence</p></details><label>Account<input value="FIELD_SECRET"></label>');
    const cdp=await page.context().newCDPSession(page);
    const target_id=(await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
    await cdp.detach();
    const engine=new Engine(browser);
    const captured=await engine.execute({operation:'snapshot',target_id,full:true,trace:true});
    assert.doesNotMatch(JSON.stringify(captured),/FIELD_SECRET|Hidden evidence/);
    assert.match(captured._bud_trace.content,/Expand record/);
    const evaluation=await engine.execute({operation:'evaluate',target_id,source:'()=>document.querySelector("details p").textContent'});
    assert.equal(evaluation,'Hidden evidence');
    await page.locator('summary').click();
    const expanded=await engine.execute({operation:'snapshot',target_id,full:true,trace:true});
    assert.match(expanded._bud_trace.content,/Hidden evidence/);
    assert.ok(expanded.nodes.some(n=>n.text==='Hidden evidence' || n.name==='Hidden evidence'));
  } finally { await browser.close(); }
});
