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
  return { child, send, async run(code, bridge = () => ({}), trace = false) {
    const cell_id = String(++id);
    send({ type: 'execute', cell_id, code, trace });
    while (true) {
      const line = await lines.next();
      assert.equal(line.done, false, 'worker exited');
      const message = JSON.parse(line.value);
      assert.equal(message.cell_id, cell_id);
      if (message.type === 'result') return message;
      try {
        const data = await bridge(message.command);
        send({ type: 'operation_result', cell_id, operation_id: message.operation_id, ok: true, data });
      } catch (error) {
        send({ type: 'operation_result', cell_id, operation_id: message.operation_id, ok: false, error: error.message });
      }
    }
  } };
}

test('bindings and helpers persist through await and exceptions; completion values are displayed', { timeout: 5000 }, async t => {
  const w = worker(t);
  assert.equal((await w.run('var n = await Promise.resolve(7); var twice = n => n * 2; n')).text, '7\n');
  assert.equal((await w.run('n++; throw Error("partial")')).ok, false);
  assert.equal((await w.run('console.log(twice(n))')).text, '16\n');
  assert.equal((await w.run('let lexical = 1')).ok, true);
  assert.equal((await w.run('lexical = 2; console.log(lexical)')).text, '2\n');
});

test('unawaited browser calls drain before completion and late calls cannot join a new cell', { timeout: 5000 }, async t => {
  const w = worker(t);
  let calls = 0;
  const first = await w.run('var delayed; browser.operation({action:"read"}); setTimeout(() => { try { browser.operation({action:"late"}); } catch(e) { delayed = e.message; } }, 60)', async () => {
    calls++; await new Promise(r => setTimeout(r, 20)); return {};
  });
  assert.equal(first.ok, true);
  const next = await w.run('await new Promise(r => setTimeout(r, 100)); console.log(delayed)', () => { calls++; });
  assert.equal(calls, 1);
  assert.match(next.text, /inactive_cell/);
});

test('output is bounded in UTF-8 and console shares the budget', { timeout: 5000 }, async t => {
  const w = worker(t);
  const r = await w.run('console.log("🐱".repeat(20000)); console.log("tail")');
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text) <= 8192);
  assert.ok(!r.text.includes('\uFFFD'));
});

test('workers do not share globals', { timeout: 5000 }, async t => {
  const a = worker(t), b = worker(t);
  await a.run('var secret = 4');
  assert.equal((await b.run('console.log(typeof secret)')).text, 'undefined\n');
});

 test('module imports and rejected await use the same persistent workspace', { timeout: 5000 }, async t => {
  const w = worker(t);
  const loaded = await w.run('var fs = await import("node:fs/promises"); console.log(typeof fs.readFile)');
  assert.equal(loaded.text, 'function\n');
  const failed = await w.run('await Promise.reject(Error("await failed"))');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /await failed/);
  assert.equal((await w.run('console.log(typeof fs.readFile)')).text, 'function\n');
});

test('late console output and exceptions cannot become a later cell result', { timeout: 5000 }, async t => {
  const w = worker(t);
  await w.run('setTimeout(() => { console.log("old secret"); }, 50)');
  const next = await w.run('await new Promise(r => setTimeout(r, 100)); console.log("current")');
  assert.equal(next.ok, true);
  assert.equal(next.text, 'current\n');
});

test('a syntax error leaves existing variables usable', { timeout: 5000 }, async t => {
  const w = worker(t);
  await w.run('var stable = 3');
  assert.equal((await w.run('const = broken')).ok, false);
  assert.equal((await w.run('console.log(stable)')).text, '3\n');
});

test('large snapshots stay local and follow-up cells emit only selected evidence', async t => {
  const w = worker(t);
  let calls = 0;
  const first = await w.run("var tab = await browser.tabs.open('https://example.test'); var snapshot = await tab.snapshot(); console.log(snapshot.nodes[499].name)", command => {
    calls++;
    if (command.action === 'open') return { target_id:'owned' };
    return { nodes:Array.from({length:500},(_,i)=>({depth:1,role:'link',name:`Story ${i}`,url:`https://example.test/${i}?exact=yes#fragment`})),truncated:false };
  });
  assert.equal(first.text, 'Story 499\n');
  assert.equal(calls,2);
  assert.equal(JSON.stringify(first).includes('Story 498'),false);
  const next = await w.run('console.log(snapshot.nodes[498].url)', () => assert.fail('cached extraction touched browser'));
  assert.equal(next.text,'https://example.test/498?exact=yes#fragment\n');
});

test('truncated output is recallable with bounded files and Unicode intact', async t => {
  const w=worker(t);
  const first=await w.run('console.log("🐱".repeat(300000))');
  assert.equal(first.output_artifact.truncated,true);
  assert.equal(first.output_artifact.bytes,1024*1024);
  const recalled=await w.run(`var text=repl.files.read(${JSON.stringify(first.output_artifact.path)}); console.log(JSON.stringify({length:Buffer.byteLength(text),replacement:text.includes('�')}))`);
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


test('overflow preserves preceding JSON and labels excerpts without replaying actions', async t => {
  const w = worker(t);
  let actions = 0;
  const result = await w.run(`
    await browser.tabs.open('https://example.test');
    var large = {records: Array.from({length:800}, (_,i) => ({id:i,name:'Item '+i}))};
    console.log(JSON.stringify({opened:true})); console.log(JSON.stringify(large)); console.log('tail');
  `, () => { actions++; return {target_id:'owned'}; });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.deepEqual(JSON.parse(result.text.split('\n')[0]), {opened:true});
  assert.equal(result.output_artifact.truncated, false);
  const recall = await w.run(`
    var lines = repl.files.read(${JSON.stringify(result.output_artifact.path)}).trim().split('\\n');
    console.log(JSON.stringify({first:JSON.parse(lines[0]),last:JSON.parse(lines[1]).records.at(-1),tail:lines[2]}));
  `, () => assert.fail('output recovery must not repeat browser operations'));
  assert.equal(recall.ok, true, recall.error);
  assert.deepEqual(JSON.parse(recall.text), {first:{opened:true},last:{id:799,name:'Item 799'},tail:'tail'});
  assert.equal(actions, 1);
});

test('explicit output expansion is cell-local, bounded and shares the console budget', async t => {
  const w = worker(t);
  const expanded = await w.run(`repl.setOutputBudget(32768); console.log(JSON.stringify({value:'é'.repeat(12000)})); console.log('end')`);
  assert.equal(expanded.truncated, false);
  assert.ok(Buffer.byteLength(expanded.text) > 16384);
  assert.ok(Buffer.byteLength(expanded.text) <= 32768);
  const fits = await w.run(`console.log('x'.repeat(8191))`);
  assert.equal(fits.truncated, false);
  assert.equal(Buffer.byteLength(fits.text), 8192);
  const exceeds = await w.run(`console.log('x'.repeat(12000))`);
  assert.equal(exceeds.truncated, true);
  assert.ok(Buffer.byteLength(exceeds.text) <= 8192);
  const normal = await w.run(`console.log(JSON.stringify({value:'é'.repeat(12000)}))`);
  assert.equal(normal.ok, true);
  assert.equal(normal.truncated, true);
  assert.match(normal.text, /INCOMPLETE OUTPUT EXCERPT/);
  const recalled = await w.run(`console.log(JSON.parse(repl.files.read(${JSON.stringify(normal.output_artifact.path)})).value.length)`);
  assert.equal(recalled.text, '12000\n');
  const shared = await w.run(`repl.setOutputBudget(1024); console.log('x'.repeat(1020)); console.log({ok:true})`);
  assert.equal(shared.text, 'x'.repeat(1020)+'\n');
  assert.equal(shared.truncated, true);
  for (const value of ['0','1023','32769','1.5','NaN','Infinity','"8192"']) {
    const invalid = await w.run(`repl.setOutputBudget(${value})`);
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /browser_output_budget_invalid/);
  }
  const late = await w.run(`console.log('before'); repl.setOutputBudget(32768)`);
  assert.equal(late.ok, false);
  assert.equal(late.text, 'before\n');
  assert.match(late.error, /browser_output_budget_already_used/);
});

test('selective evidence across page structures preserves relationships, coverage and exact URLs', async t => {
  // These are deterministic emission measurements, not provider-token claims.
  const cases = [
    {kind:'search',role:'link',choose:`s.nodes.filter(n=>n.role==='link' && n.name==='Result 73')`},
    {kind:'table',role:'row',choose:`s.nodes.filter(n=>n.role==='row').slice(71,74)`},
    {kind:'form',role:'textbox',choose:`s.nodes.filter(n=>n.name==='Field 73')`},
    {kind:'article',role:'paragraph',choose:`s.nodes.filter(n=>n.name==='Section 73')`},
    {kind:'dynamic',role:'group',choose:`s.nodes.filter(n=>n.name==='Record 73')`},
  ];
  const labels = {search:'Result',table:'Row',form:'Field',article:'Section',dynamic:'Record'};
  for (const fixture of cases) {
    const w = worker(t);
    const nodes = Array.from({length:120}, (_,i)=>({depth:1,role:fixture.role,
      name:`${labels[fixture.kind]} ${i}`,text:`Entity ${i}: `+'supporting detail '.repeat(12),
      url:`https://example.test/${i}?q=exact%20value#part-${i}`,reference:`observation:${i}`}));
    const capture = {nodes,observation_id:'observation',coverage:fixture.kind==='dynamic'?'partial':'complete',
      limitations:fixture.kind==='dynamic'?['Only loaded records are available']:[]};
    const broad = await w.run(`var tab=browser.tabs.get('owned'); var s=await tab.snapshot(); console.log(JSON.stringify(s))`,()=>capture);
    assert.equal(broad.truncated, true);
    const selected = await w.run(`var selected=${fixture.choose}; console.log(JSON.stringify({coverage:s.coverage,limitations:s.limitations,selected}))`,
      ()=>assert.fail('selection must use retained snapshot'));
    assert.equal(selected.truncated, false);
    assert.equal(selected.ok, true);
    const value = JSON.parse(selected.text);
    assert.deepEqual(value.coverage,capture.coverage);
    assert.deepEqual(value.limitations,capture.limitations);
    assert.ok(value.selected.some(n=>n.reference==='observation:73'));
    for (const node of value.selected) assert.deepEqual(node,nodes[Number(node.reference.split(':')[1])]);
    const fullBytes = Buffer.byteLength(JSON.stringify(capture)+'\n');
    const selectedBytes = Buffer.byteLength(selected.text);
    assert.ok(selectedBytes < 8192);
    t.diagnostic(`${fixture.kind}: full=${fullBytes} selected=${selectedBytes} UTF-8 bytes`);
  }
});

test('native completions, console ordering and silence have one output path', async t => {
  const w = worker(t);
  for (const [code, text] of [
    ['typeof repl.write', 'undefined\n'], ['var saved = 3', '(no output)'],
    ['void 0', '(no output)'], ['undefined', '(no output)'], ['null', 'null\n'],
    ['false', 'false\n'], ['0', '0\n'], ['""', '\n'],
    ['saved = 4;', '4\n'], ['{ saved + 1 }', '5\n'],
    ['await Promise.resolve(6)', '6\n'], ['({answer: 7})', '{ answer: 7 }\n'],
    ['console.log("count=%d", saved)', 'count=4\n'],
    ['console.log("first"); await Promise.resolve("last")', 'first\nlast\n'],
    ['console.log(saved); saved', '4\n4\n'],
  ]) {
    const result = await w.run(code);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.text, text, code);
  }
  const failed = await w.run('console.log("before"); throw Error("failed")');
  assert.equal(failed.ok, false);
  assert.equal(failed.text, 'before\n');
});

test('inspection previews are bounded, support cycles, and do not invoke getters or custom hooks', async t => {
  const w = worker(t);
  const result = await w.run(`var visits=0; var obj={big:1n,get secret(){visits++;return 'secret';}};
    obj.self=obj; obj[Symbol.for('nodejs.util.inspect.custom')]=()=>{visits++;return 'custom'};
    obj`);
  assert.equal(result.ok, true, result.error);
  assert.match(result.text, /1n/);
  assert.match(result.text, /Circular/);
  assert.match(result.text, /Getter/);
  assert.equal((await w.run('visits')).text, '0\n');
  const preview = await w.run('Array.from({length:150},(_,i)=>i)');
  assert.match(preview.text, /50 more items/);
  const binary = await w.run('Buffer.from("private screenshot pixels")');
  assert.match(binary.text, /Binary value: 25 bytes/);
  assert.doesNotMatch(binary.text, /private screenshot pixels|70 72 69/);
  assert.equal(binary.images.length, 0);
  assert.match((await w.run('new Uint8Array(100)')).text, /Binary value: 100 bytes/);
  const revoked = await w.run('var revoked=Proxy.revocable({},{}); revoked.revoke(); revoked.proxy');
  assert.equal(revoked.ok, true);
  assert.match(revoked.text, /Value could not be displayed/);
});

test('final overflow drains actions once and shares capture with console', async t => {
  const w = worker(t);
  let calls = 0;
  const result = await w.run(`var effect=browser.operation({action:'mutate'});
    console.log('before'); 'é'.repeat(10000)`, async () => {
      calls++; await new Promise(r=>setTimeout(r,20)); return {ok:true};
    });
  assert.equal(result.ok, true, result.error);
  assert.equal(calls, 1);
  assert.equal(result.truncated, true);
  assert.ok(result.text.startsWith('before\n[INCOMPLETE OUTPUT EXCERPT'));
  const recall = await w.run(`var capture=repl.files.read(${JSON.stringify(result.output_artifact.path)}); capture.endsWith('é'.repeat(10000)+'\\n')`);
  assert.equal(recall.text, 'true\n');
  assert.equal(calls, 1);
});


test('a caught bridge failure still suppresses the successful completion value', async t => {
  const w = worker(t);
  const result = await w.run(`console.log('before');
    try { await browser.operation({action:'mutate'}); } catch {}
    'must not display'`, () => { throw Error('browser_outcome_unknown'); });
  assert.equal(result.ok, false);
  assert.equal(result.text, 'before\n');
  assert.match(result.error, /browser_outcome_unknown/);
});


test('diagnostic output is opt-in and includes formatted bytes omitted inline', async t => {
  const w = worker(t);
  const normal = await w.run("console.log('normal')");
  assert.equal(normal._trace_output, undefined);
  const captured = await w.run("console.log('first'); console.log('é'.repeat(10000)); console.log('last')", undefined, true);
  assert.ok(captured.text.startsWith('first\n[INCOMPLETE OUTPUT EXCERPT'));
  assert.ok(Buffer.byteLength(captured.text) <= 8192);
  assert.equal(captured.truncated, true);
  assert.equal(captured._trace_output.content, 'first\n'+'é'.repeat(10000)+'\nlast\n');
  assert.equal(captured._trace_output.bytes, Buffer.byteLength(captured._trace_output.content));
  assert.equal(captured._trace_output.truncated, false);
  assert.equal((await w.run('void 0'))._trace_output, undefined);
  const bounded = await w.run("console.log('🐱'.repeat(300000))", undefined, true);
  assert.equal(bounded._trace_output.truncated, true);
  assert.equal(Buffer.byteLength(bounded._trace_output.content), 1024 * 1024);
  assert.ok(bounded._trace_output.bytes > 1024 * 1024);
});

test('snapshot views budget complete records after earlier writes and select retained data without recapture', async t => {
  const w = worker(t);
  const nodes = Array.from({length:800}, (_,i) => ({depth:1,role:'link',name:`Entry ${i}`,
    reference:`capture:${i}`,url:`https://example.test/?q=${'x'.repeat(900)}#keep`}));
  const result = await w.run(`var tab=browser.tabs.get('owned'); var s=await tab.snapshot();
    console.log('Earlier evidence'); console.log(s.format({maxBytes:32768}));`, () => ({nodes,
    observation_id:'capture',target_id:'owned',document_id:'doc',truncated:false,
    coverage:'accessible_dom',limitations:['Only loaded content']}));
  assert.equal(result.ok,true,result.error);
  assert.equal(result.truncated,false);
  assert.ok(Buffer.byteLength(result.text)<=8192);
  assert.match(result.text,/^Earlier evidence\nSnapshot /);
  assert.match(result.text,/PREVIEW/);
  assert.doesNotMatch(result.text,/INCOMPLETE OUTPUT EXCERPT/);
  const next=await w.run(`console.log(s.format({nodes:[s.nodes[99]]}));`,()=>assert.fail('recaptured'));
  assert.equal(next.truncated,false);
  assert.match(next.text,/\[e100\]/);
  assert.match(next.text,/1\/1 selected nodes/);
  const exact=await w.run(`console.log(s.url('u1')===s.nodes[99].url);`);
  assert.equal(exact.text,'true\n');
});
