import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement, act } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { register } from 'node:module'
import type { BrowserFrame } from './media'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  if (url.endsWith('/features/browser/media.ts')) return { format: 'module', source: 'export class BrowserCanvas { constructor(...args) { return new globalThis.__testBrowserCanvas(...args) } }', shortCircuit: true };
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

test('private fit fences input; input failure survives a late renewal and releases without return', async () => {
  const originalAnimationFrame = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame
  const originalFetch = globalThis.fetch
  const originalObserver = globalThis.ResizeObserver
  const originalInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  let heartbeat: (() => void) | undefined
  globalThis.setInterval = ((callback: () => void) => { heartbeat = callback; return 12345 }) as typeof setInterval
  globalThis.clearInterval = (() => { heartbeat = undefined }) as typeof clearInterval
  const clients: FakeCanvas[] = []
  class FakeCanvas {
    frame: BrowserFrame | null = null
    closed = false
    status: (state: string, targets?: BrowserFrame['targets']) => void
    constructor(_canvas: unknown, _url: string, _viewer: string, status: FakeCanvas['status']) { this.status = status; clients.push(this) }
    show(viewport?: string) {
      this.frame = { target_id: 'page', document_id: 'doc', frame_token: 'frame', viewport_id: viewport, width: 640, height: 480, targets: [{ target_id: 'page', origin: 'https://example.test' }] }
      this.status('connected', this.frame.targets)
    }
    close() { this.closed = true; this.frame = null; this.status('unavailable') }
  }
  Object.assign(globalThis, { __testBrowserCanvas: FakeCanvas })
  globalThis.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver
  const metadata = { session_id: 'browser', thread_id: 'thread', bud_id: 'bud', generation: 'gen', state: 'ready', control_state: 'agent', revision: 1, can_view: true, can_resize_viewport: true, handoff: { reason: 'Sign in and return control.' } }
  const operations: string[] = []
  const sizes: unknown[] = []
  let resizeReply!: (reply: Response) => void
  let renewReply!: (reply: Response) => void
  let rejectInput = false
  const inputs: Record<string, unknown>[] = []
  let keyboardFocus = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/input')) {
      inputs.push(JSON.parse(String(init?.body)).input)
      return rejectInput ? Response.json({ error: 'browser_input_uncertain' }, { status: 409 }) : Response.json({ focus_token: 'focus' })
    }
    if (String(url).endsWith('/viewport')) {
      sizes.push(JSON.parse(String(init?.body)))
      return new Promise(resolve => { resizeReply = resolve })
    }
    if (String(url).endsWith('/control')) {
      const operation = JSON.parse(String(init?.body)).operation
      operations.push(operation)
      if (operation === 'renew') return new Promise(resolve => { renewReply = resolve })
      return Response.json({ ...metadata, handoff: undefined, control_state: operation === 'acquire' ? 'human_private' : 'paused', revision: 2, can_view: false })
    }
    return Response.json(metadata)
  }
  const { BrowserViewer } = await import('./viewer')
  let view!: ReactTestRenderer
  const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }) })
  try {
    await act(async () => { view = create(createElement(BrowserViewer, { sessionId: 'browser', embedded: true }), { createNodeMock: element => {
      if (element.type === 'canvas') return canvas
      if (element.type === 'textarea') return { value: '', focus(options: unknown) { assert.deepEqual(options, { preventScroll: true }); keyboardFocus++ } }
      if (element.type === 'div') return { getBoundingClientRect: () => ({ width: 640, height: 480 }) }
      return null
    } }) })
    await act(async () => clients.at(-1)!.show())
    assert.equal(sizes.length, 0) // Passive viewing never changes remote geometry.
    const take = view.root.findAllByType('button').find(button => button.children.includes('Take control'))!
    await act(async () => take.props.onClick())
    assert.equal(view.root.findAllByType('p').some(p => p.children.includes('Sign in and return control.')), true)
    await act(async () => clients.at(-1)!.show())
    await act(async () => new Promise(resolve => setTimeout(resolve, 180)))
    assert.equal(sizes.length, 1)
    const connections = clients.length
    const controls = view.root.findByProps({ 'aria-label': 'Browser controls' })
    await act(async () => controls.props.onClick())
    assert.equal(view.root.findByProps({ 'aria-label': 'Browser controls panel' }).props.hidden, false)
    await act(async () => controls.props.onClick())
    assert.equal(view.root.findByProps({ 'aria-label': 'Browser controls panel' }).props.hidden, true)
    assert.equal(sizes.length, 1)
    assert.equal(clients.length, connections)
    assert.equal(view.root.findByType('textarea').props.disabled, true)
    await act(async () => resizeReply(Response.json({ viewport_applied: true, viewport_id: 'new-size' })))
    await act(async () => clients.at(-1)!.show('old-size'))
    assert.equal(view.root.findByType('textarea').props.disabled, true)
    await act(async () => clients.at(-1)!.show('new-size'))
    assert.equal(view.root.findByType('textarea').props.disabled, false)
    assert.equal(clients.length, connections) // Fit does not remount media.
    await act(async () => view.root.findByType('canvas').props.onClick({ clientX: 10, clientY: 10 }))
    assert.equal(keyboardFocus, 1)
    assert.equal(view.root.findByProps({ 'aria-label': 'Browser controls panel' }).props.hidden, true)
    const textEvent = { nativeEvent: { isComposing: false }, target: { value: 'Hello' } }
    await act(async () => view.root.findByType('textarea').props.onChange(textEvent))
    assert.deepEqual(inputs.at(-1), { kind: 'text', text: 'Hello', focus_token: 'focus' })
    assert.equal(textEvent.target.value, '')
    assert.equal(view.root.findByProps({ 'aria-label': 'Browser controls panel' }).props.hidden, true)
    rejectInput = true
    await act(async () => heartbeat!())
    await act(async () => view.root.findByType('canvas').props.onClick({ clientX: 10, clientY: 10 }))
    const failure = view.root.findByProps({ role: 'alert' }).children.join('')
    assert.match(failure, /input was not confirmed/)
    assert.equal(heartbeat, undefined)
    await act(async () => renewReply(Response.json({ ...metadata, control_state: 'human_private', revision: 2, can_view: false })))
    assert.equal(view.root.findByProps({ role: 'alert' }).children.join(''), failure)
    assert.equal(view.root.findByType('textarea').props.disabled, true)
    await act(async () => view.unmount())
    assert.deepEqual(operations, ['acquire', 'renew', 'release'])
    assert.equal(clients.every(client => client.closed), true)
  } finally {
    if (view) await act(async () => view.unmount())
    globalThis.requestAnimationFrame = originalAnimationFrame
    globalThis.fetch = originalFetch
    globalThis.ResizeObserver = originalObserver
    globalThis.setInterval = originalInterval
    globalThis.clearInterval = originalClearInterval
    Reflect.deleteProperty(globalThis, '__testBrowserCanvas')
  }
})

test('passive media follows handoff epochs without acquiring private control or reconnecting on unchanged polls', async () => {
  const originalAnimationFrame = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame
  const originalFetch = globalThis.fetch
  const originalTimeout = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const polls = new Map<number, () => void>()
  let timer = 0
  globalThis.setTimeout = ((callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay !== 3000) return originalTimeout(callback, delay, ...args)
    polls.set(++timer, callback)
    return timer
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle: number) => {
    if (!polls.delete(handle)) originalClear(handle)
  }) as typeof clearTimeout
  const clients: FakeCanvas[] = []
  class FakeCanvas {
    frame: BrowserFrame | null = null
    closed = false
    constructor(_canvas: unknown, _url: string, _viewer: string, private status: (state: string) => void) { clients.push(this) }
    show() { this.status('connected') }
    close() { this.closed = true; this.status('unavailable') }
  }
  Object.assign(globalThis, { __testBrowserCanvas: FakeCanvas })
  let metadata = { session_id: 'browser', thread_id: 'thread', bud_id: 'bud', generation: 'gen', state: 'ready', control_state: 'agent', control_epoch: 2, revision: 1, can_view: true, runtime_status: 'available' }
  let absent = false
  const requests: string[] = []
  globalThis.fetch = async (url, init) => {
    requests.push(init?.method ?? 'GET')
    assert.equal(String(url).endsWith('/browser'), true)
    return absent ? Response.json({ error: 'browser_not_found' }, { status: 404 }) : Response.json(metadata)
  }
  const { BrowserViewer } = await import('./viewer')
  let view!: ReactTestRenderer
  const poll = async () => { await act(async () => { const callbacks = [...polls.values()]; polls.clear(); callbacks.forEach(callback => callback()) }) }
  try {
    await act(async () => { view = create(createElement(BrowserViewer, { sessionId: 'browser' }), { createNodeMock: () => ({ value: '' }) }) })
    assert.equal(clients.length, 1)
    await act(async () => clients[0].show())
    // Service fences old media as the agent parks its handoff.
    await act(async () => clients[0].close())
    metadata = { ...metadata, control_state: 'paused', control_epoch: 3, revision: 2 }
    await poll()
    assert.equal(clients.length, 2)
    await act(async () => clients[1].show())
    await poll()
    assert.equal(clients.length, 2)
    // A later agent invocation advances epoch without changing UI revision.
    metadata = { ...metadata, control_state: 'agent', control_epoch: 4 }
    await poll()
    assert.equal(clients[1].closed, true)
    assert.equal(clients.length, 3)
    // Another viewer takes private control: do not reconnect or acquire it.
    metadata = { ...metadata, control_state: 'human_private', control_epoch: 5, revision: 3, can_view: false }
    await poll()
    assert.equal(clients[2].closed, true)
    await poll()
    assert.equal(clients.length, 3)
    metadata = { ...metadata, runtime_status: 'daemon_restarted' }
    await poll()
    assert.equal(view.root.findByType('h1').children.join(''), 'Browser session ended')
    assert.equal(view.root.findAllByType('select').length, 0)
    assert.equal(view.root.findAllByType('button').some(b => b.children.includes('Reconnect view') || b.children.includes('Take control')), false)
    assert.equal(view.root.findAllByType('p').some(p => p.children.join('').includes('Bud restarted')), true)
    assert.equal(clients.length, 3)
    absent = true
    await poll()
    assert.equal(view.root.findAllByType('p').some(p => p.children.join('').includes('Bud restarted')), false)
    assert.equal(view.root.findAllByType('button').some(b => b.children.includes('Close browser and stop run')), false)
    assert.equal(requests.every(method => method === 'GET'), true)
  } finally {
    if (view) await act(async () => view.unmount())
    globalThis.requestAnimationFrame = originalAnimationFrame
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalTimeout
    globalThis.clearTimeout = originalClear
    Reflect.deleteProperty(globalThis, '__testBrowserCanvas')
  }
})


test('passive pane fits without acquisition; failed fitting preserves media and agent ownership', async () => {
  const originalFetch = globalThis.fetch;
  const originalObserver = globalThis.ResizeObserver;
  const originalAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;
  let measure!: () => void;
  globalThis.ResizeObserver = class { constructor(callback: () => void) { measure = callback } observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
  const clients: FakeCanvas[] = [];
  class FakeCanvas {
    frame: BrowserFrame | null = null;
    closed = false;
    constructor(_canvas: unknown, _url: string, _viewer: string, private status: (state: string, targets?: BrowserFrame['targets']) => void) { clients.push(this) }
    show() {
      this.frame = { target_id: 'page', document_id: 'doc', frame_token: 'frame', width: 640, height: 480, targets: [{ target_id: 'page', origin: 'https://example.test' }] };
      this.status('connected', this.frame.targets);
    }
    close() { this.closed = true; this.status('unavailable') }
  }
  Object.assign(globalThis, { __testBrowserCanvas: FakeCanvas });
  const writes: string[] = [];
  let fail = false;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      writes.push(String(url));
      return fail ? Response.json({ error: 'browser_viewport_unconfirmed' }, { status: 409 }) : Response.json({ viewport_applied: true, viewport_id: 'size' });
    }
    return Response.json({ session_id: 'browser', thread_id: 'thread', bud_id: 'bud', generation: 'gen', state: 'ready', control_state: 'agent', control_epoch: 1, revision: 1, can_view: true, can_resize_viewport: true, can_resize_agent_viewport: true });
  };
  const { BrowserViewer } = await import('./viewer');
  let view!: ReactTestRenderer;
  let width = 640;
  try {
    await act(async () => { view = create(createElement(BrowserViewer, { sessionId: 'browser' }), { createNodeMock: () => ({ value: '', getBoundingClientRect: () => ({ width, height: 480 }) }) }) });
    await act(async () => clients[0].show());
    await act(async () => new Promise(resolve => setTimeout(resolve, 180)));
    assert.equal(writes.length, 1);
    assert.equal(clients[0].closed, false);
    assert.equal(view.root.findByType('textarea').props.disabled, true);
    fail = true; width = 700;
    await act(async () => measure());
    await act(async () => new Promise(resolve => setTimeout(resolve, 180)));
    assert.equal(writes.length, 2);
    assert.equal(writes.every(url => url.endsWith('/viewport')), true);
    assert.equal(clients[0].closed, false);
    assert.match(view.root.findByProps({ role: 'alert' }).children.join(''), /agent can continue/);
    await act(async () => view.unmount());
    assert.equal(writes.length, 2); // No private acquire/release, including on dismissal.
  } finally {
    if (view) await act(async () => view.unmount());
    globalThis.fetch = originalFetch;
    globalThis.ResizeObserver = originalObserver;
    globalThis.requestAnimationFrame = originalAnimationFrame;
    Reflect.deleteProperty(globalThis, '__testBrowserCanvas');
  }
});
