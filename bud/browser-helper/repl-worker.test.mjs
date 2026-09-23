import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function worker(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bud-repl-test-'));
  const child = spawn(process.execPath, [new URL('./repl-worker.mjs', import.meta.url).pathname, directory], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); rmSync(directory, {recursive:true,force:true}); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  let id = 0;
  return { child, send, async run(code, bridge = () => ({})) {
    const cell_id = String(++id);
    send({ type: 'execute', cell_id, code });
    while (true) {
      const line = await lines.next();
      assert.equal(line.done, false, 'worker exited');
      const message = JSON.parse(line.value);
      assert.equal(message.cell_id, cell_id);
      if (message.type === 'result') return message;
      const data = await bridge(message.command);
      send({ type: 'operation_result', cell_id, operation_id: message.operation_id, ok: true, data });
    }
  } };
}

test('bindings and helpers persist through await and exceptions; expressions are silent', { timeout: 5000 }, async t => {
  const w = worker(t);
  assert.equal((await w.run('var n = await Promise.resolve(7); var twice = n => n * 2; n')).text, '(no output)');
  assert.equal((await w.run('n++; throw Error("partial")')).ok, false);
  assert.equal((await w.run('repl.write(twice(n))')).text, '16\n');
  assert.equal((await w.run('let lexical = 1')).ok, true);
  assert.equal((await w.run('lexical = 2; repl.write(lexical)')).text, '2\n');
});

test('unawaited browser calls drain before completion and late calls cannot join a new cell', { timeout: 5000 }, async t => {
  const w = worker(t);
  let calls = 0;
  const first = await w.run('var delayed; browser.operation({action:"read"}); setTimeout(() => { try { browser.operation({action:"late"}); } catch(e) { delayed = e.message; } }, 60)', async () => {
    calls++; await new Promise(r => setTimeout(r, 20)); return {};
  });
  assert.equal(first.ok, true);
  const next = await w.run('await new Promise(r => setTimeout(r, 100)); repl.write(delayed)', () => { calls++; });
  assert.equal(calls, 1);
  assert.match(next.text, /inactive_cell/);
});

test('output is bounded in UTF-8 and console shares the budget', { timeout: 5000 }, async t => {
  const w = worker(t);
  const r = await w.run('console.log("🐱".repeat(20000)); repl.write("tail")');
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text) <= 32768);
  assert.ok(!r.text.includes('\uFFFD'));
});

test('workers do not share globals', { timeout: 5000 }, async t => {
  const a = worker(t), b = worker(t);
  await a.run('var secret = 4');
  assert.equal((await b.run('repl.write(typeof secret)')).text, 'undefined\n');
});

 test('module imports and rejected await use the same persistent workspace', { timeout: 5000 }, async t => {
  const w = worker(t);
  const loaded = await w.run('var fs = await import("node:fs/promises"); repl.write(typeof fs.readFile)');
  assert.equal(loaded.text, 'function\n');
  const failed = await w.run('await Promise.reject(Error("await failed"))');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /await failed/);
  assert.equal((await w.run('repl.write(typeof fs.readFile)')).text, 'function\n');
});

test('late console output and exceptions cannot become a later cell result', { timeout: 5000 }, async t => {
  const w = worker(t);
  await w.run('setTimeout(() => { console.log("old secret"); }, 50)');
  const next = await w.run('await new Promise(r => setTimeout(r, 100)); repl.write("current")');
  assert.equal(next.ok, true);
  assert.equal(next.text, 'current\n');
});

test('a syntax error leaves existing variables usable', { timeout: 5000 }, async t => {
  const w = worker(t);
  await w.run('var stable = 3');
  assert.equal((await w.run('const = broken')).ok, false);
  assert.equal((await w.run('repl.write(stable)')).text, '3\n');
});

test('large snapshots stay local and follow-up cells emit only selected evidence', async t => {
  const w = worker(t);
  let calls = 0;
  const first = await w.run("var tab = await browser.tabs.open('https://example.test'); var snapshot = await tab.snapshot(); repl.write(snapshot.nodes[499].name)", command => {
    calls++;
    if (command.action === 'open') return { target_id:'owned' };
    return { nodes:Array.from({length:500},(_,i)=>({depth:1,role:'link',name:`Story ${i}`,url:`https://example.test/${i}?exact=yes#fragment`})),truncated:false };
  });
  assert.equal(first.text, 'Story 499\n');
  assert.equal(calls,2);
  assert.equal(JSON.stringify(first).includes('Story 498'),false);
  const next = await w.run('repl.write(snapshot.nodes[498].url)', () => assert.fail('cached extraction touched browser'));
  assert.equal(next.text,'https://example.test/498?exact=yes#fragment\n');
});

test('truncated output is recallable with bounded files and Unicode intact', async t => {
  const w=worker(t);
  const first=await w.run('repl.write("🐱".repeat(300000))');
  assert.equal(first.output_artifact.truncated,true);
  assert.equal(first.output_artifact.bytes,1024*1024);
  const recalled=await w.run(`var text=repl.files.read(${JSON.stringify(first.output_artifact.path)}); repl.write({length:Buffer.byteLength(text),replacement:text.includes('�')})`);
  assert.equal(recalled.text,'{"length":1048576,"replacement":false}\n');
  await w.run('for(var i=0;i<16;i++) repl.files.write("replacement")');
  assert.equal((await w.run(`repl.files.read(${JSON.stringify(first.output_artifact.path)})`)).ok,false);
  assert.equal((await w.run('repl.files.read("../secret")')).ok,false);
});

test('screenshots are explicit, two emissions per cell, never base64 in results', async t => {
  const w=worker(t);
  const bridge=c=>c.operation==='screenshot' ? {target_id:'owned',document_id:'doc',image:Buffer.from('image bytes').toString('base64')} : {image_artifact:{id:`image-${c.index}`,mime_type:'image/png',expires_at:'later'}};
  const captured=await w.run("var tab=browser.tabs.get('owned'); var shot=await tab.screenshot()",bridge);
  assert.deepEqual(captured.images,[]);
  assert.equal(JSON.stringify(captured).includes('aW1hZ2UgYnl0ZXM='),false);
  const emitted=await w.run('await repl.emitImage(shot); await repl.emitImage(shot)',bridge);
  assert.equal(emitted.images.length,2);
  const excessive=await w.run('await repl.emitImage(shot); await repl.emitImage(shot); await repl.emitImage(shot)',bridge);
  assert.equal(excessive.ok,false); assert.equal(excessive.images.length,2);
});
