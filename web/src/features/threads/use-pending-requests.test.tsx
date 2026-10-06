import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { register } from 'node:module'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { usePendingRequests } = await import('./use-pending-requests')

test('healthy idle does not poll; hints coalesce, races retry, foreground and owner changes are fenced', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const originalFetch = globalThis.fetch, originalDocument = globalThis.document
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  Object.assign(globalThis, { document })
  const requests: { signal?: AbortSignal | null; resolve: (value: Response) => void }[] = []
  globalThis.fetch = (_url, init) => new Promise(resolve => requests.push({ signal: init?.signal, resolve }))
  let invalidate!: () => void
  const applied: unknown[] = []
  function Harness({ thread }: { thread: string }) {
    invalidate = usePendingRequests(thread, state => applied.push(state))
    return null
  }
  let view!: ReactTestRenderer
  const tick = async (ms = 0) => act(async () => { t.mock.timers.tick(ms) })
  try {
    await act(async () => { view = create(createElement(Harness, { thread: 'a' })) })
    await tick(600_000); assert.equal(requests.length, 0)
    invalidate(); invalidate(); invalidate(); await tick(); assert.equal(requests.length, 1)
    invalidate()
    await act(async () => requests[0].resolve(Response.json({ pending_questions: ['old'] })))
    assert.equal(applied.length, 0)
    await tick(); assert.equal(requests.length, 2)
    await act(async () => requests[1].resolve(Response.json({ pending_questions: [] })))
    assert.deepEqual(applied, [{ pending_questions: [] }])
    await tick(600_000); assert.equal(requests.length, 2)
    invalidate(); await tick()
    await act(async () => requests[2].resolve(Response.json({}, { status: 503 })))
    await tick(999); assert.equal(requests.length, 3)
    await tick(1); assert.equal(requests.length, 4)
    await act(async () => requests[3].resolve(Response.json({ pending_questions: [] })))
    document.visibilityState = 'hidden'; invalidate(); await tick(); assert.equal(requests.length, 4)
    document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'))
    await tick(); assert.equal(requests.length, 5)
    await act(async () => view.update(createElement(Harness, { key: 'new-owner', thread: 'b' })))
    assert.equal(requests[4].signal?.aborted, true)
    await act(async () => requests[4].resolve(Response.json({ pending_questions: ['other-owner'] })))
    assert.equal(applied.length, 2)
    await tick(600_000); assert.equal(requests.length, 5)
  } finally {
    await act(async () => view?.unmount())
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { document: originalDocument })
  }
});
