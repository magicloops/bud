import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotView} from './repl-snapshot.mjs';
import {createBrowser} from './repl-api.mjs';
import {chromium} from 'playwright-core';
import {Engine} from './engine.mjs';

const source = () => ({observation_id:'capture-one',target_id:'tab',document_id:'doc',coverage:'accessible_dom',limitations:['Only loaded nodes'],truncated:false,
  nodes:[{depth:0,role:'document',name:'Title'}, ...Array.from({length:12},(_,i)=>({depth:1,role:'link',name:'Same label',reference:`capture-one:e${i}`,url:`https://example.test/?q=${'x'.repeat(1000)}#keep`})),
    {depth:1,role:'generic',cursor:'pointer',reference:'capture-one:e99',expanded:false,checked:'mixed',text:'Expand'}]});
test('compact view retains exact source, factors URLs, preserves identities and states',()=>{
 const data=source(), before=JSON.stringify(data), calls=[];
 const s=snapshotView(data,(ref,obs)=>{calls.push({ref,obs});return {click(){}};});
 const text=s.format();
 assert.equal(JSON.stringify(s),before);
 assert.equal(text.split('?q=').length,2);
 assert.doesNotMatch(text,/undefined|capture-one:e/);
 assert.match(text,/expanded=false checked="mixed"|checked="mixed" expanded=false/);
 assert.match(text,/cursor="pointer"/);
 assert.equal(s.url('u1'),data.nodes[1].url);
 s.getByReference('e2');s.getByReference('e3');
 assert.deepEqual(calls,[{ref:'capture-one:e0',obs:'capture-one'},{ref:'capture-one:e1',obs:'capture-one'}]);
 assert.throws(()=>s.getByReference('e1'),/invalid_reference/);
 assert.throws(()=>s.url('u2'),/invalid_url/);
 assert.ok(Buffer.byteLength(text)<Buffer.byteLength(before)/2);
});
test('selection is scoped, preserves order, and resolves exact distinct URLs',()=>{
 const data=source();data.nodes[2].url=data.nodes[1].url.replace('#keep','#other');
 const s=snapshotView(data,()=>{}), small=s.format({nodes:[s.nodes[3],s.nodes[2]]});
 assert.ok(small.indexOf('[e3]')<small.indexOf('[e4]'));
 assert.match(small,/2\/2 selected nodes/);
 assert.match(small,/u1=/);assert.match(small,/u2=/);
 assert.notEqual(s.url('u1'),s.url('u2'));
 assert.throws(()=>s.format({nodes:[{...s.nodes[1]}]}),/snapshot_node_required/);
});
test('Unicode and giant values have explicit bounded record previews',()=>{
 const data=source();data.nodes[4].name='🐱'.repeat(10000);
 const s=snapshotView(data,()=>{}),text=s.format({maxBytes:1024});
 assert.ok(Buffer.byteLength(text)<=1024);assert.doesNotMatch(text,/�/);
 assert.match(text,/PREVIEW/);assert.match(text,/long exact URL retained/);
 assert.match(text,/3\/14 selected nodes|4\/14 selected nodes/);
 assert.equal(s.nodes[4].name.length,20000);
 assert.equal(s.url('u1'),data.nodes[1].url);
});
test('retained snapshot handles never adopt newer observation or foreign tab bindings',async()=>{
 const calls=[];
 let version=0;
 const {browser}=createBrowser(async c=>{calls.push(c);return c.action==='repl'?{...source(),observation_id:String(++version)}:{observation:{}};});
 const t=browser.tabs.get('owned'),s=await t.snapshot();await t.snapshot();
 await s.getByReference('e2').click();
 assert.equal(calls.at(-1).observation_id,'1');assert.equal(calls.at(-1).target_id,'owned');
 const other=await browser.tabs.get('other').snapshot();await other.getByReference('e2').click();
 assert.equal(calls.at(-1).target_id,'other');assert.equal(calls.at(-1).observation_id,'3');
});

test('real Chrome short handles click exactly once and reject recapture, navigation, invalidation and closure', {skip:!process.env.BUD_BROWSER_EXECUTABLE},async t=>{
 const chrome=await chromium.launch({executablePath:process.env.BUD_BROWSER_EXECUTABLE,headless:true,args:['--use-mock-keychain','--password-store=basic']});t.after(()=>chrome.close());
 const page=await chrome.newPage();await page.setContent('<button onclick="window.clicks=(window.clicks||0)+1">Apply</button>');
 const cdp=await page.context().newCDPSession(page);const target=(await cdp.send('Target.getTargetInfo')).targetInfo.targetId;await cdp.detach();
 const engine=new Engine(chrome);
 const {browser}=createBrowser(async c=>{const result=await engine.execute({...c,full:true,compact:true});return c.action==='inspect'?{observation:result}:result;});
 const tab=browser.tabs.get(target);
 const get=async()=>{const s=await tab.snapshot();const key=`e${s.nodes.findIndex(n=>n.role==='button')+1}`;assert.ok(s.format().includes(`[${key}]`));return s.getByReference(key);};
 const first=await get();await first.click();assert.equal(await page.evaluate(()=>window.clicks),1);
 await get();await assert.rejects(first.click());assert.equal(await page.evaluate(()=>window.clicks),1);
 const second=await get();await page.goto('data:text/html,<button>Apply</button>');await assert.rejects(second.click());
 const third=await get();await engine.execute({operation:'invalidate'});await assert.rejects(third.click());
 const fourth=await get();await page.close();await assert.rejects(fourth.click());
});

test('explicit view sizes cannot exceed remaining cell space or split records',()=>{
 const s=snapshotView(source(),()=>{},()=>700);
 const text=s.format({maxBytes:32768});
 assert.ok(Buffer.byteLength(text)<700);
 assert.match(text,/PREVIEW/);
 const small=snapshotView(source(),()=>{},()=>300).format();
 assert.match(small,/metadata exceeds view budget/);
});
