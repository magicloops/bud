import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';

const TTL = 60_000, MAX_BYTES = 2 * 1024 * 1024, PAGE_BYTES = 24 * 1024;
const fields = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
const fail = code => { throw new Error(code); };

// Allowlist output rather than forwarding Playwright internals or field values.
export function sanitize(nodes, prefix, refs, depth = 0, result = []) {
  if (depth > 128 || result.length > 20000) fail('browser_observation_limit');
  for (const node of nodes) {
    if (result.length >= 20000) fail('browser_observation_limit');
    if (!node || typeof node !== 'object') continue;
    const item = { depth, role: node.role ?? 'text' };
    if (typeof node.name === 'string') item.name = node.name;
    if (!fields.has(item.role) && typeof node.text === 'string') item.text = node.text;
    if (typeof node.ref === 'string') {
      item.reference = `${prefix}:${node.ref}`;
      refs.set(item.reference, node.ref);
    }
    if (node.box) item.box = node.box;
    for (const key of ['disabled', 'checked', 'expanded', 'selected', 'level']) {
      if (typeof node[key] === 'boolean' || typeof node[key] === 'number') item[key] = node[key];
    }
    result.push(item);
    if (!fields.has(item.role) && Array.isArray(node.children)) sanitize(node.children, prefix, refs, depth + 1, result);
  }
  return result;
}

export class Engine {
  static async connect(endpoint) {
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 8000 });
    return new Engine(browser);
  }
  constructor(browser) { this.browser = browser; this.snapshot = null; this.watched = new WeakSet(); this.navigation = 0; }
  async page(target) {
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
  ref(page, snapshot, reference) {
    const ref = snapshot.refs.get(reference);
    if (!ref) fail('browser_stale_reference');
    return ref === 'body' ? page.locator('body') : page.locator(`aria-ref=${ref}`);
  }
  pageResult(s, offset) {
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
      viewport: s.viewport, nodes, text: nodes.map(n => `${'  '.repeat(Math.min(n.depth, 24))}${n.role}${n.name ? ` ${JSON.stringify(n.name)}` : ''}${n.text ? `: ${JSON.stringify(n.text)}` : ''}${n.reference ? ` [ref=${n.reference}]` : ''}`).join('\n'),
      truncated: cursor !== null, continuation: cursor, expires_in_ms: Math.max(0, TTL - (Date.now() - s.at)),
      coverage: 'accessible_dom', limitations: ['Closed shadow roots and inaccessible embedded documents may be omitted.'] };
  }
  async execute(c) {
    if (c.operation === 'invalidate') { this.snapshot = null; return {}; }
    const page = await this.page(c.target_id);
    if (c.operation === 'page_info') return { target_id: c.target_id, document_id: await this.document(page), title: await page.title(), url: page.url() };
    if (c.operation === 'snapshot' || c.operation === 'visible_dom') {
      if (c.continuation) {
        const s = await this.current(page, c);
        const [id, raw] = c.continuation.split(':');
        const offset = Number(raw);
        if (id !== s.id || !Number.isSafeInteger(offset) || offset < 0 || offset >= s.nodes.length) fail('browser_stale_reference');
        return this.pageResult(s, offset);
      }
      let root = page.locator('body');
      if (c.scope) root = this.ref(page, await this.current(page, c), c.scope);
      const document = await this.document(page), navigation = this.navigation;
      const raw = await root.ariaSnapshotJSON({ mode: 'ai', boxes: c.operation === 'visible_dom', timeout: 3000 });
      if (await this.document(page) !== document || this.navigation !== navigation) fail('browser_document_changed');
      const id = randomUUID(), refs = new Map();
      let nodes = sanitize(raw, id, refs);
      if (!c.scope) {
        refs.set(`${id}:root`, 'body');
        nodes.unshift({ depth: 0, role: 'document', name: await page.title(), reference: `${id}:root` });
      }
      if (Buffer.byteLength(JSON.stringify(nodes)) > MAX_BYTES) fail('browser_observation_limit');
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scroll_x: scrollX, scroll_y: scrollY }));
      if (c.operation === 'visible_dom') nodes = nodes.filter(n => n.box && n.box.width > 0 && n.box.height > 0 && n.box.x < viewport.width && n.box.y < viewport.height && n.box.x + n.box.width > 0 && n.box.y + n.box.height > 0);
      this.snapshot = { id, refs, nodes, viewport, target: c.target_id, document, at: Date.now() };
      return { ...this.pageResult(this.snapshot, 0), viewport };
    }
    const s = await this.current(page, c);
    let locator;
    if (c.reference) locator = this.ref(page, s, c.reference);
    else if (c.locator) {
      const root = c.scope ? this.ref(page, s, c.scope) : page;
      locator = root.getByRole(c.locator.role, { name: c.locator.name, exact: true });
    }
    if (c.operation === 'scroll') {
      await page.mouse.wheel(0, c.delta_y);
      return { scroll_requested: true };
    }
    if (!locator) fail('browser_invalid_arguments');
    const count = await locator.count();
    if (count !== 1) fail(count ? 'browser_locator_ambiguous' : 'browser_locator_not_found');
    // Resolve once; never reselect another matching node if the document changes.
    const handle = await locator.elementHandle({ timeout: 1000 });
    if (!handle) fail('browser_locator_not_found');
    try {
      await this.current(page, c);
      if (c.operation === 'click') await handle.click({ timeout: 3000 });
      else if (c.operation === 'fill') await handle.fill(c.text, { timeout: 3000 });
      else if (c.operation === 'focus') await handle.focus();
      else fail('browser_invalid_arguments');
      return { action_applied: true };
    } finally { await handle.dispose(); }
  }
}
