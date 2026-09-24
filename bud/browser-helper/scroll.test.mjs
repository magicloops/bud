import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {Engine} from './engine.mjs';
import {createBrowser} from './repl-api.mjs';

test('page scrolling survives retired evidence without reviving element handles', {skip:!process.env.BUD_BROWSER_EXECUTABLE}, async () => {
  const chrome=await chromium.launch({executablePath:process.env.BUD_BROWSER_EXECUTABLE,headless:true,args:['--use-mock-keychain','--password-store=basic']});
  try {
    const page=await chrome.newPage();
    await page.setContent('<main><button onclick="window.clicks=(window.clicks||0)+1">Apply</button><input aria-label="Note"><iframe srcdoc="first"></iframe><div style="height:20000px">Long page</div></main>');
    const target=async p=>{const c=await p.context().newCDPSession(p);try{return (await c.send('Target.getTargetInfo')).targetInfo.targetId;}finally{await c.detach();}};
    let wheels=0;const wheel=page.mouse.wheel.bind(page.mouse);page.mouse.wheel=async(...args)=>{wheels++;return wheel(...args);};
    const id=await target(page), engine=new Engine(chrome);
    const {browser}=createBrowser(async c=>{const data=await engine.execute({...c,full:true});return c.action==='inspect'?{observation:data}:data;},()=>8192);
    const tab=browser.tabs.get(id);
    const scroll=async()=>{const before=await page.evaluate(()=>scrollY), count=wheels;assert.deepEqual(await tab.scroll(100),{scroll_requested:true});assert.equal(wheels,count+1);await page.waitForFunction(y=>scrollY>y,before);};
    await scroll(); // No observation has ever been captured.
    const fresh=async()=>{const s=await tab.snapshot();return {s,handle:tab.getByRole('button',{name:'Apply'}),field:tab.getByRole('textbox',{name:'Note'})};};
    const stale=async({s,handle,field})=>{
      await scroll();
      for(const act of [()=>handle.click(),()=>handle.focus(),()=>handle.geometry(),()=>field.fill('wrong'),()=>tab.snapshot({scope:s.nodes.find(n=>n.role==='main').reference,observation_id:s.observation_id})])
        await assert.rejects(act,/browser_stale_reference/);
      assert.equal(await page.evaluate(()=>window.clicks),undefined);
    };
    let saved=await fresh();
    const nav=page.waitForEvent('framenavigated',frame=>frame!==page.mainFrame());
    await page.locator('iframe').evaluate(n=>n.srcdoc='second');await nav;
    assert.equal(await engine.document(page),saved.s.document_id);
    assert.equal(engine.snapshot,null);
    await stale(saved);
    saved=await fresh();engine.snapshot.at-=60001;await stale(saved);
    saved=await fresh();await tab.snapshot();await stale(saved);
    saved=await fresh();await engine.execute({operation:'invalidate'});await stale(saved);

    // Ordinary reads, captures and another workspace's helper do not retire it.
    saved=await fresh();const observation=engine.snapshot;
    assert.equal(await tab.evaluate(()=>document.querySelector('button').textContent),'Apply');
    await page.screenshot();
    const other=await chrome.newPage();await other.setContent('<p>Other workspace</p>');
    const otherId=await target(other);
    await new Engine(chrome).execute({operation:'snapshot',target_id:otherId});
    assert.equal(engine.snapshot,observation);
    await saved.handle.geometry();await scroll();
    // A second tab observed by THIS helper does retire the first tab's evidence.
    await engine.execute({operation:'snapshot',target_id:otherId});await stale(saved);
    for(const delta of [undefined,null,'100',0.5,NaN,Infinity,10001,-10001])
      await assert.rejects(()=>tab.scroll(delta),/browser_invalid_arguments/);
    saved=await fresh();
    await page.goto('data:text/html,<main><button>Apply</button><input aria-label="Note"><div style="height:20000px">New document</div></main>');
    assert.notEqual(await engine.document(page),saved.s.document_id);
    await stale(saved);
    await page.close();
    await assert.rejects(()=>tab.scroll(100),/browser_target_not_found/);
    assert.equal(chrome.contexts()[0].pages().length,1); // No reopen/retarget.
    assert.equal(await other.evaluate(()=>scrollY),0);
  } finally {await chrome.close();}
});
