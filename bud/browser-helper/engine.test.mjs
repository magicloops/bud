import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { Engine, sanitize } from './engine.mjs';
import { OBSERVATION_BYTES, compactPage } from './compact.mjs';

test('field values and implementation properties never enter snapshots', () => {
  const result = sanitize([{role:'textbox', name:'Email', text:'secret', value:'secret', children:['secret', {role:'text',text:'secret'}]}], 'x', new Map());
  assert.deepEqual(result, [{depth:0,role:'textbox',name:'Email'}]);
});
test('inline strings preserve order and depth without acquiring action references', () => {
  const refs = new Map();
  const nodes = sanitize([{role:'paragraph',children:['Stock: ',{role:'strong',text:'17'},' units remaining.']}], 'x', refs);
  assert.deepEqual(nodes, [
    {depth:0,role:'paragraph'}, {depth:1,role:'text',text:'Stock: '},
    {depth:1,role:'strong',text:'17'}, {depth:1,role:'text',text:' units remaining.'},
  ]);
  assert.equal(refs.size, 0);
  assert.throws(() => sanitize(Array(20001).fill('text'), 'x', new Map()), /browser_observation_limit/);
});
test('toggle states preserve false and mixed without allowing arbitrary string properties', () => {
  const nodes = sanitize([
    {role:'button',pressed:true}, {role:'button',pressed:false}, {role:'button',pressed:'mixed'},
    {role:'checkbox',checked:'mixed'}, {role:'button',pressed:'secret',disabled:'secret'},
  ], 'x', new Map());
  assert.deepEqual(nodes.map(n=>n.pressed), [true,false,'mixed',undefined,undefined]);
  assert.equal(nodes[3].checked, 'mixed');
  assert.equal(nodes[4].disabled, undefined);
});

test('Chrome inline evidence and toggle states survive full, scoped and compact snapshots', {skip: !process.env.BUD_BROWSER_EXECUTABLE}, async () => {
  const browser = await chromium.launch({executablePath:process.env.BUD_BROWSER_EXECUTABLE,headless:true,args:['--use-mock-keychain','--password-store=basic']});
  try {
    const page = await browser.newPage();
    await page.setContent('<main><p>BEFORE <a href="#details">Evidence</a> AFTER</p><p>Stock: <strong>17</strong> units remaining.</p><button aria-pressed="true">On</button><button aria-pressed="false">Off</button><button aria-pressed="mixed">Mixed</button><div role="checkbox" aria-checked="mixed">Partial</div></main><label>Password<input type="password" value="FIELD_SECRET"></label>');
    const cdp = await page.context().newCDPSession(page);
    const target_id = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
    await cdp.detach();
    const engine = new Engine(browser);
    const full = await engine.execute({operation:'snapshot',target_id,full:true,compact:true});
    assert.deepEqual(full.nodes.filter(n=>n.role==='text' || n.role==='strong').map(n=>n.text), ['BEFORE','AFTER','Stock:','17','units remaining.','Password']);
    // Playwright omits false in this snapshot; absence must not be invented as false.
    assert.deepEqual(full.nodes.filter(n=>n.role==='button').map(n=>n.pressed), [true,undefined,'mixed']);
    assert.equal(full.nodes.find(n=>n.role==='checkbox').checked, 'mixed');
    assert.doesNotMatch(JSON.stringify(full), /FIELD_SECRET/);
    const scoped = await engine.execute({operation:'snapshot',target_id,scope:full.nodes.find(n=>n.role==='main').reference,compact:true});
    assert.match(scoped.text, /text: "BEFORE"[\s\S]*link "Evidence"[\s\S]*text: "AFTER"/);
    assert.match(scoped.text, /text: "Stock:"[\s\S]*strong: "17"[\s\S]*text: "units remaining\."/);
    for (const state of ['pressed=true','pressed=mixed','checked=mixed']) assert.ok(scoped.text.includes(state));
    const visible = await engine.execute({operation:'visible_dom',target_id,compact:true});
    assert.equal(visible.nodes.find(n=>n.name==='Mixed').pressed, 'mixed');
    assert.doesNotMatch(JSON.stringify(visible), /FIELD_SECRET/);
    const legacy = await engine.execute({operation:'snapshot',target_id});
    assert.ok(legacy.nodes.some(n=>n.text==='units remaining.'));
    assert.equal(legacy.nodes.find(n=>n.name==='Mixed').pressed, 'mixed');
  } finally { await browser.close(); }
});
test('managed Chrome structured snapshots, scope, continuation and actions', {skip: !process.env.BUD_BROWSER_EXECUTABLE}, async () => {
  const browser = await chromium.launch({ executablePath: process.env.BUD_BROWSER_EXECUTABLE, headless: true, args:['--use-mock-keychain','--password-store=basic'] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<h1>Stories</h1><ol>${Array.from({length:300},(_,i)=>`<li><a href="#story${i+1}">Story ${i+1}</a></li>`).join('')}</ol><label>Email<input value="secret"></label><button>Duplicate</button><button>Duplicate</button>`);
    const session = await page.context().newCDPSession(page);
    const target = (await session.send('Target.getTargetInfo')).targetInfo.targetId;
    await session.detach();
    const engine = new Engine(browser);
    const observe = await engine.execute({operation:'snapshot',target_id:target});
    assert.match(observe.text, /Story 16/);
    assert.ok(!observe.text.includes('secret'));
    assert.ok(observe.continuation);
    const next = await engine.execute({operation:'snapshot',target_id:target,continuation:observe.continuation});
    assert.equal(next.observation_id,observe.observation_id);
    await assert.rejects(engine.execute({operation:'click',target_id:target,observation_id:observe.observation_id,locator:{role:'button',name:'Duplicate'}}), /browser_locator_ambiguous/);
    await engine.execute({operation:'click',target_id:target,observation_id:observe.observation_id,locator:{role:'link',name:'Story 16'}});
    assert.match(page.url(), /#story16$/);
    const fresh = await engine.execute({operation:'snapshot',target_id:target});
    await engine.execute({operation:'fill',target_id:target,observation_id:fresh.observation_id,locator:{role:'textbox',name:'Email'},text:'new'});
    assert.equal(await page.getByRole('textbox').inputValue(),'new');
    const visible = await engine.execute({operation:'visible_dom',target_id:target});
    assert.ok(visible.nodes.every(n=>n.box));
    await assert.rejects(engine.execute({operation:'click',target_id:target,observation_id:fresh.observation_id,locator:{role:'link',name:'Story 3'}}), /browser_stale_reference/);
    const refs = await engine.execute({operation:'snapshot',target_id:target});
    const link = refs.nodes.find(n=>n.name === 'Story 3');
    await engine.execute({operation:'click',target_id:target,reference:link.reference});
    assert.match(page.url(),/#story3$/);
    const ordered = await engine.execute({operation:'snapshot',target_id:target});
    const list = ordered.nodes.find(n=>n.role === 'list');
    assert.ok(list?.reference);
    const scoped = await engine.execute({operation:'snapshot',target_id:target,scope:list.reference});
    assert.match(scoped.text,/Story 16/);
    assert.doesNotMatch(scoped.text,/Email/);
    engine.snapshot.at -= 60001;
    await assert.rejects(engine.execute({operation:'snapshot',target_id:target,continuation:scoped.continuation}), /browser_stale_reference/);
    await engine.execute({operation:'snapshot',target_id:target});
    const oldId = engine.snapshot.id;
    await page.goto('about:blank');
    await assert.rejects(engine.execute({operation:'click',target_id:target,observation_id:oldId,locator:{role:'link',name:'Story 3'}}), /browser_stale_reference/);
  } finally { await browser.close(); }
});

test('compact real-browser observations keep actions, scope and pagination without duplicate payloads', {skip: !process.env.BUD_BROWSER_EXECUTABLE}, async t => {
  const browser = await chromium.launch({executablePath:process.env.BUD_BROWSER_EXECUTABLE,headless:true,args:['--use-mock-keychain','--password-store=basic']});
  try {
    const page = await browser.newPage();
    await page.setContent(`<title>News fixture</title><main><h1>News</h1><table>${Array.from({length:30},(_,i)=>`<tr><td>${i+1}.</td><td><span><a href="#story${i+1}">Example story ${i+1}</a></span></td></tr><tr><td></td><td><span>${42+i} points</span> <a href="#comments${i+1}">comments</a></td></tr>`).join('')}</table></main><label>Password<input type="password" value="secret"></label>`);
    const cdp = await page.context().newCDPSession(page);
    const target = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;await cdp.detach();
    const engine = new Engine(browser);
    const collect = async compact => {
      const pages=[];let continuation;
      do {
        const result=await engine.execute({operation:'snapshot',target_id:target,compact,continuation});
        pages.push(result);continuation=result.continuation;
      }while(continuation);
      return pages;
    };
    const before=await collect(false), after=await collect(true);
    const oldBytes=Buffer.byteLength(JSON.stringify(before)), newBytes=Buffer.byteLength(JSON.stringify(after));
    const withoutUrls = { ...engine.snapshot, nodes: engine.snapshot.nodes.map(({url, ...node}) => node) };
    const baselineBytes = Buffer.byteLength(JSON.stringify([compactPage(withoutUrls, 0)]));
    t.diagnostic(`Same compact fixture URL delta: without=${baselineBytes} with=${newBytes} added=${newBytes-baselineBytes}; pages=1/${after.length}`);
    t.diagnostic(`HN-like fixture serialized bytes: legacy=${oldBytes} compact=${newBytes} reduction=${(100*(1-newBytes/oldBytes)).toFixed(1)}%; pages=${before.length}/${after.length}`);
    assert.ok(newBytes<oldBytes*.3);
    assert.ok(after.every(x=>!('nodes' in x) && Buffer.byteLength(JSON.stringify(x))<=OBSERVATION_BYTES));
    const text=after.map(x=>x.text).join('\n');assert.doesNotMatch(text,/secret/);
    for(const rank of [3,4,16])assert.match(text,new RegExp(`Example story ${rank}"`));
    const ref=text.match(/link "Example story 16" \[([^\]]+)\]/)[1];
    await engine.execute({operation:'click',target_id:target,reference:ref});assert.match(page.url(),/#story16$/);
    const fresh=await engine.execute({operation:'snapshot',target_id:target,compact:true});
    await assert.rejects(engine.execute({operation:'click',target_id:target,reference:ref}),/browser_stale_reference/);
    const scope=fresh.text.match(/main \[([^\]]+)\]/)[1];
    const scoped=await engine.execute({operation:'snapshot',target_id:target,compact:true,scope});
    assert.equal(scoped.coverage,'subtree');assert.doesNotMatch(scoped.text,/Password/);
    const visible=await engine.execute({operation:'visible_dom',target_id:target,compact:true});
    assert.equal(visible.text,undefined);assert.equal(visible.coverage,'viewport');assert.ok(visible.nodes.every(n=>n.box));
    // Larger fixture proves mode-bound continuation and expiry on compact output.
    await page.setContent(`<ol>${Array.from({length:600},(_,i)=>`<li><a href="#${i}">Story ${i}</a></li>`).join('')}</ol>`);
    const long=await engine.execute({operation:'snapshot',target_id:target,compact:true});assert.ok(long.continuation);
    await assert.rejects(engine.execute({operation:'visible_dom',target_id:target,compact:true,continuation:long.continuation}),/browser_stale_reference/);
    await assert.rejects(engine.execute({operation:'snapshot',target_id:target,continuation:long.continuation}),/browser_stale_reference/);
    const next=await engine.execute({operation:'snapshot',target_id:target,compact:true,continuation:long.continuation});assert.equal(next.observation_id,long.observation_id);
    engine.snapshot.at-=60001;
    await assert.rejects(engine.execute({operation:'snapshot',target_id:target,compact:true,continuation:long.continuation}),/browser_stale_reference/);
    if(process.env.BUD_BROWSER_BENCHMARK_OUTPUT){
      const {writeFileSync}=await import('node:fs');writeFileSync(process.env.BUD_BROWSER_BENCHMARK_OUTPUT,JSON.stringify({before,after}));
    }
  } finally { await browser.close(); }
});

test('bounded scrolling and observation replacement explain unchanged viewport and stale cursors', {skip: !process.env.BUD_BROWSER_EXECUTABLE}, async () => {
  const browser = await chromium.launch({executablePath:process.env.BUD_BROWSER_EXECUTABLE,headless:true,args:['--use-mock-keychain','--password-store=basic']});
  try {
    const page = await browser.newPage({viewport:{width:758,height:1110}});
    await page.setContent(`<style>body{margin:0;height:1214px} a{display:block;height:20px}</style>${Array.from({length:50},(_,i)=>`<a href="#${i}">Story ${i}</a>`).join('')}`);
    const cdp=await page.context().newCDPSession(page);
    const target=(await cdp.send('Target.getTargetInfo')).targetInfo.targetId; await cdp.detach();
    const engine=new Engine(browser);
    const first=await engine.execute({operation:'snapshot',target_id:target,compact:true});
    await engine.execute({operation:'scroll',target_id:target,observation_id:first.observation_id,delta_y:875});
    // Wheel dispatch acknowledges submission, not animation completion.
    await page.waitForFunction(()=>scrollY===104);
    const visible=await engine.execute({operation:'visible_dom',target_id:target,compact:true});
    assert.equal(visible.viewport.scroll_y,104);
    await engine.execute({operation:'scroll',target_id:target,observation_id:visible.observation_id,delta_y:1500});
    const again=await engine.execute({operation:'visible_dom',target_id:target,compact:true});
    assert.equal(again.viewport.scroll_y,104);
    assert.ok(again.nodes.every(n=>n.box.y+n.box.height>0 && n.box.y<1110));
    await assert.rejects(engine.execute({operation:'click',target_id:target,observation_id:first.observation_id,reference:first.text.match(/link "Story 0" \[([^\]]+)\]/)[1]}),/browser_stale_reference/);
    const fresh=await engine.execute({operation:'snapshot',target_id:target,compact:true});
    const reference=fresh.text.match(/link "Story 3" \[([^\]]+)\]/)[1];
    await engine.execute({operation:'click',target_id:target,observation_id:fresh.observation_id,reference});
    assert.match(page.url(),/#3$/);
  } finally {await browser.close();}
});

test('fresh references after BFCache restoration resolve without replaying clicks', {skip: !process.env.BUD_BROWSER_EXECUTABLE}, async () => {
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/other' ? '<title>Other</title><p>Other page</p>' :
      '<title>Cached</title><main><button onclick="window.clicks++">Apply once</button></main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.BUD_BROWSER_EXECUTABLE,headless:true,
      ignoreDefaultArgs:['--disable-back-forward-cache'],args:['--use-mock-keychain','--password-store=basic']});
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    const target = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
    const engine = new Engine(browser);
    const observe = () => engine.execute({operation:'snapshot',target_id:target,compact:true});
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url); await observe();
    await page.goto(`${url}/other`); await observe();
    await page.goto(url);
    const old = await observe();
    const reference = result => result.text.match(/button "Apply once" \[([^\]]+)\]/)[1];
    await page.evaluate(() => { window.cachedMarker = true; window.clicks = 0; });
    await page.goto(`${url}/other`); await observe();
    const history = await cdp.send('Page.getNavigationHistory');
    await cdp.send('Page.navigateToHistoryEntry', {entryId:history.entries[history.currentIndex-1].id});
    // A preserved JS marker proves this is cached restoration, not a new load.
    await page.waitForFunction(() => window.cachedMarker === true, null, {timeout:5000});
    await engine.execute({operation:'invalidate'});
    const fresh = await observe();
    await assert.rejects(engine.execute({operation:'click',target_id:target,
      observation_id:old.observation_id,reference:reference(old)}), /browser_stale_reference/);
    await engine.execute({operation:'click',target_id:target,
      observation_id:fresh.observation_id,reference:reference(fresh)});
    assert.equal(await page.evaluate(() => window.clicks), 1);
    const scope = fresh.text.match(/main \[([^\]]+)\]/)[1];
    const scoped = await engine.execute({operation:'snapshot',target_id:target,compact:true,scope});
    assert.match(scoped.text, /Apply once/);
    await engine.execute({operation:'invalidate'});
    await assert.rejects(engine.execute({operation:'click',target_id:target,
      observation_id:scoped.observation_id,reference:reference(scoped)}), /browser_stale_reference/);
    assert.equal(await page.evaluate(() => window.clicks), 1);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('snapshot references preserve iframe ownership and scoped targeting', {skip: !process.env.BUD_BROWSER_EXECUTABLE}, async () => {
  const browser = await chromium.launch({executablePath:process.env.BUD_BROWSER_EXECUTABLE,headless:true,args:['--use-mock-keychain','--password-store=basic']});
  try {
    const page = await browser.newPage();
    await page.setContent('<button onclick="window.clicked=true">Apply</button><iframe srcdoc="<main><button onclick=window.clicked=true>Apply</button></main>"></iframe>');
    const child = page.frames().find(frame => frame.parentFrame());
    await child.getByRole('button').waitFor();
    const cdp = await page.context().newCDPSession(page);
    const target = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
    await cdp.detach();
    const engine = new Engine(browser);
    const snapshot = await engine.execute({operation:'snapshot',target_id:target});
    const buttons = snapshot.nodes.filter(n => n.role === 'button');
    assert.equal(buttons.length, 2);
    await engine.execute({operation:'click',target_id:target,observation_id:snapshot.observation_id,reference:buttons[1].reference});
    assert.equal(await child.evaluate(() => window.clicked), true);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
    const scope = snapshot.nodes.find(n => n.role === 'main').reference;
    const scoped = await engine.execute({operation:'snapshot',target_id:target,scope});
    await child.evaluate(() => { window.clicked = false; });
    await engine.execute({operation:'click',target_id:target,observation_id:scoped.observation_id,
      reference:scoped.nodes.find(n => n.role === 'button').reference});
    assert.equal(await child.evaluate(() => window.clicked), true);
    assert.equal(await page.evaluate(() => window.clicked), undefined);
  } finally { await browser.close(); }
});

test('nested news layout preserves all thirty stories, metadata and compact reference actions', {skip: !process.env.BUD_BROWSER_EXECUTABLE}, async t => {
  const browser = await chromium.launch({executablePath:process.env.BUD_BROWSER_EXECUTABLE,headless:true,args:['--use-mock-keychain','--password-store=basic']});
  try {
    const page = await browser.newPage();
    await page.setContent(`<title>Nested news</title><table><tr><td><table>${Array.from({length:30},(_,i)=>`<tr><td>${i+1}.</td><td><a href="#vote${i+1}" aria-label="upvote">↑</a></td><td><a href="#story${i+1}">Example story ${i+1}</a> <a href="#domain${i+1}">example.com</a></td></tr><tr><td></td><td></td><td>${42+i} points <a href="#author${i+1}">author${i+1}</a> <a href="#time${i+1}">3 hours ago</a> <a href="#hide${i+1}">hide</a> <a href="#comments${i+1}">${i+1} comments</a></td></tr>`).join('')}</table></td></tr></table>`);
    const cdp=await page.context().newCDPSession(page);
    const target=(await cdp.send('Target.getTargetInfo')).targetInfo.targetId;await cdp.detach();
    const engine=new Engine(browser);
    const collect=async()=>{
      const pages=[];let continuation;
      do {const result=await engine.execute({operation:'snapshot',target_id:target,compact:true,continuation});pages.push(result);continuation=result.continuation;}while(continuation);
      assert.ok(pages.every(p=>Buffer.byteLength(JSON.stringify(p))<=OBSERVATION_BYTES));
      return pages;
    };
    const pages=await collect();
    const text=pages.map(p=>p.text).join('\n');
    assert.deepEqual([...text.matchAll(/link "Example story (\d+)"/g)].map(m=>Number(m[1])),Array.from({length:30},(_,i)=>i+1));
    for (const n of [3,16,30]) {
      assert.match(text,new RegExp(`author${n}"`));assert.match(text,new RegExp(`${n} comments"`));
      const current=(await collect()).map(p=>p.text).join('\n');
      const reference=current.match(new RegExp(`link "Example story ${n}" \\[([^\\]]+)\\]`))[1];
      await engine.execute({operation:'click',target_id:target,reference});
      assert.match(page.url(),new RegExp(`#story${n}$`));
    }
    t.diagnostic(`Nested 30-story fixture: bytes=${Buffer.byteLength(JSON.stringify(pages))}; pages=${pages.length}`);
  } finally {await browser.close();}
});
