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
const { usePendingRequests, PENDING_BACKSTOP_MS } = await import('./use-pending-requests')

test('slow visible backstop only; hints coalesce, races retry, foreground and owner changes are fenced', async t => {
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
  const respond = async (body: unknown, status = 200) => act(async () => requests.at(-1)!.resolve(Response.json(body, { status })))
  try {
    await act(async () => { view = create(createElement(Harness, { thread: 'a' })) })
    // Ten idle visible minutes: one cheap read per interval, never more.
    for (let minute = 1; minute <= 10; minute++) {
      await tick(PENDING_BACKSTOP_MS - 1); assert.equal(requests.length, minute - 1)
      await tick(1); await tick(); assert.equal(requests.length, minute)
      await respond({ pending_questions: [] })
    }
    assert.equal(applied.length, 10)
    invalidate(); invalidate(); invalidate(); await tick(); assert.equal(requests.length, 11)
    invalidate()
    await respond({ pending_questions: ['old'] })
    assert.equal(applied.length, 10)
    await tick(); assert.equal(requests.length, 12)
    await respond({ pending_questions: [] })
    assert.equal(applied.length, 11)
    // A hint-driven read restarts the backstop interval.
    await tick(PENDING_BACKSTOP_MS - 1); assert.equal(requests.length, 12)
    await tick(1); await tick(); assert.equal(requests.length, 13)
    await respond({}, 503)
    await tick(999); assert.equal(requests.length, 13)
    await tick(1); assert.equal(requests.length, 14)
    await respond({ pending_questions: [] })
    document.visibilityState = 'hidden'; invalidate(); await tick(); assert.equal(requests.length, 14)
    await tick(600_000); assert.equal(requests.length, 14)
    document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'))
    await tick(); assert.equal(requests.length, 15)
    await act(async () => view.update(createElement(Harness, { key: 'new-owner', thread: 'b' })))
    assert.equal(requests[14].signal?.aborted, true)
    await respond({ pending_questions: ['other-owner'] })
    assert.equal(applied.length, 12)
    await tick(PENDING_BACKSTOP_MS - 1); assert.equal(requests.length, 15)
    await tick(1); await tick(); assert.equal(requests.length, 16)
  } finally {
    await act(async () => view?.unmount())
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { document: originalDocument })
  }
});
