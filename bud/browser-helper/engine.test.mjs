import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { Engine, sanitize } from './engine.mjs';

test('field values and implementation properties never enter snapshots', () => {
  const result = sanitize([{role:'textbox', name:'Email', text:'secret', value:'secret', children:[{role:'text',text:'secret'}]}], 'x', new Map());
  assert.deepEqual(result, [{depth:0,role:'textbox',name:'Email'}]);
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
