/** Read-only representation spike. Owns disposable Chrome; never attaches to Bud. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { chromium } from '../../bud/browser-helper/node_modules/playwright-core/index.mjs';
import { Engine } from '../../bud/browser-helper/engine.mjs';

const output = process.argv[2];
if (!output || !process.env.BUD_BROWSER_EXECUTABLE)
  throw Error('Usage: BUD_BROWSER_EXECUTABLE=/path/to/chrome node scripts/compare-browser-accessibility.mjs /private/output-dir');
await mkdir(output, { recursive: true, mode: 0o700 });
const save = (name, data) => writeFile(join(output, name), JSON.stringify(data, null, 2), { mode: 0o600 });
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
// Matches the reference checkout's Page.snapshot/controlState; no extra pruning.
function piNodes(nodes) {
  return nodes.filter(n => !n.ignored && n.backendDOMNodeId).map(n => {
    const item = { id: n.backendDOMNodeId, role: String(n.role?.value ?? ''), name: normalize(n.name?.value) };
    if (n.value) item.value = String(n.value.value);
    for (const { name, value } of n.properties ?? []) {
      const v = value.value;
      if (['checked', 'pressed'].includes(name)) {
        if (v === 'mixed') item[name] = v;
        else if (v === true || v === 'true') item[name] = true;
        else if (v === false || v === 'false') item[name] = false;
      } else if (['selected', 'expanded', 'disabled'].includes(name) && typeof v === 'boolean') item[name] = v;
    }
    return item;
  });
}
function flatten(nodes, depth = 0) {
  return nodes.flatMap(node => {
    if (typeof node === 'string') return [{ role: 'text', text: node, depth }];
    const { children, ...n } = node;
    return [{ ...n, depth }, ...flatten(children ?? [], depth + 1)];
  });
}
function stats(value, nodes) {
  const roles = {}, counts = new Map();
  for (const n of nodes) {
    roles[n.role] = (roles[n.role] ?? 0) + 1;
    for (const text of [n.name, n.text].map(normalize).filter(Boolean)) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const duplicate = [...counts].filter(([, count]) => count > 1);
  return {
    json_bytes: bytes(value), nodes: nodes.length, roles,
    node_json_bytes: bytes(nodes),
    same_fields_bytes: bytes(nodes.map(n => ({ role: n.role, text: normalize(n.name || n.text) }))),
    repeated_exact_text_bytes: duplicate.reduce((sum, [text, count]) => sum + bytes(text) * (count - 1), 0),
    repeated_text_examples: duplicate.sort((a, b) => b[0].length * (b[1] - 1) - a[0].length * (a[1] - 1)).slice(0, 5),
    url_nodes: nodes.filter(n => n.url !== undefined).length,
    value_nodes: nodes.filter(n => n.value !== undefined).length,
    hierarchy_nodes: nodes.filter(n => n.depth !== undefined || n.childIds !== undefined).length,
    script_text_nodes: nodes.filter(n => /SML\.load|fixtureScriptNoise/.test(`${n.name ?? ''} ${n.text ?? ''}`)).length,
    native_preview_bytes: bytes(inspect(value, { depth: 5, maxArrayLength: 100, maxStringLength: 10000, getters: false, customInspect: false })),
  };
}
const fixtures = [
  { name: 'nested-records', html: `<title>Nested records</title><main><h1>Discussion</h1>${Array.from({ length: 20 }, (_, i) => `<article aria-label="Record ${i}"><h2><a href="https://example.test/record/${i}?sort=new#body">Record ${i}</a></h2><p>Author ${i}: independent assertion ${i}.</p><section aria-label="Reply ${i}"><p>Responder ${i}: counterargument ${i}.</p><script type="application/json">{"fixtureScriptNoise":"${'unused '.repeat(50)}"}</script></section></article>`).join('')}</main>` },
  { name: 'table', html: `<title>Inventory</title><main><table><caption>Inventory</caption><thead><tr><th>Item</th><th>Stock</th><th>Destination</th></tr></thead><tbody>${Array.from({ length: 120 }, (_, i) => `<tr><td>Item ${i}</td><td>${i * 3 + 7}</td><td><a href="https://example.test/item/${i}?variant=blue#details">Details ${i}</a></td></tr>`).join('')}</tbody></table></main>` },
  { name: 'article', html: `<title>Manual</title><main>${Array.from({ length: 45 }, (_, i) => `<section><h2>Procedure ${i}</h2><p>Set ${i + 12} degrees for ${i + 4} minutes. ${'Inspect the equipment before starting. '.repeat(12)}</p></section>`).join('')}</main>` },
  { name: 'mixed-inline-text', html: '<title>Inline evidence</title><main><p>BEFORE_SENTINEL <a href="https://example.test/details?x=1#end">Linked evidence</a> AFTER_SENTINEL</p><p>Stock: <strong>17</strong> units remaining.</p><button aria-pressed="mixed">Mixed toggle</button></main>' },
  { name: 'states-shadow-frame', html: `<title>Controls</title><main><label>Name<input value="FIXTURE_VALUE"></label><label>Password<input type="password" value="FAKE_PASSWORD"></label><label><input type="checkbox" checked>Enabled</label><button disabled>Unavailable</button><button aria-pressed="true">Pinned</button><details open><summary>Options</summary><p>Expanded details</p></details><div hidden>HIDDEN_SENTINEL</div><div id="shadow"></div><iframe title="Embedded" srcdoc="<h2>FRAME_SENTINEL</h2><a href='https://example.test/frame?q=1#x'>Frame link</a>"></iframe></main><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>SHADOW_SENTINEL</button>';</script>` },
  { name: 'hacker-news', url: 'https://news.ycombinator.com/' },
  { name: 'reddit', url: 'https://www.reddit.com/r/codex/' },
];
const browser = await chromium.launch({ executablePath: process.env.BUD_BROWSER_EXECUTABLE, headless: true,
  args: ['--use-mock-keychain', '--password-store=basic'] });
const report = { created_at: new Date().toISOString(), chrome: browser.version(),
  script: fileURLToPath(import.meta.url), pi_commit: 'fa838f3298673950923bdaf12bd3c1b6279cd119',
  notes: 'Fresh isolated headless Chrome. Full JSON bytes, not provider token usage. Live captures are sequential, not atomic. No screenshots or model calls.', pages: [] };
try {
  for (const fixture of fixtures) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const row = { name: fixture.name, source: fixture.url ?? 'fixed fixture', captures: [] };
    try {
      if (fixture.url) await page.goto(fixture.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      else {
        await page.route('https://fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: fixture.html }));
        await page.goto(`https://fixture.test/${fixture.name}`);
      }
      if (fixture.url) await page.waitForTimeout(1500);
      const cdp = await page.context().newCDPSession(page);
      const target = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
      const engine = new Engine(browser);
      const timed = async fn => { const start = performance.now(); const value = await fn(); return { value, ms: Math.round(performance.now() - start) }; };
      for (let sample = 0; sample < 3; sample++) {
        const captured = {};
        const operations = {
          ax_raw: () => cdp.send('Accessibility.getFullAXTree'),
          playwright_raw: () => page.locator('body').ariaSnapshotJSON({ mode: 'ai', timeout: 3000 }),
          bud_repl: () => engine.execute({ operation: 'snapshot', target_id: target, full: true, compact: true }),
        };
        // Alternate order to expose warmup rather than always favoring one path.
        for (const name of sample % 2 ? Object.keys(operations).reverse() : Object.keys(operations)) captured[name] = await timed(operations[name]);
        const info = { url: page.url(), title: await page.title() };
        const pi = { ...info, nodes: piNodes(captured.ax_raw.value.nodes) };
        const axNodes = captured.ax_raw.value.nodes.map(n => ({ ...n, role: n.role?.value, name: n.name?.value, value: n.value?.value }));
        const representations = {
          ax_raw: stats(captured.ax_raw.value, axNodes),
          pi_projection: stats(pi, pi.nodes),
          playwright_raw: stats(captured.playwright_raw.value, flatten(captured.playwright_raw.value)),
          bud_repl: stats(captured.bud_repl.value, captured.bud_repl.value.nodes),
        };
        row.captures.push({ sample, ...info, timing_ms: Object.fromEntries(Object.entries(captured).map(([k, v]) => [k, v.ms])), representations });
        await save(`${fixture.name}-${sample}.json`, { ...info, ...Object.fromEntries(Object.entries(captured).map(([k, v]) => [k, v.value])), pi_projection: pi });
      }
      await cdp.detach();
    } catch (error) { row.error = String(error); }
    finally { await page.close(); }
    report.pages.push(row);
    await save('report.json', report);
    console.log(JSON.stringify({ name: row.name, error: row.error, sizes: row.captures[0] && Object.fromEntries(Object.entries(row.captures[0].representations).map(([k, v]) => [k, { bytes: v.json_bytes, nodes: v.nodes }])) }));
  }
} finally { await browser.close(); }
console.log(`Report: ${resolve(output, 'report.json')}`);
