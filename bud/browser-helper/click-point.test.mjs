import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {Engine} from './engine.mjs';
import {selectClickPoint} from './click-point.mjs';
const executablePath=process.env.BUD_BROWSER_EXECUTABLE;
async function fixture(t){const browser=await chromium.launch({executablePath,headless:true,args:['--use-mock-keychain','--password-store=basic']});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:637,height:639},deviceScaleFactor:2});const cdp=await page.context().newCDPSession(page);const target=(await cdp.send('Target.getTargetInfo')).targetInfo.targetId;await cdp.detach();return {page,engine:new Engine(browser),target};}
test('layered card opens post once; covered title never clicks equal-URL sibling', {skip:!executablePath},async t=>{const {page,engine,target}=await fixture(t);await page.setContent(`<style>body{margin:0}article{position:relative;height:490px}#card{position:absolute;inset:0;z-index:2}#title{position:absolute;top:36px;left:16px;right:16px;height:20px}img{position:absolute;top:90px;left:16px;width:605px;height:300px;z-index:3}</style><article><a id=card href='#post?q=1' aria-label='Card'></a><a id=title href='#post?q=1'>Title</a><img alt='Lightbox' onclick='window.lightboxes++'></article><script>window.lightboxes=0;window.clicks=0;document.querySelector('#card').onclick=()=>window.clicks++;</script>`);
 const snap=await engine.execute({operation:'snapshot',target_id:target});
 assert.equal(snap.nodes.find(n=>n.name==='Card').url,'#post?q=1');
 const click=name=>engine.execute({operation:'click',target_id:target,reference:snap.nodes.find(n=>n.name===name).reference});
 await assert.rejects(click('Title'),/browser_click_blocked/);assert.equal(await page.evaluate(()=>clicks),0);
 await click('Card');assert.match(page.url(),/#post\?q=1$/);assert.deepEqual(await page.evaluate(()=>[clicks,lightboxes]),[1,0]);
});
test('seeded choices vary but never hit nested media or buttons', {skip:!executablePath},async t=>{const {page}=await fixture(t);await page.setContent(`<a id=target href='#post' style='display:block;width:400px;height:400px;position:relative'><span>Text</span><img style='position:absolute;inset:40px;width:320px;height:320px'><button style='position:absolute;bottom:0;left:0'>Other</button></a>`);const h=await page.$('#target');const points=[];for(const seed of [0,.25,.75,.999]){const p=await selectClickPoint(h,{random:()=>seed,remaining:()=>1000});points.push(p);await h.click({position:p,scroll:'none',trial:true,timeout:1000});}assert.ok(new Set(points.map(p=>JSON.stringify(p))).size>1);});
test('shadow slots, bordered frame and ancestor overlay use exact target hit testing', {skip:!executablePath},async t=>{const {page}=await fixture(t);await page.setContent(`<div id=host><a id=link slot=content href='#done'>Slotted link</a></div><iframe style='border:7px solid;margin:30px' srcdoc="<button onclick='window.clicked=true'>Inside</button>"></iframe>`);await page.evaluate(()=>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<slot name=content></slot>');const h=await page.$('#link');const p=await selectClickPoint(h,{remaining:()=>1000});await h.click({position:p,scroll:'none',timeout:1000});const child=page.frames().find(f=>f.parentFrame());const b=await child.getByRole('button').elementHandle();const pos=await selectClickPoint(b,{remaining:()=>1000});await b.click({position:pos,scroll:'none',timeout:1000});assert.equal(await child.evaluate(()=>window.clicked),true);
 await page.evaluate(()=>{const d=document.createElement('div');d.style='position:fixed;inset:0;z-index:1000';document.body.append(d);});await assert.rejects(selectClickPoint(b,{remaining:()=>1000}),/browser_click_blocked/);
});
test('dynamic hover overlay remains uncertain after dispatch; no forced click', {skip:!executablePath},async t=>{const {page,engine,target}=await fixture(t);await page.setContent(`<button style='width:300px;height:200px' onmousemove="document.querySelector('#cover').style.display='block'" onclick='window.clicked=true'>Hover</button><div id=cover style='display:none;position:fixed;inset:0;z-index:1000'></div>`);await engine.execute({operation:'snapshot',target_id:target});await assert.rejects(engine.execute({operation:'click',target_id:target,locator:{role:'button',name:'Hover'}}),/Timeout/);assert.equal(engine.stage,'click');assert.equal(await page.evaluate(()=>!!window.clicked),false);});
test('tiny and clipped targets work; transformed geometry rejects before input', {skip:!executablePath},async t=>{const {page}=await fixture(t);await page.setContent(`<div style='height:40px;width:100px;overflow:hidden'><button style='width:100px;height:300px'>Clipped</button></div><button id=tiny style='padding:0;border:0;width:3px;height:3px'>.</button>`);for(const selector of ['button','#tiny']){const h=await page.locator(selector).first().elementHandle();const p=await selectClickPoint(h,{remaining:()=>1000});await h.click({position:p,scroll:'none',trial:true,timeout:1000});}await page.locator('#tiny').evaluate(e=>e.style.transform='rotate(20deg)');await assert.rejects(selectClickPoint(await page.$('#tiny'),{remaining:()=>1000}),/browser_click_blocked/);});

test('observation URLs retain queries/fragments and script-only buttons have none', {skip:!executablePath},async t=>{
 const {page,engine,target}=await fixture(t);
 const url='https://example.test/post?q=a%2Fb&q=two#image';
 await page.setContent(`<a href='${url}'>Post</a><button>Script only</button>`);
 const snapshot=await engine.execute({operation:'snapshot',target_id:target,compact:true});
 assert.ok(snapshot.text.includes(`url=${JSON.stringify(url)}`));
 const visible=await engine.execute({operation:'visible_dom',target_id:target,compact:true});
 assert.equal(visible.nodes.find(n=>n.role==='link').url,url);
 assert.equal(visible.nodes.find(n=>n.role==='button').url,undefined);
});

test('cross-origin frame mapping rejects an ancestor overlay', {skip:!executablePath},async t=>{
  const {createServer}=await import('node:http');
  const server=createServer((req,res)=>res.end(`<button onclick='window.clicks=(window.clicks||0)+1'>Inside</button>`));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {page}=await fixture(t);
  await page.setContent(`<iframe style='border:9px solid;margin:40px' src='http://127.0.0.1:${server.address().port}/'></iframe>`);
  const button=page.frameLocator('iframe').getByRole('button');
  await button.waitFor();
  const handle=await button.elementHandle();
  const position=await selectClickPoint(handle,{remaining:()=>1000});
  await handle.click({position,scroll:'none',timeout:1000});
  assert.equal(await button.evaluate(()=>window.clicks),1);
  await page.evaluate(()=>{const e=document.createElement('div');e.style='position:fixed;inset:0;z-index:100';document.body.append(e);});
  await assert.rejects(selectClickPoint(handle,{remaining:()=>1000}),/browser_click_blocked/);
  assert.equal(await button.evaluate(()=>window.clicks),1);
});

test('deterministic fallback finds a narrow exposed strip and multiline links', {skip:!executablePath},async t=>{
  const {page}=await fixture(t);
  await page.setContent(`<a id=target href='#done' style='display:block;width:400px;height:100px'>Target</a><div id=cover style='position:absolute;top:22px;left:0;right:0;height:90px'></div>`);
  const handle=await page.$('#target');
  const point=await selectClickPoint(handle,{random:()=>.999,remaining:()=>1000});
  assert.ok(point.y<14,'only the top strip is exposed');
  await handle.click({position:point,scroll:'none',timeout:1000});
  await page.setContent(`<div style='width:90px'><a id=multi href='#multi'>A multiline link with several words</a></div>`);
  const multi=await page.$('#multi');
  assert.ok(await multi.evaluate(e=>e.getClientRects().length)>1);
  await multi.click({position:await selectClickPoint(multi,{remaining:()=>1000}),scroll:'none',timeout:1000});
  assert.match(page.url(),/#multi$/);
});

test('pointerdown side effects do not imply the requested navigation succeeded', {skip:!executablePath},async t=>{
  const {page,engine,target}=await fixture(t);
  await page.setContent(`<a href='#post' style='display:block;width:300px;height:200px'
    onpointerdown="window.downs++;document.querySelector('#cover').style.display='block'"
    onclick='window.clicks++'>Post</a><div id=cover style='display:none;position:fixed;inset:0;z-index:100'></div>
    <script>window.downs=0;window.clicks=0;</script>`);
  await engine.execute({operation:'snapshot',target_id:target});
  let result;
  try {
    result=await engine.execute({operation:'click',target_id:target,locator:{role:'link',name:'Post'}});
  } catch(error) {
    assert.equal(engine.stage,'click');
    assert.notEqual(error.message,'browser_click_blocked');
  }
  if(result) assert.equal(result.action_applied,true);
  const counts=await page.evaluate(()=>({downs,clicks}));
  assert.ok(counts.downs>=1);
  assert.equal(counts.clicks,0);
  assert.doesNotMatch(page.url(),/#post$/);
});
