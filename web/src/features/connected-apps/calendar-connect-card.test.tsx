import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { register } from 'node:module'
import type { ApiCurrentUser, ApiMessage } from '@/lib/api-types'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { CalendarConnectCard } = await import('./calendar-connect-card')
const { ChatTimeline } = await import('@/components/workbench/chat-timeline')
const { AuthSessionContext } = await import('@/contexts/auth-session-context')
const { projectTimeline } = await import('@/features/threads/agent-work-projection')
const { calendarConnectRequest } = await import('./calendar-connect-request')

const payload = { kind: 'google', tool: 'google_search_tools', connect_request: { provider: 'google_calendar', thread_id: 'thread' } }
const messages: ApiMessage[] = [
  { message_id: 'connect', client_id: 'connect', role: 'tool', display_role: 'Tool', content: 'Connect Calendar',
    created_at: '2026-11-12T10:00:00Z', metadata: { turn_id: 'turn' }, tool_payload: payload },
  { message_id: 'final', client_id: 'final', role: 'assistant', display_role: 'Bud', content: 'Connect above to continue.',
    created_at: '2026-11-12T10:00:01Z', metadata: { turn_id: 'turn', segment_kind: 'final' } },
]
const disconnected = { configured: true, connections: [] }
const connected = { configured: true, connections: [{ status: 'connected', calendar_access: true, email: 'calendar@example.com' }] }
function authorized(child: React.ReactNode, owner = 'alice') {
  return createElement(AuthSessionContext.Provider, { value: {
    currentUser: { user: { id: owner, name: owner }, profile: { username: owner } } as ApiCurrentUser,
    isAuthenticated: true, setCurrentUser() {},
  } }, child)
}
function fixture(search = '') {
  const original = { window: globalThis.window, fetch: globalThis.fetch }
  const navigation: string[] = []
  const browser = Object.assign(new EventTarget(), { location: { search, assign: (url: string) => navigation.push(url) } })
  const requests: { path: string; init?: RequestInit; resolve: (response: Response) => void }[] = []
  Object.assign(globalThis, { window: browser, fetch: (path: string, init?: RequestInit) =>
    new Promise<Response>(resolve => requests.push({ path, init, resolve })) })
  return { browser, requests, navigation, restore: () => Object.assign(globalThis, original),
    async reply(index: number, data: unknown, status = 200) {
      await act(async () => { requests[index].resolve(Response.json(data, { status })) })
    } }
}

test('connection evidence stays outside Worked after final and reload; unrelated content cannot create cards', () => {
  for (const rows of [messages, JSON.parse(JSON.stringify(messages))]) {
    assert.deepEqual(projectTimeline({ messages: rows, liveTurnId: null }).map(item => item.kind), ['message', 'message'])
  }
  for (const invalid of [null, { connect_request: payload.connect_request }, { ...payload, tool: 'terminal_run' },
    { ...payload, connect_request: { provider: 'gmail', thread_id: 'thread' } }, { ...payload, connect_request: { provider: 'google_calendar' } }]) {
    assert.equal(calendarConnectRequest(invalid), null)
  }
})

test('mounted timeline exposes Connect without disclosure; click starts OAuth bound to this chat', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(ChatTimeline, { messages }))) })
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0].path, '/api/google/connection')
    await f.reply(0, disconnected)
    const card = view.root.findByProps({ 'aria-label': 'Google Calendar connection' })
    assert.equal(card.findByType('button').children.join(''), 'Connect Google Calendar')
    await act(async () => { card.findByType('button').props.onClick(); card.findByType('button').props.onClick() })
    assert.equal(f.requests.length, 2)
    assert.equal(f.requests[1].path, '/api/google/connect')
    assert.equal(f.requests[1].init?.method, 'POST')
    assert.equal(f.requests[1].init?.credentials, 'include')
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { thread_id: 'thread' })
    await f.reply(1, { authorization_url: 'https://accounts.google.com/fixture-consent' })
    assert.deepEqual(f.navigation, ['https://accounts.google.com/fixture-consent'])
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('consent cancellation, request failure, and focus recovery remain actionable without automatic mutation', async () => {
  const f = fixture('?google=failed')
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(CalendarConnectCard, { threadId: 'thread' }))) })
    await f.reply(0, disconnected)
    assert.match(JSON.stringify(view.toJSON()), /Connection wasn’t completed/)
    await act(async () => view.root.findByType('button').props.onClick())
    await f.reply(1, { error: 'unavailable' }, 409)
    assert.equal(view.root.findByType('button').props.disabled, false)
    assert.match(JSON.stringify(view.toJSON()), /Could not start/)
    await act(async () => { f.browser.dispatchEvent(new Event('focus')) })
    await f.reply(2, connected)
    assert.match(JSON.stringify(view.toJSON()), /calendar@example.com/)
    assert.match(JSON.stringify(view.toJSON()), /Send a message to continue/)
    assert.equal(view.root.findAllByType('button').length, 0)
    assert.equal(f.requests.length, 3)
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('a success query alone is not connection proof; failed inventory can be retried', async () => {
  const f = fixture('?google=connected')
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(CalendarConnectCard, { threadId: 'thread' }))) })
    await f.reply(0, { error: 'unavailable' }, 503)
    await act(async () => view.root.findByType('button').props.onClick())
    await f.reply(1, disconnected)
    assert.equal(view.root.findByType('button').children.join(''), 'Connect Google Calendar')
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /Send a message to continue/)
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('owner or thread changes and unmount fence late inventory and OAuth navigation', async () => {
  for (const change of ['owner', 'thread', 'unmount']) {
    const f = fixture()
    let view!: ReactTestRenderer
    try {
      const card = (owner = 'alice', threadId = 'thread') => authorized(createElement(CalendarConnectCard, { threadId }), owner)
      await act(async () => { view = create(card()) })
      await f.reply(0, disconnected)
      await act(async () => view.root.findByType('button').props.onClick())
      await act(async () => { f.browser.dispatchEvent(new Event('focus')) })
      await act(async () => change === 'unmount' ? view.unmount() : view.update(card(change === 'owner' ? 'bob' : 'alice', change === 'thread' ? 'another' : 'thread')))
      assert.equal(f.requests[1].init?.signal?.aborted, true)
      assert.equal(f.requests[2].init?.signal?.aborted, true)
      await f.reply(1, { authorization_url: 'https://accounts.google.com/obsolete' })
      await f.reply(2, connected)
      assert.deepEqual(f.navigation, [])
      if (change !== 'unmount') assert.doesNotMatch(JSON.stringify(view.toJSON()), /calendar@example.com/)
    } finally { await act(async () => view.unmount()); f.restore() }
  }
})
