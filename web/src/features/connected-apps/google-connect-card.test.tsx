import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { register } from 'node:module'
import type { GoogleAccess, GoogleAccessLevel, GoogleInventory, GoogleService } from './google-services'
import type { ApiCurrentUser, ApiMessage } from '@/lib/api-types'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { ConnectedAppsSettings } = await import('./settings')
const { GOOGLE_SERVICES } = await import('./google-services')
const { GoogleConnectCard } = await import('./google-connect-card')
const { ChatTimeline } = await import('@/components/workbench/chat-timeline')
const { AuthSessionContext } = await import('@/contexts/auth-session-context')
const { projectTimeline } = await import('@/features/threads/agent-work-projection')
const { googleConnectRequest } = await import('./google-connect-request')

const services = Object.keys(GOOGLE_SERVICES) as GoogleService[]
const payload = { kind: 'google', tool: 'google_search_tools', connect_request: { provider: 'google_calendar', thread_id: 'thread', access: 'read_only' } }
const messages: ApiMessage[] = [
  { message_id: 'connect', client_id: 'connect', role: 'tool', display_role: 'Tool', content: 'Connect Calendar',
    created_at: '2026-11-12T10:00:00Z', metadata: { turn_id: 'turn' }, tool_payload: payload },
  { message_id: 'final', client_id: 'final', role: 'assistant', display_role: 'Bud', content: 'Connect above to continue.',
    created_at: '2026-11-12T10:00:01Z', metadata: { turn_id: 'turn', segment_kind: 'final' } },
]
const disconnected = { configured: true, connections: [] }
function inventory(access: Partial<Record<GoogleService, GoogleAccessLevel>>): GoogleInventory {
  return { configured: true, connections: [{
    connection_id: 'connection', email: 'google@example.com', status: 'connected',
    access: Object.fromEntries(services.map(service => [service, access[service] ?? 'none'])),
    ...Object.fromEntries(services.flatMap(service => [[`${service}_access`, Boolean(access[service] && access[service] !== 'none')], [`${service}_write_access`, access[service] === 'read_write']])),
  }] } as GoogleInventory
}
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
function button(view: ReactTestRenderer, text: string) {
  return view.root.findAllByType('button').find(item => item.children.join('') === text)!
}

test('only structured consent evidence with explicit valid access creates a top-level card', () => {
  for (const rows of [messages, JSON.parse(JSON.stringify(messages))]) {
    assert.deepEqual(projectTimeline({ messages: rows, liveTurnId: null }).map(item => item.kind), ['message', 'message'])
  }
  for (const access of ['read_only', 'read_write']) assert.equal(googleConnectRequest({ ...payload, tool: 'google_call', connect_request: { ...payload.connect_request, access } })?.access, access)
  for (const invalid of [null, { connect_request: payload.connect_request }, { ...payload, tool: 'terminal_run' },
    { ...payload, connect_request: { ...payload.connect_request, provider: 'gmail' } },
    { ...payload, connect_request: { ...payload.connect_request, thread_id: '' } },
    { ...payload, connect_request: { provider: 'google_calendar', thread_id: 'thread' } },
    { ...payload, connect_request: { ...payload.connect_request, access: 'all' } }]) {
    assert.equal(googleConnectRequest(invalid), null)
  }
})

for (const service of services) for (const access of ['read_only', 'read_write'] as const) {
  test(`${service} task card requests exactly ${access}, without a picker or duplicate OAuth request`, async () => {
    const f = fixture()
    let view!: ReactTestRenderer
    try {
      const rows = messages.map(message => message.role === 'tool' ? { ...message, tool_payload: {
        ...payload, connect_request: { provider: `google_${service}`, thread_id: 'thread', access },
      } } : message)
      await act(async () => { view = create(authorized(createElement(ChatTimeline, { messages: rows }))) })
      assert.equal(f.requests[0].path, '/api/google/connection')
      await f.reply(0, disconnected)
      const { name, shortName } = GOOGLE_SERVICES[service]
      const card = view.root.findByProps({ 'aria-label': `${name} connection` })
      assert.ok(JSON.stringify(view.toJSON()).includes(access === 'read_only' ? `Read ${shortName}` : `Full ${shortName} access`))
      assert.equal(card.findAllByType('select').length, 0)
      assert.equal(card.findAllByType('input').length, 0)
      await act(async () => { card.findByType('button').props.onClick(); card.findByType('button').props.onClick() })
      assert.equal(f.requests.length, 2)
      assert.equal(f.requests[1].path, '/api/google/connect')
      assert.equal(f.requests[1].init?.method, 'POST')
      assert.equal(f.requests[1].init?.credentials, 'include')
      assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { thread_id: 'thread', selections: [{ service, access }] })
      await f.reply(1, { authorization_url: 'https://accounts.google.com/fixture-consent' })
      assert.deepEqual(f.navigation, ['https://accounts.google.com/fixture-consent'])
    } finally { await act(async () => view.unmount()); f.restore() }
  })
}

test('cards use effective service access, upgrade reads for writes, and accept broader existing access', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    const card = (access: GoogleAccess) => authorized(createElement(GoogleConnectCard, { threadId: 'thread', service: 'calendar', access }))
    await act(async () => { view = create(card('read_write')) })
    await f.reply(0, inventory({ calendar: 'read_only' }))
    assert.ok(button(view, 'Upgrade Calendar access'))
    await act(async () => button(view, 'Upgrade Calendar access').props.onClick())
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { thread_id: 'thread', selections: [{ service: 'calendar', access: 'read_write' }] })
    await act(async () => view.update(card('read_only')))
    assert.equal(f.requests[1].init?.signal?.aborted, true)
    await f.reply(2, inventory({ calendar: 'read_write' }))
    assert.match(JSON.stringify(view.toJSON()), /Send a message to continue/)
    assert.equal(view.root.findAllByType('button').length, 0)
    await act(async () => { f.browser.dispatchEvent(new Event('focus')) })
    const revoked = inventory({ calendar: 'none' })
    Object.assign(revoked.connections[0], { calendar_access: true, calendar_write_access: true })
    await f.reply(3, revoked)
    assert.ok(button(view, 'Connect Calendar'))
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /Send a message to continue/)
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('consent cancellation, request failure, and focus recovery remain actionable without automatic mutation', async () => {
  const f = fixture('?google=failed')
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(GoogleConnectCard, { threadId: 'thread', service: 'calendar', access: 'read_only' }))) })
    await f.reply(0, disconnected)
    assert.match(JSON.stringify(view.toJSON()), /Connection wasn’t completed/)
    await act(async () => view.root.findByType('button').props.onClick())
    await f.reply(1, { error: 'unavailable' }, 409)
    assert.equal(view.root.findByType('button').props.disabled, false)
    assert.match(JSON.stringify(view.toJSON()), /Could not start/)
    await act(async () => { f.browser.dispatchEvent(new Event('focus')) })
    await f.reply(2, inventory({ calendar: 'read_only' }))
    assert.match(JSON.stringify(view.toJSON()), /google@example.com/)
    assert.match(JSON.stringify(view.toJSON()), /Send a message to continue/)
    assert.equal(view.root.findAllByType('button').length, 0)
    assert.equal(f.requests.length, 3)
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('a success query alone is not connection proof; failed inventory can be retried', async () => {
  const f = fixture('?google=connected')
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(GoogleConnectCard, { threadId: 'thread', service: 'calendar', access: 'read_only' }))) })
    await f.reply(0, { error: 'unavailable' }, 503)
    await act(async () => view.root.findByType('button').props.onClick())
    await f.reply(1, disconnected)
    assert.equal(view.root.findByType('button').children.join(''), 'Connect Calendar')
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /Send a message to continue/)
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('owner, thread, access or service changes and unmount fence stale inventory and OAuth navigation', async () => {
  for (const change of ['owner', 'thread', 'access', ...(services.length > 1 ? ['service'] : []), 'unmount']) {
    const f = fixture()
    let view!: ReactTestRenderer
    try {
      const card = (owner = 'alice', threadId = 'thread', access: GoogleAccess = 'read_only', service: GoogleService = 'calendar') => authorized(createElement(GoogleConnectCard, { threadId, service, access }), owner)
      await act(async () => { view = create(card()) })
      await f.reply(0, disconnected)
      await act(async () => view.root.findByType('button').props.onClick())
      await act(async () => { f.browser.dispatchEvent(new Event('focus')) })
      await act(async () => change === 'unmount' ? view.unmount() : view.update(card(change === 'owner' ? 'bob' : 'alice', change === 'thread' ? 'another' : 'thread', change === 'access' ? 'read_write' : 'read_only', change === 'service' ? services[1] : 'calendar')))
      assert.equal(f.requests[1].init?.signal?.aborted, true)
      assert.equal(f.requests[2].init?.signal?.aborted, true)
      await f.reply(1, { authorization_url: 'https://accounts.google.com/obsolete' })
      await f.reply(2, inventory({ calendar: 'read_write' }))
      assert.deepEqual(f.navigation, [])
      if (change !== 'unmount') assert.doesNotMatch(JSON.stringify(view.toJSON()), /google@example.com/)
    } finally { await act(async () => view.unmount()); f.restore() }
  }
})

for (const service of services) {
  test(`settings ${service} Connect requests full access and fences duplicate and obsolete navigation`, async () => {
    const f = fixture()
    let view!: ReactTestRenderer
    try {
      await act(async () => { view = create(authorized(createElement(ConnectedAppsSettings))) })
      await f.reply(0, disconnected)
      assert.equal(view.root.findAllByType('select').length, 0)
      assert.equal(view.root.findAllByType('input').length, 0)
      const card = view.root.findByProps({ 'aria-label': `${GOOGLE_SERVICES[service].name} connection` })
      assert.match(JSON.stringify(view.toJSON()), /No access/)
      await act(async () => { card.findByType('button').props.onClick(); card.findByType('button').props.onClick() })
      assert.equal(f.requests.length, 2)
      assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { selections: [{ service, access: 'read_write' }] })
      await act(async () => view.update(authorized(createElement(ConnectedAppsSettings), 'bob')))
      await f.reply(1, { authorization_url: 'https://accounts.google.com/old-owner' })
      assert.deepEqual(f.navigation, [])
    } finally { await act(async () => view.unmount()); f.restore() }
  })
}

test('settings upgrades read access and revokes only the selected service, preserving the others', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(ConnectedAppsSettings))) })
    const access = Object.fromEntries(services.map(service => [service, service === 'calendar' ? 'read_only' : 'read_write'])) as Record<GoogleService, GoogleAccessLevel>
    await f.reply(0, inventory(access))
    assert.match(JSON.stringify(view.toJSON()), /Read access.*google@example.com/)
    await act(async () => button(view, 'Enable full access').props.onClick())
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { selections: [{ service: 'calendar', access: 'read_write' }] })
    await f.reply(1, { error: 'canceled' }, 409)
    const card = view.root.findByProps({ 'aria-label': 'Google Calendar connection' })
    const revoke = card.findAllByType('button').find(item => item.children.join('') === 'Revoke access')!
    await act(async () => { revoke.props.onClick(); revoke.props.onClick() })
    assert.equal(f.requests.length, 3)
    assert.equal(f.requests[2].path, '/api/google/connection/connection/services/calendar')
    assert.equal(f.requests[2].init?.method, 'DELETE')
    assert.equal(f.requests[2].init?.credentials, 'include')
    await f.reply(2, {})
    assert.ok(card.findAllByType('button').some(item => item.children.join('') === 'Connect'))
    await f.reply(3, inventory({ ...access, calendar: 'none' }))
    for (const service of services.filter(value => value !== 'calendar')) {
      const other = view.root.findByProps({ 'aria-label': `${GOOGLE_SERVICES[service].name} connection` })
      assert.equal(other.findByType('button').children.join(''), 'Revoke access')
    }
    assert.match(JSON.stringify(view.toJSON()), /revoke Bud in your Google Account/)
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('settings keeps revocation available without OAuth setup and fences old-owner revoke results', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(ConnectedAppsSettings))) })
    await f.reply(0, { ...inventory({ calendar: 'read_write' }), configured: false })
    await act(async () => button(view, 'Revoke access').props.onClick())
    await act(async () => view.update(authorized(createElement(ConnectedAppsSettings), 'bob')))
    assert.equal(f.requests[1].init?.signal?.aborted, true)
    await f.reply(1, {})
    assert.equal(f.requests.length, 3)
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /google@example.com/)
    await f.reply(2, disconnected)
    assert.equal(button(view, 'Revoke access'), undefined)
  } finally { await act(async () => view.unmount()); f.restore() }
})


test('a reconnect-required service shows no usable access but retains Revoke access', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(ConnectedAppsSettings))) })
    const expired = inventory({ calendar: 'read_write' })
    expired.connections[0].status = 'reconnect_required'
    await f.reply(0, expired)
    assert.match(JSON.stringify(view.toJSON()), /No access/)
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /Full access/)
    assert.ok(button(view, 'Connect'))
    await act(async () => button(view, 'Revoke access').props.onClick())
    assert.equal(f.requests[1].path, '/api/google/connection/connection/services/calendar')
    assert.equal(f.requests[1].init?.method, 'DELETE')
    await f.reply(1, {})
    assert.equal(button(view, 'Revoke access'), undefined)
  } finally { await act(async () => view.unmount()); f.restore() }
})

function recoveryInventory(configured = true): GoogleInventory {
  const result = inventory({})
  result.configured = configured
  result.connections[0].status = 'reconnect_required'
  result.connections[0].recovery_required = true
  return result
}

test('unusable saved credentials show account recovery and can be cleared once with or without OAuth setup', async () => {
  for (const configured of [true, false]) {
    const f = fixture()
    let view!: ReactTestRenderer
    try {
      await act(async () => { view = create(authorized(createElement(ConnectedAppsSettings))) })
      await f.reply(0, recoveryInventory(configured))
      assert.equal(view.root.findAllByProps({ 'aria-label': 'Google connection recovery' }).length, 1)
      assert.match(JSON.stringify(view.toJSON()), /google@example.com/)
      assert.doesNotMatch(JSON.stringify(view.toJSON()), /Could not load|encryption|decrypt/)
      assert.equal(view.root.findAllByType('button').filter(item => item.children.join('') === 'Connect').length, configured ? services.length : 0)
      await act(async () => { button(view, 'Clear saved connection').props.onClick(); button(view, 'Clear saved connection').props.onClick() })
      assert.equal(f.requests.length, 2)
      assert.equal(f.requests[1].path, '/api/google/connection/connection')
      assert.equal(f.requests[1].init?.method, 'DELETE')
      assert.equal(f.requests[1].init?.credentials, 'include')
      await f.reply(1, {})
      assert.equal(button(view, 'Clear saved connection'), undefined)
      assert.doesNotMatch(JSON.stringify(view.toJSON()), /google@example.com/)
      await f.reply(2, { ...disconnected, configured })
      assert.equal(view.root.findAllByProps({ 'aria-label': 'Google connection recovery' }).length, 0)
    } finally { await act(async () => view.unmount()); f.restore() }
  }
})

test('settings can reconnect unusable credentials directly without first clearing the saved connection', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(ConnectedAppsSettings))) })
    await f.reply(0, recoveryInventory())
    const gmail = view.root.findByProps({ 'aria-label': 'Gmail connection' })
    await act(async () => gmail.findByType('button').props.onClick())
    assert.equal(f.requests[1].path, '/api/google/connect')
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { selections: [{ service: 'gmail', access: 'read_write' }] })
    await f.reply(1, { authorization_url: 'https://accounts.google.com/reconnect' })
    assert.deepEqual(f.navigation, ['https://accounts.google.com/reconnect'])
    assert.equal(f.requests.some(request => request.init?.method === 'DELETE'), false)
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('late clear responses cannot change a different owner’s connection view', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(ConnectedAppsSettings))) })
    await f.reply(0, recoveryInventory())
    await act(async () => button(view, 'Clear saved connection').props.onClick())
    await act(async () => view.update(authorized(createElement(ConnectedAppsSettings), 'bob')))
    assert.equal(f.requests[1].init?.signal?.aborted, true)
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /google@example.com|Reconnect Google/)
    await f.reply(2, inventory({ gmail: 'read_write' }))
    await f.reply(1, {})
    assert.equal(f.requests.length, 3)
    assert.equal(view.root.findByProps({ 'aria-label': 'Gmail connection' }).findByType('button').children.join(''), 'Revoke access')
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('task recovery preserves its exact requested access and does not require clearing or Settings', async () => {
  for (const access of ['read_only', 'read_write'] as const) {
    const f = fixture()
    let view!: ReactTestRenderer
    try {
      await act(async () => { view = create(authorized(createElement(GoogleConnectCard, { threadId: 'thread', service: 'gmail', access }))) })
      await f.reply(0, recoveryInventory())
      assert.match(JSON.stringify(view.toJSON()), /saved Google connection needs to be reconnected/)
      assert.doesNotMatch(JSON.stringify(view.toJSON()), /Send a message to continue/)
      assert.equal(view.root.findAllByType('button').length, 1)
      await act(async () => button(view, 'Connect Gmail').props.onClick())
      assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { thread_id: 'thread', selections: [{ service: 'gmail', access }] })
      await f.reply(1, { authorization_url: 'https://accounts.google.com/reconnect-task' })
      assert.deepEqual(f.navigation, ['https://accounts.google.com/reconnect-task'])
    } finally { await act(async () => view.unmount()); f.restore() }
  }
})
