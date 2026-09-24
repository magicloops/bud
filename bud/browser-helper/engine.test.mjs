import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { Engine, sanitize } from './engine.mjs';


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
    const full = await engine.execute({operation:'snapshot',target_id,compact:true});
    assert.deepEqual(full.nodes.filter(n=>n.role==='text' || n.role==='strong').map(n=>n.text), ['BEFORE','AFTER','Stock:','17','units remaining.','Password']);
    // Playwright omits false in this snapshot; absence must not be invented as false.
    assert.deepEqual(full.nodes.filter(n=>n.role==='button').map(n=>n.pressed), [true,undefined,'mixed']);
    assert.equal(full.nodes.find(n=>n.role==='checkbox').checked, 'mixed');
    assert.doesNotMatch(JSON.stringify(full), /FIELD_SECRET/);
    const scoped = await engine.execute({operation:'snapshot',target_id,scope:full.nodes.find(n=>n.role==='main').reference,compact:true});
    assert.deepEqual(scoped.nodes.filter(n=>n.role==='text' || n.role==='strong').map(n=>n.text), ['BEFORE','AFTER','Stock:','17','units remaining.']);
    assert.equal(scoped.nodes.find(n=>n.name==='Mixed').pressed,'mixed');
    assert.equal(scoped.nodes.find(n=>n.role==='checkbox').checked,'mixed');
    const visible = await engine.execute({operation:'visible_dom',target_id,compact:true});
    assert.equal(visible.nodes.find(n=>n.name==='Mixed').pressed, 'mixed');
    assert.doesNotMatch(JSON.stringify(visible), /FIELD_SECRET/);
    const unnormalized = await engine.execute({operation:'snapshot',target_id});
    assert.ok(unnormalized.nodes.some(n=>n.text==='units remaining.'));
    assert.equal(unnormalized.nodes.find(n=>n.name==='Mixed').pressed, 'mixed');
  } finally { await browser.close(); }
});
test('managed Chrome structured snapshots, scope, retained capture and actions', {skip: !process.env.BUD_BROWSER_EXECUTABLE}, async () => {
  const browser = await chromium.launch({ executablePath: process.env.BUD_BROWSER_EXECUTABLE, headless: true, args:['--use-mock-keychain','--password-store=basic'] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<h1>Stories</h1><ol>${Array.from({length:300},(_,i)=>`<li><a href="#story${i+1}">Story ${i+1}</a></li>`).join('')}</ol><label>Email<input value="secret"></label><button>Duplicate</button><button>Duplicate</button>`);
    const session = await page.context().newCDPSession(page);
    const target = (await session.send('Target.getTargetInfo')).targetInfo.targetId;
    await session.detach();
    const engine = new Engine(browser);
    const observe = await engine.execute({operation:'snapshot',target_id:target});
    assert.match(JSON.stringify(observe.nodes), /Story 16/);
    assert.ok(!JSON.stringify(observe.nodes).includes('secret'));
    assert.equal(observe.truncated,false);
    assert.equal(observe.nodes.filter(n=>n.role==='link').length,300);
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
    assert.match(JSON.stringify(scoped.nodes),/Story 16/);
    assert.doesNotMatch(JSON.stringify(scoped.nodes),/Email/);
    engine.snapshot.at -= 60001;
    await assert.rejects(engine.execute({operation:'click',target_id:target,reference:scoped.nodes.find(n=>n.role==='link').reference}), /browser_stale_reference/);
    await engine.execute({operation:'snapshot',target_id:target});
    const oldId = engine.snapshot.id;
    await page.goto('about:blank');
    await assert.rejects(engine.execute({operation:'click',target_id:target,observation_id:oldId,locator:{role:'link',name:'Story 3'}}), /browser_stale_reference/);
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
    await assert.rejects(engine.execute({operation:'click',target_id:target,observation_id:first.observation_id,reference:first.nodes.find(n=>n.name==='Story 0').reference}),/browser_stale_reference/);
    const fresh=await engine.execute({operation:'snapshot',target_id:target,compact:true});
    const reference=fresh.nodes.find(n=>n.name==='Story 3').reference;
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
    const reference = result => result.nodes.find(n=>n.name==='Apply once').reference;
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
    const scope = fresh.nodes.find(n=>n.role==='main').reference;
    const scoped = await engine.execute({operation:'snapshot',target_id:target,compact:true,scope});
    assert.match(JSON.stringify(scoped.nodes), /Apply once/);
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
    const collect=()=>engine.execute({operation:'snapshot',target_id:target,compact:true});
    const captured=await collect();
    assert.deepEqual(captured.nodes.filter(n=>n.role==='link' && n.name.startsWith('Example story ')).map(n=>n.name),Array.from({length:30},(_,i)=>`Example story ${i+1}`));
    for (const n of [3,16,30]) {
      assert.ok(captured.nodes.some(node=>node.name===`author${n}`));
      assert.ok(captured.nodes.some(node=>node.name===`${n} comments`));
      const current=await collect();
      const reference=current.nodes.find(node=>node.name===`Example story ${n}`).reference;
      await engine.execute({operation:'click',target_id:target,reference});
      assert.match(page.url(),new RegExp(`#story${n}$`));
    }
    t.diagnostic(`Nested 30-story fixture: bytes=${Buffer.byteLength(JSON.stringify(captured))}; pages=1`);
  } finally {await browser.close();}
});
