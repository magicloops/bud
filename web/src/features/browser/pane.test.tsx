import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement, act } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { register } from 'node:module'
import type { ApiAgentState, ApiMessage } from '@/lib/api-types'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { useBrowserPane } = await import('./pane')
const id = 'browser_01AAAAAAAAAAAAAAAAAAAAAAAA'
const state = { pending_tool: null } as ApiAgentState
const messages: ApiMessage[] = []

test('mounted pane baselines history, reveals new handoff once, and drops old-thread fetches', async () => {
  const originalFetch = globalThis.fetch
  const originalTimeout = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const callbacks = new Map<number, () => void>()
  let number = 0
  globalThis.setTimeout = ((callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay !== 5000) return originalTimeout(callback, delay, ...args)
    callbacks.set(++number, callback)
    return number
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle: number) => {
    if (!callbacks.delete(handle)) originalClear(handle)
  }) as typeof clearTimeout
  const requests: { signal?: AbortSignal | null; resolve: (value: Response) => void }[] = []
  globalThis.fetch = (_url, init) => new Promise(resolve => requests.push({ signal: init?.signal, resolve }))
  let pane!: ReturnType<typeof useBrowserPane>
  const opened: string[] = []
  const reveal = () => opened.push('reveal')
  function Harness({ thread }: { thread: string }) {
    pane = useBrowserPane(thread, messages, state, reveal)
    return null
  }
  let view!: ReactTestRenderer
  const inventory = (handoff: string | null, control_state = 'agent', runtime_status = 'available') => Response.json({ sessions: [{ session_id: id, state: 'ready', control_state, runtime_status, handoff: handoff ? { id: handoff } : null }] })
  const poll = async () => { await act(async () => { const queued = [...callbacks.values()]; callbacks.clear(); queued.forEach(callback => callback()) }) }
  try {
    await act(async () => { view = create(createElement(Harness, { key: 'A', thread: 'A' })) })
    await act(async () => requests[0].resolve(inventory('old')))
    assert.equal(pane.sessionId, id)
    assert.equal(opened.length, 0)
    await act(async () => pane.notice({ tool: 'browser_open', ok: true, session_id: id }))
    assert.equal(opened.length, 0)
    await poll()
    await act(async () => requests[1].resolve(inventory('new', 'human_private')))
    assert.equal(opened.length, 1)
    assert.equal(pane.pausedSessionId, id)
    // A dismissal is an external workbench choice; repeated evidence must not override it.
    await act(async () => pane.notice({ viewer_path: `/browser/${id}`, handoff_id: 'new' }))
    await poll()
    await act(async () => requests[2].resolve(inventory('new', 'human_private', 'daemon_restarted')))
    assert.equal(pane.pausedSessionId, null)
    assert.equal(opened.length, 1)
    await act(async () => pane.open(id))
    assert.equal(opened.length, 2) // Explicit links always work.
    await poll()
    await act(async () => view.update(createElement(Harness, { key: 'B', thread: 'B' })))
    assert.equal(requests[3].signal?.aborted, true)
    await act(async () => requests[3].resolve(inventory('late')))
    assert.equal(pane.sessionId, null)
    assert.equal(pane.pausedSessionId, null)
    assert.equal(opened.length, 2)
  } finally {
    await act(async () => view.unmount())
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalTimeout
    globalThis.clearTimeout = originalClear
  }
})
