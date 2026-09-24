import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {Engine} from './engine.mjs';
import {sanitize} from './engine.mjs';
import {compactNodes} from './compact.mjs';
import {createBrowser} from './repl-api.mjs';
const executablePath=process.env.BUD_BROWSER_EXECUTABLE;
async function fixture(t){const browser=await chromium.launch({executablePath,headless:true,args:['--use-mock-keychain','--password-store=basic']});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:637,height:639},deviceScaleFactor:2});const cdp=await page.context().newCDPSession(page);const target=(await cdp.send('Target.getTargetInfo')).targetInfo.targetId;await cdp.detach();return {page,engine:new Engine(browser),target};}

test('only the upstream pointer hint survives sanitation and compact wrapper/reference pruning',()=>{
 const input=[{role:'generic',ref:'e1',cursor:'pointer',children:['Expand']},
   {role:'generic',ref:'e2',cursor:'secret'},
   {role:'textbox',cursor:'pointer',value:'SECRET',text:'SECRET',children:['SECRET']}];
 const nodes=sanitize(input,'s',new Map());
 assert.equal(nodes[0].cursor,'pointer');assert.equal(nodes[2].cursor,undefined);
 const compact=compactNodes(nodes);
 assert.equal(compact[0].reference,'s:e1');assert.equal(compact[0].cursor,'pointer');
 assert.doesNotMatch(JSON.stringify(compact),/secret|SECRET/);
});

test('native and custom disclosure targets survive full/scoped/visible/compact observations', {skip:!executablePath},async t=>{
 const {page,engine,target}=await fixture(t);
 for(const custom of [false,true]){
  await page.setContent(custom ? `<article aria-label='Record'><div style='cursor:pointer;width:500px;height:50px' onclick="document.querySelector('p').hidden=false;window.expands++"><span>Expand record</span><a href='#profile' style='float:right' onclick='event.stopPropagation();window.profiles++'>Profile</a></div><p hidden>Hidden evidence</p></article>` : `<details role='article' aria-label='Record'><summary style='cursor:pointer;width:500px;height:50px'><span>Expand record</span><a href='#profile' style='float:right' onclick='window.profiles++'>Profile</a></summary><p>Hidden evidence</p></details>`);
  await page.evaluate(()=>{window.expands=0;window.profiles=0;});
  const raw=await page.locator('body').ariaSnapshotJSON({mode:'ai'});
  assert.match(JSON.stringify(raw),/"cursor":"pointer"/);
  for(const options of [{full:true},{compact:true,full:true},{operation:'visible_dom'},{operation:'visible_dom',compact:true},{compact:true},{}]){
   const snapshot=await engine.execute({operation:'snapshot',target_id:target,...options});
   if(snapshot.nodes) assert.ok(snapshot.nodes.some(n=>n.role==='generic'&&n.cursor==='pointer'&&n.reference));
   if(snapshot.text) assert.match(snapshot.text,/generic .*\[cursor=pointer\]/);
  }
  const root=await engine.execute({operation:'snapshot',target_id:target,full:true});
  const scoped=await engine.execute({operation:'snapshot',target_id:target,scope:root.nodes.find(n=>n.role==='article').reference,full:true,compact:true});
  const header=scoped.nodes.find(n=>n.role==='generic'&&n.cursor==='pointer');
  assert.ok(header.reference);
  const without=sanitize(raw,'x',new Map()).map(({cursor,...n})=>n);
  const withHint=sanitize(raw,'x',new Map());
  t.diagnostic(`disclosure custom=${custom} full hint bytes=${Buffer.byteLength(JSON.stringify(withHint))-Buffer.byteLength(JSON.stringify(without))}; compact bytes=${Buffer.byteLength(JSON.stringify(compactNodes(withHint)))-Buffer.byteLength(JSON.stringify(compactNodes(without)))}`);
  await engine.execute({operation:'click',target_id:target,reference:header.reference,observation_id:scoped.observation_id});
  assert.equal(await page.locator('p').isVisible(),true);
  assert.equal(await page.evaluate(()=>profiles),0);
  if(custom) assert.equal(await page.evaluate(()=>expands),1);
 }
});

test('position options reject overrides and invalid coordinates before bridge dispatch',async()=>{
 const calls=[];const {browser}=createBrowser(async c=>{calls.push(c);return c.action==='repl'?{observation_id:'s',nodes:[]}:{observation:{width:50,height:20}};});
 const tab=browser.tabs.get('tab');await tab.snapshot();const h=tab.getByReference('s:e1');
 for(const options of [{force:true},{position:null},{position:{x:NaN,y:1}},{position:{x:1,y:Infinity}},{position:{x:-1,y:2}},{position:{x:1,y:2,target_id:'other'}},[]])
  assert.throws(()=>h.click(options),/browser_invalid_arguments/);
 assert.equal(calls.length,1);
 assert.deepEqual(await h.geometry(),{width:50,height:20});
 await h.click({position:{x:2,y:3}});
 assert.deepEqual(calls.at(-1),{reference:'s:e1',observation_id:'s',position:{x:2,y:3},action:'inspect',target_id:'tab',operation:'click'});
});

test('position bounds and reference identity reject without clicking a replacement', {skip:!executablePath},async t=>{
 const {page,engine,target}=await fixture(t);
 await page.setContent(`<button style='width:100px;height:40px;padding:0;border:5px solid' onclick='window.clicks++'>Apply</button><script>window.clicks=0;</script>`);
 const snapshot=await engine.execute({operation:'snapshot',target_id:target});
 const reference=snapshot.nodes.find(n=>n.role==='button').reference;
 const command={target_id:target,reference,observation_id:snapshot.observation_id};
 assert.deepEqual(await engine.execute({...command,operation:'geometry'}),{width:90,height:30});
 for(const position of [{x:90,y:1},{x:1,y:30},{x:Infinity,y:1},{x:-1,y:0}])
  await assert.rejects(engine.execute({...command,operation:'click',position}),/browser_invalid_arguments/);
 assert.equal(await page.evaluate(()=>clicks),0);
 await page.locator('button').evaluate(e=>e.replaceWith(e.cloneNode(true)));
 await assert.rejects(engine.execute({...command,operation:'click'}),/not found|browser_locator_not_found|browser_stale_reference/);
 assert.equal(await page.evaluate(()=>clicks),0);
});

test('image links, label controls and icon buttons keep native semantics', {skip:!executablePath},async t=>{
 const {page,engine,target}=await fixture(t);
 await page.setContent(`<a href='#image'><img alt='Image destination' width=80 height=80></a><label><input type=checkbox>Enabled</label><button aria-label='Save' onclick='window.saves++'><svg width=20 height=20><rect width=20 height=20 /></svg></button><script>window.saves=0;</script>`);
 await engine.execute({operation:'snapshot',target_id:target});
 await engine.execute({operation:'click',target_id:target,locator:{role:'checkbox',name:'Enabled'}});
 await engine.execute({operation:'click',target_id:target,locator:{role:'button',name:'Save'}});
 assert.equal(await page.locator('input').isChecked(),true);assert.equal(await page.evaluate(()=>saves),1);
 await engine.execute({operation:'click',target_id:target,locator:{role:'link',name:'Image destination'}});
 assert.match(page.url(),/#image$/);
});
test('layered card opens post once; covered title never clicks equal-URL sibling', {skip:!executablePath},async t=>{const {page,engine,target}=await fixture(t);await page.setContent(`<style>body{margin:0}article{position:relative;height:490px}#card{position:absolute;inset:0;z-index:2}#title{position:absolute;top:36px;left:16px;right:16px;height:20px}img{position:absolute;top:90px;left:16px;width:605px;height:300px;z-index:3}</style><article><a id=card href='#post?q=1' aria-label='Card'></a><a id=title href='#post?q=1'>Title</a><img alt='Lightbox' onclick='window.lightboxes++'></article><script>window.lightboxes=0;window.clicks=0;document.querySelector('#card').onclick=()=>window.clicks++;</script>`);
 const snap=await engine.execute({operation:'snapshot',target_id:target});
 assert.equal(snap.nodes.find(n=>n.name==='Card').url,'#post?q=1');
 const click=(name,position)=>engine.execute({operation:'click',target_id:target,reference:snap.nodes.find(n=>n.name===name).reference,position});
 await assert.rejects(click('Title'),/Timeout/);assert.equal(await page.evaluate(()=>clicks),0);
 await assert.rejects(click('Card'),/Timeout/);assert.deepEqual(await page.evaluate(()=>[clicks,lightboxes]),[0,0]);
 const card=snap.nodes.find(n=>n.name==='Card');
 assert.deepEqual(await engine.execute({operation:'geometry',target_id:target,reference:card.reference}),{width:637,height:490});
 await click('Card',{x:20,y:20});assert.match(page.url(),/#post\?q=1$/);assert.deepEqual(await page.evaluate(()=>[clicks,lightboxes]),[1,0]);
});
test('shadow slots, bordered frame and ancestor overlay use exact target hit testing', {skip:!executablePath},async t=>{const {page}=await fixture(t);await page.setContent(`<div id=host><a id=link slot=content href='#done'>Slotted link</a></div><iframe style='border:7px solid;margin:30px' srcdoc="<button onclick='window.clicked=true'>Inside</button>"></iframe>`);await page.evaluate(()=>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<slot name=content></slot>');const h=await page.$('#link');await h.click({timeout:1000});const child=page.frames().find(f=>f.parentFrame());const b=await child.getByRole('button').elementHandle();await b.click({timeout:1000});assert.equal(await child.evaluate(()=>window.clicked),true);
 await page.evaluate(()=>{const d=document.createElement('div');d.style='position:fixed;inset:0;z-index:1000';document.body.append(d);});await assert.rejects(b.click({timeout:1000}),/Timeout/);
});
test('dynamic hover overlay remains uncertain after dispatch; no forced click', {skip:!executablePath},async t=>{const {page,engine,target}=await fixture(t);await page.setContent(`<button style='width:300px;height:200px' onmousemove="document.querySelector('#cover').style.display='block'" onclick='window.clicked=true'>Hover</button><div id=cover style='display:none;position:fixed;inset:0;z-index:1000'></div>`);await engine.execute({operation:'snapshot',target_id:target});await assert.rejects(engine.execute({operation:'click',target_id:target,locator:{role:'button',name:'Hover'}}),/Timeout/);assert.equal(engine.stage,'click');assert.equal(await page.evaluate(()=>!!window.clicked),false);});
test('native clicks support clipped, tiny, transformed, zoomed and offscreen elements', {skip:!executablePath},async t=>{
 const {page,engine,target}=await fixture(t);
 await page.setContent(`<div style='height:40px;width:100px;overflow:hidden'><button style='width:100px;height:300px'>Clipped</button></div><button style='padding:0;border:0;width:3px;height:3px;transform:rotate(20deg)' aria-label='Tiny'>.</button><div style='zoom:1.5'><button>Zoom</button></div><button style='display:block;margin-top:1500px'>Below</button><script>window.events=[];document.querySelectorAll('button').forEach(b=>b.onclick=()=>events.push(b.getAttribute('aria-label')||b.textContent));</script>`);
 await engine.execute({operation:'snapshot',target_id:target});
 for (const name of ['Clipped','Tiny','Zoom','Below']) await engine.execute({operation:'click',target_id:target,locator:{role:'button',name}});
 assert.deepEqual(await page.evaluate(()=>events),['Clipped','Tiny','Zoom','Below']);
});

test('observation URLs retain queries/fragments and script-only buttons have none', {skip:!executablePath},async t=>{
 const {page,engine,target}=await fixture(t);
 const url='https://example.test/post?q=a%2Fb&q=two#image';
 await page.setContent(`<a href='${url}'>Post</a><button>Script only</button>`);
 const snapshot=await engine.execute({operation:'snapshot',target_id:target,compact:true});
 assert.equal(snapshot.nodes.find(n=>n.role==='link').url,url);
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
  await handle.click({timeout:1000});
  assert.equal(await button.evaluate(()=>window.clicks),1);
  await page.evaluate(()=>{const e=document.createElement('div');e.style='position:fixed;inset:0;z-index:100';document.body.append(e);});
  await assert.rejects(handle.click({timeout:1000}),/Timeout/);
  assert.equal(await button.evaluate(()=>window.clicks),1);
});

test('explicit positioning selects an observed exposed strip; native multiline links work', {skip:!executablePath},async t=>{
  const {page}=await fixture(t);
  await page.setContent(`<a id=target href='#done' style='display:block;width:400px;height:100px'>Target</a><div id=cover style='position:absolute;top:22px;left:0;right:0;height:90px'></div>`);
  const handle=await page.$('#target');
  await handle.click({position:{x:10,y:5},timeout:1000});
  await page.setContent(`<div style='width:90px'><a id=multi href='#multi'>A multiline link with several words</a></div>`);
  const multi=await page.$('#multi');
  assert.ok(await multi.evaluate(e=>e.getClientRects().length)>1);
  await multi.click({timeout:1000});
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
  }
  if(result) assert.equal(result.action_applied,true);
  const counts=await page.evaluate(()=>({downs,clicks}));
  assert.ok(counts.downs>=1);
  assert.equal(counts.clicks,0);
  assert.doesNotMatch(page.url(),/#post$/);
});
