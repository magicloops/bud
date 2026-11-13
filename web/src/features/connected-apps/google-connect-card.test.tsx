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
const { ConnectedAppsSettings } = await import('./settings')
const { GoogleApprovalCard } = await import('./google-approval-card')
const { googleApprovalRequest } = await import('./google-approval-request')
const { GOOGLE_SERVICES } = await import('./google-services')
const { applyAgentStateOverlay, applyPendingRequestInventory, buildPendingToolMessageFromToolCall } = await import('@/features/threads/thread-message-state')
const { GoogleConnectCard } = await import('./google-connect-card')
const { ChatTimeline } = await import('@/components/workbench/chat-timeline')
const { AuthSessionContext } = await import('@/contexts/auth-session-context')
const { projectTimeline } = await import('@/features/threads/agent-work-projection')
const { googleConnectRequest } = await import('./google-connect-request')

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
    assert.equal(googleConnectRequest(invalid), null)
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
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { thread_id: 'thread', selections: [{ service: 'calendar', access: 'read_write' }] })
    await f.reply(1, { authorization_url: 'https://accounts.google.com/fixture-consent' })
    assert.deepEqual(f.navigation, ['https://accounts.google.com/fixture-consent'])
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('consent cancellation, request failure, and focus recovery remain actionable without automatic mutation', async () => {
  const f = fixture('?google=failed')
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(GoogleConnectCard, { threadId: 'thread', service: 'calendar' }))) })
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
    await act(async () => { view = create(authorized(createElement(GoogleConnectCard, { threadId: 'thread', service: 'calendar' }))) })
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
      const card = (owner = 'alice', threadId = 'thread') => authorized(createElement(GoogleConnectCard, { threadId, service: 'calendar' }), owner)
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

const broadConnection = {
  connection_id: 'connection', email: 'calendar@example.com', status: 'connected',
  calendar_access: true, calendar_write_access: true,
  write_policy: { calendar: 'ask_before_write' },
}
const approval = {
  approval_id: 'approval', thread_id: 'thread', service: 'calendar' as const, tool_name: 'calendar_create_event',
  arguments_json: JSON.stringify({ summary: 'Review', attendees: ['one@example.com', 'two@example.com'], description: 'Full proposal\nWith all details' }),
  account_email: 'calendar@example.com', status: 'pending' as const,
  created_at: '2026-11-12T10:00:00Z', expires_at: '2099-11-12T11:00:00Z',
}
function button(view: ReactTestRenderer, text: string) {
  return view.root.findAllByType('button').find(item => item.children.join('') === text)!
}

test('explicit read-only setup and write upgrade request the selected Google access', async () => {
  for (const writeRequired of [false, true]) {
    const f = fixture()
    let view!: ReactTestRenderer
    try {
      await act(async () => { view = create(authorized(createElement(GoogleConnectCard, { threadId: 'thread', service: 'calendar', writeRequired }))) })
      await f.reply(0, writeRequired ? { configured: true, writes_enabled: true, connections: [{ ...broadConnection, calendar_write_access: false }] } : disconnected)
      if (!writeRequired) await act(async () => view.root.findByType('select').props.onChange({ target: { value: 'read_only' } }))
      else assert.match(JSON.stringify(view.toJSON()), /Enable changes for/)
      await act(async () => view.root.findByType('button').props.onClick())
      assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), {
        thread_id: 'thread', selections: [{ service: 'calendar', access: writeRequired ? 'read_write' : 'read_only' }],
      })
      assert.match(JSON.stringify(view.toJSON()), /revoke Bud in your Google Account/)
    } finally { await act(async () => view.unmount()); f.restore() }
  }
})

test('settings submits only selected services in one consent request with changes defaulting to ask first', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(ConnectedAppsSettings))) })
    await f.reply(0, { configured: true, writes_enabled: true, connections: [] })
    assert.equal(button(view, 'Continue with Google').props.disabled, true)
    const inputs = view.root.findAllByType('input')
    assert.equal(inputs.length, Object.keys(GOOGLE_SERVICES).length)
    for (const input of inputs.slice(0, 2)) await act(async () => input.props.onChange({ target: { checked: true } }))
    await act(async () => { button(view, 'Continue with Google').props.onClick(); button(view, 'Continue with Google').props.onClick() })
    assert.equal(f.requests.length, 2)
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { selections: Object.keys(GOOGLE_SERVICES).slice(0, 2).map(service => ({ service, access: 'read_write' })) })
    await act(async () => view.update(authorized(createElement(ConnectedAppsSettings), 'bob')))
    await f.reply(1, { authorization_url: 'https://accounts.google.com/old-owner' })
    assert.deepEqual(f.navigation, [])
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('Bud policy toggles keep Google authorization; global disable and read-only grants prevent enabling writes', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(ConnectedAppsSettings))) })
    await f.reply(0, { configured: true, writes_enabled: true, connections: [broadConnection] })
    const policy = view.root.findByProps({ 'aria-label': 'Google Calendar changes' })
    await act(async () => policy.props.onChange({ target: { value: 'read_only' } }))
    assert.equal(f.requests[1].path, '/api/google/connection/connection/policy')
    assert.equal(f.requests[1].init?.method, 'PATCH')
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { service: 'calendar', policy: 'read_only' })
    await f.reply(1, {})
    await f.reply(2, { configured: true, writes_enabled: false, connections: [{ ...broadConnection, write_policy: { calendar: 'read_only' } }] })
    assert.equal(view.root.findByProps({ 'aria-label': 'Google Calendar changes' }).props.disabled, true)
    assert.match(JSON.stringify(view.toJSON()), /disabled for everyone/)
    assert.match(JSON.stringify(view.toJSON()), /enable changes again without reconnecting/)
    assert.equal(f.requests.some(request => request.path === '/api/google/connect'), false)
    await act(async () => { f.browser.dispatchEvent(new Event('focus')) })
    await f.reply(3, { configured: true, writes_enabled: true, connections: [{ ...broadConnection, calendar_write_access: false, write_policy: { calendar: 'read_only' } }] })
    assert.equal(view.root.findByProps({ 'aria-label': 'Google Calendar changes' }).findByProps({ value: 'ask_before_write' }).props.disabled, true)
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('durable approvals recover without active runtime, preserve canonical cards, and clear only approval waits', () => {
  const pending = { name: 'google_call', client_id: 'proposal', call_id: 'call', started_at: approval.created_at, args: { google_approval: approval } }
  const state = { active: false, turn_id: null, pending_google_approvals: [{ turn_id: 'turn', invocation_id: 'invocation', pending_tool: pending }] } as unknown as import('@/lib/api-types').ApiAgentState
  const recovered = applyAgentStateOverlay([], state)
  assert.equal(recovered.length, 1)
  assert.deepEqual(googleApprovalRequest(recovered[0].tool_payload), approval)
  assert.equal(projectTimeline({ messages: [...recovered, messages[1]], liveTurnId: null })[0].kind, 'message')
  const canonical = { ...recovered[0], message_id: 'persisted', metadata: { turn_id: 'turn' }, tool_payload: { kind: 'google', tool: 'google_call', approval_request: { ...approval, status: 'consumed' } } }
  assert.deepEqual(applyAgentStateOverlay([canonical], state), [canonical])
  const liveRead = buildPendingToolMessageFromToolCall({ turnId: 'turn', clientId: 'read', callId: 'read-call', name: 'google_call', args: { tool_name: 'calendar_list_events' } })
  assert.deepEqual(applyPendingRequestInventory([...recovered, liveRead], { ...state, pending_google_approvals: [] }), [liveRead])
  assert.equal(googleApprovalRequest({ content: JSON.stringify(approval) }), null)
  assert.equal(googleApprovalRequest({ tool: 'google_call', google_approval: { ...approval, arguments_json: 'invalid' } }), null)
})

test('approval requires fresh authoritative status, displays every argument, and submits once without claiming success', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(GoogleApprovalCard, { request: approval }))) })
    assert.equal(button(view, 'Approve change'), undefined)
    assert.equal(f.requests[0].path, '/api/google/approvals/approval')
    await f.reply(0, { approval })
    assert.equal(button(view, 'Approve change').props.disabled, false)
    const rendered = JSON.stringify(view.toJSON())
    for (const text of ['one@example.com', 'two@example.com', 'With all details', 'calendar_create_event']) assert.ok(rendered.includes(text))
    await act(async () => { button(view, 'Approve change').props.onClick(); button(view, 'Reject').props.onClick() })
    assert.equal(f.requests.length, 2)
    assert.equal(f.requests[1].path, '/api/google/approvals/approval/decision')
    assert.equal(f.requests[1].init?.credentials, 'include')
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { decision: 'approved' })
    await f.reply(1, { approval: { ...approval, status: 'approved' } })
    assert.match(JSON.stringify(view.toJSON()), /approval does not confirm it succeeded/)
    assert.equal(button(view, 'Approve change'), undefined)
    await act(async () => { f.browser.dispatchEvent(new Event('focus')) })
    await f.reply(2, { approval: { ...approval, status: 'consumed' } })
    assert.match(JSON.stringify(view.toJSON()), /Check Bud’s result/)
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('approval identity, owner changes, expiration, and unknown decision outcomes fence decisions', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(GoogleApprovalCard, { request: approval }))) })
    await f.reply(0, { approval: { ...approval, thread_id: 'other-thread' } })
    assert.equal(button(view, 'Approve change'), undefined)
    await act(async () => button(view, 'Refresh approval').props.onClick())
    await f.reply(1, { approval })
    await act(async () => button(view, 'Reject').props.onClick())
    await f.reply(2, { error: 'unavailable' }, 503)
    assert.equal(button(view, 'Approve change'), undefined)
    assert.match(JSON.stringify(view.toJSON()), /Could not confirm your decision/)
    await act(async () => button(view, 'Refresh approval').props.onClick())
    await f.reply(3, { approval })
    await act(async () => button(view, 'Reject').props.onClick())
    await act(async () => view.update(authorized(createElement(GoogleApprovalCard, { request: approval }), 'bob')))
    assert.equal(f.requests[4].init?.signal?.aborted, true)
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /one@example.com|With all details|calendar@example.com/)
    await f.reply(4, { approval: { ...approval, status: 'rejected' } })
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /Rejected. This change|one@example.com|With all details|calendar@example.com/)
    await f.reply(5, { approval: { ...approval, expires_at: '2020-01-01T00:00:00Z' } })
    assert.equal(button(view, 'Approve change'), undefined)
    assert.match(JSON.stringify(view.toJSON()), /approval expired/)
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('mounted timeline shows a pending approval outside Worked and preserves the canonical review', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    const review = buildPendingToolMessageFromToolCall({ turnId: 'turn', clientId: 'proposal', callId: 'call', name: 'google_call', args: { google_approval: approval } })
    await act(async () => { view = create(authorized(createElement(ChatTimeline, { messages: [review, messages[1]] }))) })
    await f.reply(0, { approval })
    assert.equal(button(view, 'Approve change').props.disabled, false)
    const canonical = { ...review, message_id: 'saved', metadata: { turn_id: 'turn' }, tool_payload: { kind: 'google', tool: 'google_call', approval_request: { ...approval, status: 'rejected' } } }
    await act(async () => view.update(authorized(createElement(ChatTimeline, { messages: [canonical, messages[1]] }))))
    await f.reply(1, { approval: { ...approval, status: 'rejected' } })
    assert.equal(view.root.findAllByProps({ 'aria-label': 'Review Google change' }).length, 1)
    assert.match(JSON.stringify(view.toJSON()), /Rejected. This change was not authorized/)
  } finally { await act(async () => view.unmount()); f.restore() }
})
