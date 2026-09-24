import { chromium } from 'playwright-core';
import { randomUUID, randomBytes } from 'node:crypto';
import { compactNodes, compactPage } from './compact.mjs';
import { bounded } from './repl-artifacts.mjs';

const referenceNamespace = randomBytes(8).toString('base64url');
let observationSequence = 0;

const TTL = 60_000, MAX_BYTES = 2 * 1024 * 1024, PAGE_BYTES = 24 * 1024;
const fields = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
const fail = code => { throw new Error(code); };

// Allowlist output rather than forwarding Playwright internals or field values.
export function sanitize(nodes, prefix, refs, depth = 0, result = []) {
  if (depth > 128 || result.length > 20000) fail('browser_observation_limit');
  for (const node of nodes) {
    if (result.length >= 20000) fail('browser_observation_limit');
    if (typeof node === 'string') {
      result.push({ depth, role: 'text', text: node });
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    const item = { depth, role: node.role ?? 'text' };
    if (typeof node.name === 'string') item.name = node.name;
    if (item.role === 'link' && typeof node.url === 'string') item.url = node.url;
    if (!fields.has(item.role) && typeof node.text === 'string') item.text = node.text;
    if (typeof node.ref === 'string') {
      item.reference = `${prefix}:${node.ref}`;
      refs.set(item.reference, node.ref);
    }
    if (node.box) item.box = node.box;
    if (node.cursor === 'pointer') item.cursor = 'pointer';
    for (const key of ['disabled', 'checked', 'pressed', 'expanded', 'selected', 'level']) {
      if (typeof node[key] === 'boolean' || typeof node[key] === 'number' ||
        (['checked', 'pressed'].includes(key) && node[key] === 'mixed')) item[key] = node[key];
    }
    result.push(item);
    if (!fields.has(item.role) && Array.isArray(node.children)) sanitize(node.children, prefix, refs, depth + 1, result);
  }
  return result;
}

// Diagnostic copy of the SAME upstream tree, before flattening/filtering.
// Preserve unknown structure, but never retain field values or descendants.
export function traceSnapshot(raw) {
  const redact = node => {
    if (Array.isArray(node)) return node.map(redact);
    if (!node || typeof node !== 'object') return node;
    const field = fields.has(node.role);
    return Object.fromEntries(Object.entries(node)
      .filter(([key]) => key !== 'value' && !(field && ['text', 'children'].includes(key)))
      .map(([key, value]) => [key, redact(value)]));
  };
  try {
    const text = JSON.stringify(redact(raw));
    const content = bounded(text, 1024 * 1024);
    return { content, bytes: Buffer.byteLength(text), truncated: content !== text };
  } catch { return { unavailable: true }; }
}

// Resolve within the observed frame rather than letting aria-ref's retained fN
// prefix select a frame. BFCache can preserve that prefix across frame recreation.
function bindReferences(nodes, prefix, refs, frame) {
  for (const node of nodes) {
    let childFrame = frame;
    if (typeof node.ref === 'string' && refs.has(`${prefix}:${node.ref}`)) {
      const locator = frame.locator(':root').locator(`aria-ref=${node.ref}`);
      refs.set(`${prefix}:${node.ref}`, { locator, frame });
      if (node.role === 'iframe') childFrame = locator.contentFrame();
    }
    if (!fields.has(node.role) && Array.isArray(node.children)) bindReferences(node.children, prefix, refs, childFrame);
  }
}

export class Engine {
  static async connect(endpoint) {
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 8000 });
    return new Engine(browser);
  }
  constructor(browser) { this.browser = browser; this.snapshot = null; this.watched = new WeakSet(); this.navigation = 0; this.frames = new Map(); }
  async page(target) {
    // Rust creates tabs over its own CDP connection. Playwright can receive the
    // target-created event after Rust's create acknowledgement; wait only for
    // inventory propagation, never recreate a tab or repeat a page action.
    const deadline = performance.now() + 1000;
    do {
      for (const context of this.browser.contexts()) for (const page of context.pages()) {
        const cdp = await context.newCDPSession(page);
        try {
          const { targetInfo } = await cdp.send('Target.getTargetInfo');
          if (targetInfo.targetId === target) {
            if (!this.watched.has(page)) {
              this.watched.add(page);
              page.on('framenavigated', () => { this.navigation++; if (this.snapshot?.target === target) this.snapshot = null; });
              page.on('close', () => { if (this.snapshot?.target === target) this.snapshot = null; });
            }
            return page;
          }
        } finally { await cdp.detach(); }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (performance.now() < deadline);
    fail('browser_target_not_found');
  }
  async document(page) {
    const cdp = await page.context().newCDPSession(page);
    try { return (await cdp.send('Page.getFrameTree')).frameTree.frame.loaderId; }
    finally { await cdp.detach(); }
  }
  async current(page, command) {
    const s = this.snapshot;
    const document = await this.document(page);
    if (s !== this.snapshot || !s || Date.now() - s.at > TTL || s.target !== command.target_id ||
      (command.observation_id && command.observation_id !== s.id) ||
      document !== s.document) fail('browser_stale_reference');
    return s;
  }
  ref(snapshot, reference) {
    const ref = snapshot.refs.get(reference);
    if (!ref) fail('browser_stale_reference');
    return ref.locator;
  }
  pageResult(s, offset) {
    if (s.full) return { target_id:s.target, document_id:s.document, observation_id:s.id, viewport:s.viewport,
      nodes:s.nodes, truncated:false, continuation:null, expires_in_ms:Math.max(0, TTL-(Date.now()-s.at)),
      coverage:s.scoped ? 'accessible_subtree' : s.mode === 'visible_dom' ? 'visible_accessible_dom' : 'accessible_dom',
      limitations:['Closed shadow roots, inaccessible embedded documents and non-rendered virtualized content may be omitted.'] };
    if (s.compact) return compactPage(s, offset);
    let bytes = 0, end = offset;
    for (; end < s.nodes.length; end++) {
      const size = Buffer.byteLength(JSON.stringify(s.nodes[end]));
      if (bytes + size > PAGE_BYTES) break;
      bytes += size;
    }
    if (end === offset && offset < s.nodes.length) fail('browser_observation_limit');
    const nodes = s.nodes.slice(offset, end);
    const cursor = end < s.nodes.length ? `${s.id}:${end}` : null;
    return { target_id: s.target, document_id: s.document, observation_id: s.id,
      viewport: s.viewport, nodes, text: nodes.map(n => `${'  '.repeat(Math.min(n.depth, 24))}${n.role}${n.name ? ` ${JSON.stringify(n.name)}` : ''}${n.text ? `: ${JSON.stringify(n.text)}` : ''}${n.cursor === 'pointer' ? ' [cursor=pointer]' : ''}${n.reference ? ` [ref=${n.reference}]` : ''}${n.url !== undefined ? ` url=${JSON.stringify(n.url)}` : ''}`).join('\n'),
      truncated: cursor !== null, continuation: cursor, expires_in_ms: Math.max(0, TTL - (Date.now() - s.at)),
      coverage: 'accessible_dom', limitations: ['Closed shadow roots and inaccessible embedded documents may be omitted.'] };
  }
  async execute(c) {
    this.stage = 'resolve_page';
    if (c.operation === 'invalidate') { this.snapshot = null; this.frames.clear(); return {}; }
    const page = await this.page(c.target_id);
    // Page input has no element reference. Authority/ownership and serialization
    // remain daemon-owned; a retired snapshot must not block this exact tab.
    if (c.operation === 'scroll') {
      if (!Number.isInteger(c.delta_y) || Math.abs(c.delta_y) > 10000) fail('browser_invalid_arguments');
      this.stage = 'validate_action';
      await page.mouse.wheel(0, c.delta_y);
      return { scroll_requested: true };
    }
    if (c.operation === 'frames') {
      this.frames.clear();
      return page.frames().map(frame => { const id = randomUUID(); this.frames.set(id, { frame, target: c.target_id, navigation: this.navigation });
        return { frame_id: id, url: frame.url(), name: frame.name(), main: frame === page.mainFrame() }; });
    }
    if (c.operation === 'evaluate') {
      const saved = c.frame_id ? this.frames.get(c.frame_id) : null;
      if (c.frame_id && (!saved || saved.target !== c.target_id || saved.navigation !== this.navigation || saved.frame.isDetached())) fail('browser_stale_reference');
      const frame = saved?.frame ?? page.mainFrame();
      // Source is serialized explicitly; no worker lexical environment crosses.
      const result = await frame.evaluate(({ source, argument }) => (0, eval)('(' + source + ')')(argument), { source: c.source, argument: c.argument });
      const encoded = JSON.stringify(result ?? null);
      if (Buffer.byteLength(encoded) > MAX_BYTES) fail('browser_observation_limit');
      return JSON.parse(encoded);
    }
    if (c.operation === 'page_info') return { target_id: c.target_id, document_id: await this.document(page), title: await page.title(), url: page.url() };
    if (c.operation === 'snapshot' || c.operation === 'visible_dom') {
      if (c.continuation) {
        this.stage = 'validate_snapshot';
        const s = await this.current(page, c);
        const [id, raw] = c.continuation.split(':');
        const offset = Number(raw);
        if (s.mode !== c.operation || s.compact !== (c.compact === true) || id !== s.id || !Number.isSafeInteger(offset) || offset < 0 || offset >= s.nodes.length) fail('browser_stale_reference');
        return this.pageResult(s, offset);
      }
      let root = page.locator('body'), frame = page;
      if (c.scope) {
        const current = await this.current(page, c);
        root = this.ref(current, c.scope);
        frame = current.refs.get(c.scope).frame;
      }
      const document = await this.document(page), navigation = this.navigation;
      this.stage = 'snapshot';
      const raw = await root.ariaSnapshotJSON({ mode: 'ai', boxes: c.operation === 'visible_dom', timeout: 3000 });
      if (await this.document(page) !== document || this.navigation !== navigation) fail('browser_document_changed');
      const id = c.compact === true ? `${referenceNamespace}${(++observationSequence).toString(36)}` : randomUUID(), refs = new Map();
      let nodes = sanitize(raw, id, refs, c.scope ? 0 : 1);
      bindReferences(raw, id, refs, frame);
      if (!c.scope) {
        refs.set(`${id}:root`, { locator: page.locator('body'), frame: page });
        nodes.unshift({ depth: 0, role: 'document', name: await page.title(), reference: `${id}:root` });
      }
      if (Buffer.byteLength(JSON.stringify(nodes)) > MAX_BYTES) fail('browser_observation_limit');
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scroll_x: scrollX, scroll_y: scrollY }));
      if (c.operation === 'visible_dom') nodes = nodes.filter(n => n.box && n.box.width > 0 && n.box.height > 0 && n.box.x < viewport.width && n.box.y < viewport.height && n.box.x + n.box.width > 0 && n.box.y + n.box.height > 0);
      if (c.compact === true) nodes = compactNodes(nodes);
      this.snapshot = { id, refs, nodes, viewport, target: c.target_id, document, at: Date.now(),
        full: c.full === true, compact: c.compact === true, mode: c.operation, scoped: Boolean(c.scope) };
      return { ...this.pageResult(this.snapshot, 0), viewport,
        ...(c.trace === true ? { _bud_trace: traceSnapshot(raw) } : {}) };
    }
    this.stage = 'validate_snapshot';
    const s = await this.current(page, c);
    let locator;
    if (c.reference) locator = this.ref(s, c.reference);
    else if (c.locator) {
      const root = c.scope ? this.ref(s, c.scope) : page;
      locator = root.getByRole(c.locator.role, { name: c.locator.name, exact: true });
    }
    if (!locator) fail('browser_invalid_arguments');
    this.stage = 'resolve_element';
    const count = await locator.count();
    if (count !== 1) fail(count ? 'browser_locator_ambiguous' : 'browser_locator_not_found');
    // Resolve once; never reselect another matching node if the document changes.
    const handle = await locator.elementHandle({ timeout: 1000 });
    if (!handle) fail('browser_locator_not_found');
    try {
      this.stage = 'validate_action';
      await this.current(page, c);
      // Geometry is read from this exact element in its own frame, in CSS
      // padding-box coordinates (not screenshot pixels or viewport coordinates).
      const geometry = () => handle.evaluate(element => {
        if (!element.isConnected) throw Error('browser_stale_reference');
        return { width: element.clientWidth, height: element.clientHeight };
      });
      if (c.operation === 'geometry') return await geometry();
      if (c.operation === 'click') {
        const started = performance.now();
        let position;
        if (c.position != null) {
          const p = c.position;
          if (typeof p !== 'object' || Array.isArray(p) ||
              Object.keys(p).some(key => !['x', 'y'].includes(key)) ||
              !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0)
            fail('browser_invalid_arguments');
          const { width, height } = await geometry();
          if (p.x >= width || p.y >= height) fail('browser_invalid_arguments');
          position = { x: p.x, y: p.y };
          await this.current(page, c);
        }
        const timeout = Math.ceil(3000 - (performance.now() - started));
        if (timeout <= 0) fail('browser_outcome_unknown');
        this.stage = 'click';
        // One invocation, the same handle, normal scrolling and actionability.
        // Playwright may retry internally; Bud never force-clicks or retargets.
        await handle.click({ ...(position ? { position } : {}), timeout });
      }
      else if (c.operation === 'fill') { this.stage = 'fill'; await handle.fill(c.text, { timeout: 3000 }); }
      else if (c.operation === 'focus') { this.stage = 'focus'; await handle.focus(); }
      else fail('browser_invalid_arguments');
      return { action_applied: true };
    } finally { await handle.dispose(); }
  }
}
