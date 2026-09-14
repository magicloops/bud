import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement, act } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { register } from 'node:module'
import type { ApiAgentState, ApiMessage, ApiMessagePage } from '@/lib/api-types'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { ChatTimeline } = await import('./chat-timeline')
const { AuthSessionContext } = await import('@/contexts/auth-session-context')
const { useThreadMessages } = await import('@/features/threads/use-thread-messages')
const msg = (id: string, role: ApiMessage['role'], content: string, metadata = {}): ApiMessage => ({
  client_id: id, message_id: id, role, display_role: role, content, created_at: '2026-09-13T10:00:00Z', metadata: { turn_id: 'T', ...metadata },
})
const state: ApiAgentState = { active: false, turn_id: null, phase: 'idle', pending_tool: null, draft_assistant: null, can_cancel: false, stream_cursor: null, updated_at: '' }
const page: ApiMessagePage['page'] = { limit: 100, returned: 0, has_more_before: true, has_more_after: false, before_cursor: 'older', after_cursor: null }
const noError = () => {}
const authorized = () => false

function timeline(messages: ApiMessage[]) {
  return createElement(AuthSessionContext.Provider, {
    value: { currentUser: null, isAuthenticated: true, setCurrentUser: noError },
  }, createElement(ChatTimeline, { messages, liveTurnId: 'T' }))
}

test('mounted commentary and final identity survive classification; live inspection does not preopen Worked', async () => {
  const tool = msg('tool', 'tool', 'large result', { tool: 'test_tool' })
  const draft = msg('comment', 'assistant', 'Commentary', { draft: true })
  let view!: ReactTestRenderer
  await act(async () => { view = create(timeline([tool, draft])) })
  const commentary = view.root.findAllByType('article')[0]
  const section = view.root.findByProps({ 'data-activity-section': 'activity:tool' })
  await act(async () => { section.findByType('button').props.onClick() })
  assert.equal(view.root.findByProps({ 'data-activity-section': 'activity:tool' }).findAllByType('button')[0].props['aria-expanded'], true)
  const classified = { ...draft, metadata: { turn_id: 'T', segment_kind: 'intermediate' } }
  const answer = msg('answer', 'assistant', 'Final', { draft: true })
  await act(async () => { view.update(timeline([tool, classified, answer])) })
  assert.equal(view.root.findAllByType('article')[0], commentary)
  const answerNode = view.root.findAllByType('article')[1]
  await act(async () => { view.update(timeline([tool, classified, { ...answer, metadata: { turn_id: 'T', segment_kind: 'final' } }])) })
  assert.equal(view.root.findAllByType('article')[0], answerNode)
  const work = view.root.findByProps({ 'data-work-group': 'agent-work:T' })
  assert.equal(work.findByType('button').props['aria-expanded'], false)
  await act(async () => { work.findByType('button').props.onClick() })
  const reopened = view.root.findByProps({ 'data-activity-section': 'activity:tool' })
  assert.equal(reopened.findAllByType('button')[0].props['aria-expanded'], true)
  assert.equal(view.root.findAll(node => node.props['data-work-detail'] !== undefined).length, 0)
  await act(async () => view.unmount())
})

test('mounted history retains consecutive same-tick updates, explicit final and stale-page protection', async () => {
  let store!: ReturnType<typeof useThreadMessages>
  const initial: ApiMessagePage = { messages: [], page }
  function Harness() {
    store = useThreadMessages({ initialMessagePage: initial, initialAgentState: state, threadId: 'A', onError: noError, shouldAbortForUnauthorized: authorized })
    return null
  }
  let view!: ReactTestRenderer
  await act(async () => { view = create(createElement(Harness)) })
  await act(async () => {
    store.applyAssistantMessageStart({ turnId: 'T', clientId: 'a' })
    store.applyAssistantMessageDelta({ turnId: 'T', clientId: 'a', delta: 'Hello ' })
    store.applyAssistantMessageDelta({ turnId: 'T', clientId: 'a', delta: 'world' })
    store.applyAssistantMessageDone({ turnId: 'T', clientId: 'a', text: 'Hello world!', segmentKind: 'final' })
    store.mergeLatestBootstrap({ messages: [], page }, state)
  })
  assert.equal(store.messages.length, 1)
  assert.equal(store.messages[0].content, 'Hello world!')
  assert.equal(store.messages[0].metadata?.segment_kind, 'final')
  assert.equal(store.messages[0].metadata?.draft, false)
  await act(async () => {
    store.removeMessage('a')
    store.mergeLatestBootstrap({ messages: [msg('a', 'assistant', 'old')], page }, state)
  })
  assert.equal(store.messages.length, 0)
  await act(async () => store.applyAssistantMessageStart({ turnId: 'retry', clientId: 'a' }))
  assert.equal(store.messages.length, 1)
  await act(async () => view.unmount())
})

test('older fetch from A cannot publish into B or a new A visit', async () => {
  const originalFetch = globalThis.fetch
  let resolve!: (response: Response) => void
  globalThis.fetch = () => new Promise<Response>(done => { resolve = done })
  let store!: ReturnType<typeof useThreadMessages>
  const initial: ApiMessagePage = { messages: [], page }
  function Harness({ threadId }: { threadId: string }) {
    store = useThreadMessages({ initialMessagePage: initial, initialAgentState: state, threadId, onError: noError, shouldAbortForUnauthorized: authorized })
    return null
  }
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(createElement(Harness, { threadId: 'A' })) })
    let pending!: Promise<void>
    await act(async () => { pending = store.loadOlderMessages() })
    await act(async () => view.update(createElement(Harness, { threadId: 'B' })))
    await act(async () => view.update(createElement(Harness, { threadId: 'A' })))
    await act(async () => {
      resolve(Response.json({ messages: [msg('stale', 'user', 'Old visit')], page }))
      await pending
    })
    assert.equal(store.messages.length, 0)
    assert.equal(store.isLoadingOlderMessages, false)
  } finally {
    await act(async () => view.unmount())
    globalThis.fetch = originalFetch
  }
})

const { useTranscriptViewport } = await import('./use-transcript-viewport')
test('viewport ignores passive near-bottom changes after inspection and raw scroll does not rerender', async () => {
  const originalWindow = globalThis.window
  const originalObserver = globalThis.ResizeObserver
  const originalKeyboard = globalThis.KeyboardEvent
  const originalRaf = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  let resize = () => {}
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  class Node extends EventTarget {
    clientHeight = 400
    clientWidth = 600
    scrollHeight = 2000
    private top = 0
    writes = 0
    get scrollTop() { return this.top }
    set scrollTop(value: number) { this.writes++; this.top = Math.min(value, this.scrollHeight - this.clientHeight) }
    firstElementChild = { style: { minHeight: '' }, children: [] }
    closest() { return null }
    getBoundingClientRect() { return { top: 0 } }
  }
  const node = new Node()
  const ref = { current: node as unknown as HTMLDivElement }
  Object.assign(globalThis, {
    window: { getSelection: () => ({ isCollapsed: true }) },
    KeyboardEvent: class extends Event { key = '' },
    ResizeObserver: class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId },
    cancelAnimationFrame: (id: number) => { frames.delete(id) },
  })
  let viewport!: ReturnType<typeof useTranscriptViewport>
  let renders = 0
  function Harness({ send = null }: { send?: string | null }) {
    renders++
    viewport = useTranscriptViewport(ref, send)
    return null
  }
  const flushFrames = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) }
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(createElement(Harness)) })
    flushFrames()
    assert.equal(node.scrollTop, 1600)
    viewport.inspect()
    node.scrollHeight = 2200
    await act(async () => resize())
    const writes = node.writes
    flushFrames()
    assert.equal(node.writes, writes)
    assert.equal(viewport.showJump, true)
    // Browser clamping/resize is not a deliberate return-to-bottom.
    node.scrollTop = 1800
    await act(async () => { node.dispatchEvent(new Event('scroll')); resize() })
    assert.equal(frames.size, 0)
    node.dispatchEvent(new Event('wheel'))
    node.scrollTop = 400
    await act(async () => node.dispatchEvent(new Event('scroll')))
    const before = renders
    for (let index = 0; index < 100; index++) {
      node.scrollTop = 400 + index
      await act(async () => node.dispatchEvent(new Event('scroll')))
    }
    assert.equal(renders, before)
    await act(async () => view.update(createElement(Harness, { send: 'new-send' })))
    flushFrames()
    assert.equal(node.scrollTop, 1800)
    // Queued follow is canceled before disclosure changes height.
    await act(async () => resize())
    viewport.inspect()
    assert.equal(frames.size, 0)
  } finally {
    await act(async () => view.unmount())
    Object.assign(globalThis, { window: originalWindow, ResizeObserver: originalObserver, KeyboardEvent: originalKeyboard,
      requestAnimationFrame: originalRaf, cancelAnimationFrame: originalCancel })
  }
})
