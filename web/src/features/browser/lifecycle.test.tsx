import {beforeEach, afterEach} from 'node:test'
import {StateSocket} from './state-feed.fixture'
const realSocket = globalThis.WebSocket
beforeEach(() => { StateSocket.all = []; globalThis.WebSocket = StateSocket as unknown as typeof WebSocket })
afterEach(() => { globalThis.WebSocket = realSocket })
import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement, act } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { register } from 'node:module'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { BrowserLifecycle } = await import('./lifecycle')

test('reset needs confirmation, stays pending through old polls, and ignores another Bud’s late status', async () => {
  const originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout
  const callbacks = new Map<number, () => void>()
  let serial = 0
  globalThis.setTimeout = ((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms !== 3000) return originalTimeout(fn, ms, ...args)
    callbacks.set(++serial, fn); return serial
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => { if (!callbacks.delete(id)) originalClear(id) }) as typeof clearTimeout
  const requests: { url: string; init?: RequestInit; resolve: (r: Response) => void }[] = []
  globalThis.fetch = (url, init) => new Promise(resolve => requests.push({ url: String(url), init, resolve }))
  let view!: ReactTestRenderer
  const status = (revision: number, desired_state: string) => ({ browser_id: 'managed-A', revision, desired_state })
  const click = async (label: string) => act(async () => {
    view.root.findAllByType('button').find(b => b.children.join('') === label)!.props.onClick()
  })
  try {
    await act(async () => { view = create(createElement(BrowserLifecycle, { budId: 'A' })) })
    await act(async () => requests[0].resolve(Response.json({ browser: status(1, 'open') })))
    await click('Reset browser data')
    assert.equal(requests.length, 1, 'confirmation must precede mutation')
    await act(async () => { StateSocket.change(); const poll = [...callbacks.values()]; callbacks.clear(); poll.forEach(fn => fn()) })
    await click('Confirm reset')
    assert.deepEqual(JSON.parse(String(requests[2].init?.body)), { revision: 1, operation: 'reset', confirmed: true })
    await act(async () => requests[2].resolve(Response.json(status(2, 'reset_pending'))))
    await act(async () => requests[1].resolve(Response.json({ browser: status(1, 'open') })))
    assert.match(JSON.stringify(view.toJSON()), /pending/)
    await act(async () => { StateSocket.change(); const poll = [...callbacks.values()]; callbacks.clear(); poll.forEach(fn => fn()) })
    await act(async () => view.update(createElement(BrowserLifecycle, { budId: 'B' })))
    await act(async () => requests[3].resolve(Response.json({ browser: status(3, 'stopped') })))
    assert.equal(view.toJSON(), null)
    await act(async () => requests[4].resolve(Response.json({ browser: null })))
    assert.equal(view.toJSON(), null)
  } finally {
    await act(async () => view.unmount())
    globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear
  }
})
