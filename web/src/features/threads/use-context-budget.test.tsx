import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { register } from 'node:module'
import type { ApiContextBudget } from '../../lib/api-types'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { useContextBudget } = await import('./use-context-budget')
const budget = (model: string): ApiContextBudget => ({ status: 'unknown', model, provider: null,
  reason: 'count_failed', source: 'unknown', phase: null, turn_id: null,
  checked_at: null, stale: false, updated_at: '2026-10-01T00:00:00Z' })

test('optional budget loads after mount, preserves omission and failures, and honors explicit null', async () => {
  const original = globalThis.fetch
  const requests: { url: string; signal?: AbortSignal | null; resolve: (response: Response) => void }[] = []
  globalThis.fetch = (url, init) => new Promise(resolve => requests.push({ url: String(url), signal: init?.signal, resolve }))
  let current!: ReturnType<typeof useContextBudget>
  function Harness() { current = useContextBudget('thread-A', undefined); return createElement('p', null, 'Transcript visible') }
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(createElement(Harness)) })
    assert.equal(view.root.findByType('p').children[0], 'Transcript visible')
    assert.equal(current.contextBudget, null)
    assert.match(requests[0].url, /\/thread-A\/context-budget$/)
    await act(async () => requests[0].resolve(Response.json({ context_budget: budget('initial'), active: true, stream_cursor: 'ignored' })))
    assert.deepEqual(current.contextBudget, budget('initial'))
    await act(async () => current.applyContextBudget(undefined))
    assert.deepEqual(current.contextBudget, budget('initial'))
    await act(async () => { void current.refreshContextBudget() })
    await act(async () => requests[1].resolve(Response.json({}, { status: 502 })))
    assert.deepEqual(current.contextBudget, budget('initial'))
    await act(async () => { void current.refreshContextBudget() })
    await act(async () => requests[2].resolve(Response.json({ context_budget: null })))
    assert.equal(current.contextBudget, null)
  } finally {
    await act(async () => view?.unmount())
    globalThis.fetch = original
  }
})

test('new budget evidence and owner/thread remounts fence late optional reads', async () => {
  const original = globalThis.fetch
  const requests: { signal?: AbortSignal | null; resolve: (response: Response) => void }[] = []
  globalThis.fetch = (_url, init) => new Promise(resolve => requests.push({ signal: init?.signal, resolve }))
  let current!: ReturnType<typeof useContextBudget>
  function Harness({ thread }: { thread: string }) { current = useContextBudget(thread, undefined); return null }
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(createElement(Harness, { key: 'owner-A:thread-A', thread: 'thread-A' })) })
    await act(async () => current.applyContextBudget(budget('compacted')))
    assert.equal(requests[0].signal?.aborted, true)
    await act(async () => requests[0].resolve(Response.json({ context_budget: budget('old') })))
    assert.deepEqual(current.contextBudget, budget('compacted'))
    await act(async () => { void current.refreshContextBudget() })
    await act(async () => { void current.refreshContextBudget() })
    await act(async () => requests[2].resolve(Response.json({ context_budget: budget('newest') })))
    await act(async () => requests[1].resolve(Response.json({ context_budget: budget('older') })))
    assert.deepEqual(current.contextBudget, budget('newest'))
    await act(async () => { void current.refreshContextBudget() })
    await act(async () => view.update(createElement(Harness, { key: 'owner-B:thread-A', thread: 'thread-A' })))
    assert.equal(current.contextBudget, null)
    assert.equal(requests[3].signal?.aborted, true)
    await act(async () => requests[3].resolve(Response.json({ context_budget: budget('other-owner') })))
    assert.equal(current.contextBudget, null)
    await act(async () => view.update(createElement(Harness, { key: 'owner-B:thread-B', thread: 'thread-B' })))
    assert.equal(requests[4].signal?.aborted, true)
    await act(async () => requests[4].resolve(Response.json({ context_budget: budget('other-thread') })))
    assert.equal(current.contextBudget, null)
    await act(async () => view.unmount())
    assert.equal(requests[5].signal?.aborted, true)
    await act(async () => requests[5].resolve(Response.json({ context_budget: budget('unmounted') })))
  } finally {
    await act(async () => view?.unmount())
    globalThis.fetch = original
  }
})

test('a supplied nonstale budget, including unknown, avoids the initial read', async () => {
  const original = globalThis.fetch
  let reads = 0
  globalThis.fetch = async () => { reads++; return Response.json({}) }
  let view!: ReactTestRenderer
  function Harness() { useContextBudget('thread', budget('provided')); return null }
  try {
    await act(async () => { view = create(createElement(Harness)) })
    assert.equal(reads, 0)
  } finally {
    await act(async () => view?.unmount())
    globalThis.fetch = original
  }
})
