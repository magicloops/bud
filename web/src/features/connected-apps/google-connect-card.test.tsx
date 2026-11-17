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
function inventory(access: Partial<Record<GoogleService, GoogleAccessLevel>>, id = 'connection', email = 'google@example.com'): GoogleInventory {
  return { configured: true, connections: [{
    connection_id: id, email, status: 'connected',
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
  const tabStorage = new Map<string, string>()
  const browser = Object.assign(new EventTarget(), {
    location: { search, assign: (url: string) => navigation.push(url) },
    sessionStorage: { getItem: (id: string) => tabStorage.get(id) ?? null,
      setItem: (id: string, value: string) => tabStorage.set(id, value), removeItem: (id: string) => tabStorage.delete(id) },
  })
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
    ...[{ add_account: false }, { add_account: 'true' }].map(extra => ({ ...payload, connect_request: { ...payload.connect_request, ...extra } })),
    { ...payload, connect_request: { ...payload.connect_request, connection_id: 'work', add_account: true } },
    ...[null, '', '   ', 'x'.repeat(81), 3].map(connection_id => ({ ...payload, connect_request: { ...payload.connect_request, connection_id } })),
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
      await act(async () => { view = create(authorized(createElement(ChatTimeline, { threadId: 'thread', messages: rows }))) })
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
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { thread_id: 'thread', connection_id: 'connection', selections: [{ service: 'calendar', access: 'read_write' }] })
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
    assert.match(JSON.stringify(view.toJSON()), /connection wasn’t completed/)
    await act(async () => view.root.findByType('button').props.onClick())
    await f.reply(1, { error: 'unavailable' }, 409)
    assert.equal(view.root.findByType('button').props.disabled, false)
    assert.match(JSON.stringify(view.toJSON()), /Could not start/)
    await act(async () => { f.browser.dispatchEvent(new Event('focus')) })
    await f.reply(2, inventory({ calendar: 'read_only' }))
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /Send a message to continue/)
    await act(async () => view.root.findByType('select').props.onChange({ target: { value: 'connection' } }))
    assert.match(JSON.stringify(view.toJSON()), /google@example.com/)
    assert.match(JSON.stringify(view.toJSON()), /Send a message to continue/)
    assert.equal(view.root.findAllByType('button').length, 0)
    assert.equal(f.requests.length, 3)
  } finally { await act(async () => view.unmount()); f.restore() }
})

for (const granted of [false, true]) {
  test(`browser Back refreshes the cached consent card when access was ${granted ? 'granted' : 'canceled'}`, async () => {
    const f = fixture()
    let view!: ReactTestRenderer
    try {
      await act(async () => { view = create(authorized(createElement(GoogleConnectCard, { threadId: 'thread', service: 'gmail', access: 'read_only' }))) })
      await f.reply(0, disconnected)
      await act(async () => button(view, 'Add Google account').props.onClick())
      await act(async () => { f.browser.dispatchEvent(new Event('focus')) })
      await f.reply(2, disconnected)
      assert.equal(button(view, 'Connecting…').props.disabled, true)
      await f.reply(1, { authorization_url: 'https://accounts.google.com/consent' })
      await act(async () => { f.browser.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })) })
      assert.equal(f.requests[3].path, '/api/google/connection')
      assert.match(JSON.stringify(view.toJSON()), /Checking connection/)
      assert.equal(view.root.findAllByType('button').length, 0)
      await f.reply(3, granted ? inventory({ gmail: 'read_only' }) : disconnected)
      assert.equal(f.requests.length, 4)
      assert.deepEqual(f.navigation, ['https://accounts.google.com/consent'])
      if (granted) {
        assert.match(JSON.stringify(view.toJSON()), /Send a message to continue/)
        assert.equal(view.root.findAllByType('button').length, 0)
      } else {
        const retry = button(view, 'Add Google account')
        assert.equal(retry.props.disabled, false)
        await act(async () => { retry.props.onClick(); retry.props.onClick() })
        assert.equal(f.requests.length, 5)
        assert.equal(f.requests[4].path, '/api/google/connect')
        assert.equal(f.requests[4].init?.body, f.requests[1].init?.body)
      }
    } finally { await act(async () => view.unmount()); f.restore() }
  })
}

test('a success query alone is not connection proof; failed inventory can be retried', async () => {
  const f = fixture('?google=connected')
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(GoogleConnectCard, { threadId: 'thread', service: 'calendar', access: 'read_only' }))) })
    await f.reply(0, { error: 'unavailable' }, 503)
    await act(async () => view.root.findByType('button').props.onClick())
    await f.reply(1, disconnected)
    assert.equal(view.root.findByType('button').children.join(''), 'Add Google account')
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
      assert.match(JSON.stringify(view.toJSON()), /No accounts have access/)
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
    assert.match(JSON.stringify(view.toJSON()), /google@example.com.*Read access/)
    await act(async () => button(view, 'Enable full access').props.onClick())
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { connection_id: 'connection', selections: [{ service: 'calendar', access: 'read_write' }] })
    await f.reply(1, { error: 'canceled' }, 409)
    const card = view.root.findByProps({ 'aria-label': 'Google Calendar connection' })
    const revoke = card.findAllByType('button').find(item => item.children.join('') === 'Revoke access')!
    await act(async () => { revoke.props.onClick(); revoke.props.onClick() })
    assert.equal(f.requests.length, 3)
    assert.equal(f.requests[2].path, '/api/google/connection/connection/services/calendar')
    assert.equal(f.requests[2].init?.method, 'DELETE')
    assert.equal(f.requests[2].init?.credentials, 'include')
    await f.reply(2, {})
    assert.ok(card.findAllByType('button').some(item => item.children.join('') === 'Connect google@example.com'))
    await f.reply(3, inventory({ ...access, calendar: 'none' }))
    for (const service of services.filter(value => value !== 'calendar')) {
      const other = view.root.findByProps({ 'aria-label': `${GOOGLE_SERVICES[service].name} connection` })
      assert.equal(other.findAllByType('button').some(item => item.children.join('') === 'Revoke access'), true)
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
    assert.match(JSON.stringify(view.toJSON()), /No accounts have access/)
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /Full access/)
    assert.ok(button(view, 'Reconnect'))
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
      assert.equal(view.root.findAllByProps({ 'aria-label': 'Manage google@example.com' }).length, 1)
      assert.match(JSON.stringify(view.toJSON()), /google@example.com/)
      assert.doesNotMatch(JSON.stringify(view.toJSON()), /Could not load|encryption|decrypt/)
      assert.equal(view.root.findAllByType('button').filter(item => item.children.join('') === 'Connect google@example.com').length, configured ? services.length : 0)
      await act(async () => { button(view, 'Clear saved connection').props.onClick(); button(view, 'Clear saved connection').props.onClick() })
      assert.equal(f.requests.length, 2)
      assert.equal(f.requests[1].path, '/api/google/connection/connection')
      assert.equal(f.requests[1].init?.method, 'DELETE')
      assert.equal(f.requests[1].init?.credentials, 'include')
      await f.reply(1, {})
      assert.equal(button(view, 'Clear saved connection'), undefined)
      assert.doesNotMatch(JSON.stringify(view.toJSON()), /google@example.com/)
      await f.reply(2, { ...disconnected, configured })
      assert.equal(view.root.findAllByProps({ 'aria-label': 'Manage google@example.com' }).length, 0)
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
    await act(async () => gmail.findAllByType('button').find(item => item.children.join('') === 'Connect google@example.com')!.props.onClick())
    assert.equal(f.requests[1].path, '/api/google/connect')
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { connection_id: 'connection', selections: [{ service: 'gmail', access: 'read_write' }] })
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
    assert.ok(view.root.findByProps({ 'aria-label': 'Gmail connection' }).findAllByType('button').some(item => item.children.join('') === 'Revoke access'))
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('task recovery preserves its exact requested access and does not require clearing or Settings', async () => {
  for (const access of ['read_only', 'read_write'] as const) {
    const f = fixture()
    let view!: ReactTestRenderer
    try {
      await act(async () => { view = create(authorized(createElement(GoogleConnectCard, { threadId: 'thread', service: 'gmail', access }))) })
      await f.reply(0, recoveryInventory())
      assert.match(JSON.stringify(view.toJSON()), /account needs to be reconnected/)
      assert.doesNotMatch(JSON.stringify(view.toJSON()), /Send a message to continue/)
      assert.equal(view.root.findAllByType('button').length, 1)
      await act(async () => button(view, 'Reconnect Gmail').props.onClick())
      assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { thread_id: 'thread', connection_id: 'connection', selections: [{ service: 'gmail', access }] })
      await f.reply(1, { authorization_url: 'https://accounts.google.com/reconnect-task' })
      assert.deepEqual(f.navigation, ['https://accounts.google.com/reconnect-task'])
    } finally { await act(async () => view.unmount()); f.restore() }
  }
})

function twoAccounts(): GoogleInventory {
  return { configured: true, connections: [
    ...inventory({ calendar: 'read_write', gmail: 'read_only' }, 'work', 'work@example.com').connections,
    ...inventory({ calendar: 'read_only', drive: 'read_write' }, 'personal', 'personal@example.com').connections,
  ] }
}

test('Settings scopes upgrades, new services, revocation and deletion to the selected account', async () => {
  const f = fixture('?google=connected')
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(ConnectedAppsSettings))) })
    await f.reply(0, twoAccounts())
    const calendar = view.root.findByProps({ 'aria-label': 'Google Calendar connection' })
    const work = calendar.findByProps({ 'aria-label': 'work@example.com' })
    const personal = calendar.findByProps({ 'aria-label': 'personal@example.com' })
    assert.deepEqual(work.findAllByType('button').map(b => b.children.join('')), ['Revoke access'])
    const upgrade = personal.findAllByType('button').find(b => b.children.join('') === 'Enable full access')!
    await act(async () => upgrade.props.onClick())
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { selections: [{ service: 'calendar', access: 'read_write' }], connection_id: 'personal' })
    await f.reply(1, {}, 409)

    const gmail = view.root.findByProps({ 'aria-label': 'Gmail connection' })
    await act(async () => gmail.findAllByType('button').find(b => b.children.join('') === 'Connect personal@example.com')!.props.onClick())
    assert.deepEqual(JSON.parse(String(f.requests[2].init?.body)), { selections: [{ service: 'gmail', access: 'read_write' }], connection_id: 'personal' })
    await f.reply(2, {}, 409)
    await act(async () => calendar.findAllByType('button').find(b => b.children.join('') === 'Add Google account')!.props.onClick())
    assert.deepEqual(JSON.parse(String(f.requests[3].init?.body)), { selections: [{ service: 'calendar', access: 'read_write' }] })
    await f.reply(3, {}, 409)

    await act(async () => personal.findAllByType('button').find(b => b.children.join('') === 'Revoke access')!.props.onClick())
    assert.equal(f.requests[4].path, '/api/google/connection/personal/services/calendar')
    await f.reply(4, {})
    assert.equal(calendar.findAllByProps({ 'aria-label': 'personal@example.com' }).length, 0)
    const remaining = twoAccounts()
    remaining.connections[1].access.calendar = 'none'
    await f.reply(5, remaining)
    const remove = view.root.findByProps({ 'aria-label': 'Manage personal@example.com' }).findByType('button')
    await act(async () => remove.props.onClick())
    assert.equal(f.requests[6].path, '/api/google/connection/personal')
    assert.equal(f.requests[6].init?.method, 'DELETE')
    await f.reply(6, {})
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /personal@example.com/)
    assert.match(JSON.stringify(view.toJSON()), /work@example.com/)
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('Settings requires a choice when several saved accounts could enable a service', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(ConnectedAppsSettings))) })
    const data = twoAccounts()
    data.connections[0].access.drive = data.connections[1].access.drive = 'none'
    await f.reply(0, data)
    const drive = view.root.findByProps({ 'aria-label': 'Google Drive connection' })
    const connect = drive.findAllByType('button').find(b => b.children.join('') === 'Connect account')!
    assert.equal(connect.props.disabled, true)
    await act(async () => drive.findByType('select').props.onChange({ target: { value: 'personal' } }))
    assert.equal(connect.props.disabled, false)
    await act(async () => connect.props.onClick())
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { connection_id: 'personal', selections: [{ service: 'drive', access: 'read_write' }] })
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('targeted chat evidence requires that exact account and active thread even after a success callback', async () => {
  const f = fixture('?google=connected')
  let view!: ReactTestRenderer
  try {
    const timeline = (id: string, threadId = 'thread') => authorized(createElement(ChatTimeline, {
      threadId, messages: [{ ...messages[0], tool_payload: { ...payload, connect_request: {
        ...payload.connect_request, access: 'read_write', connection_id: id,
      } } }],
    }))
    await act(async () => { view = create(timeline('personal')) })
    await f.reply(0, twoAccounts())
    assert.match(JSON.stringify(view.toJSON()), /personal@example.com/)
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /work@example.com|Send a message/)
    assert.equal(view.root.findAllByType('select').length, 0)
    await act(async () => button(view, 'Upgrade Calendar access').props.onClick())
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { connection_id: 'personal', thread_id: 'thread', selections: [{ service: 'calendar', access: 'read_write' }] })
    await act(async () => view.update(timeline('removed')))
    assert.equal(f.requests[1].init?.signal?.aborted, true)
    await f.reply(1, { authorization_url: 'https://accounts.google.com/obsolete' })
    assert.deepEqual(f.navigation, [])
    await f.reply(2, twoAccounts())
    assert.match(JSON.stringify(view.toJSON()), /no longer connected/)
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /personal@example.com|work@example.com|Send a message/)
    assert.equal(view.root.findAllByType('button').length, 0)
    await act(async () => view.update(timeline('work', 'different-thread')))
    assert.equal(view.root.findAllByType(GoogleConnectCard).length, 0)
    assert.equal(f.requests.length, 3)
    await act(async () => view.update(timeline('work')))
    await f.reply(3, twoAccounts())
    assert.match(JSON.stringify(view.toJSON()), /Send a message naming work@example.com/)
    assert.equal(view.root.findAllByType('button').length, 0)
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('untargeted chat requires a choice, supports ready accounts and starts a separate Add flow', async () => {
  const f = fixture('?google=connected')
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(GoogleConnectCard, { threadId: 'thread', service: 'calendar', access: 'read_write' }))) })
    await f.reply(0, twoAccounts())
    const select = view.root.findByType('select')
    assert.equal(select.props.value, '')
    assert.equal(view.root.findAllByType('button').length, 0)
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /Connected as|Send a message/)
    await act(async () => select.props.onChange({ target: { value: 'work' } }))
    assert.match(JSON.stringify(view.toJSON()), /Send a message naming work@example.com/)
    await act(async () => select.props.onChange({ target: { value: 'personal' } }))
    assert.ok(button(view, 'Upgrade Calendar access'))
    assert.equal(f.requests.length, 1)
    await act(async () => { f.browser.dispatchEvent(new Event('focus')) })
    await f.reply(1, disconnected)
    assert.ok(button(view, 'Add Google account'))
    await act(async () => { f.browser.dispatchEvent(new Event('focus')) })
    await f.reply(2, twoAccounts())
    const refreshedSelect = view.root.findByType('select')
    const addValue = refreshedSelect.findAllByType('option').find(o => o.children.join('') === 'Add Google account')!.props.value
    await act(async () => refreshedSelect.props.onChange({ target: { value: addValue } }))
    await act(async () => button(view, 'Add Google account').props.onClick())
    assert.deepEqual(JSON.parse(String(f.requests[3].init?.body)), { thread_id: 'thread', selections: [{ service: 'calendar', access: 'read_write' }] })
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('explicit Add account chat evidence opens the chooser even with existing access', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    const rows = [{ ...messages[0], tool_payload: { ...payload, connect_request: { ...payload.connect_request, add_account: true } } }]
    await act(async () => { view = create(authorized(createElement(ChatTimeline, { messages: rows, threadId: 'thread' }))) })
    await f.reply(0, twoAccounts())
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /Connected as|work@example.com|personal@example.com/)
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /Send a message/)
    assert.equal(view.root.findAllByType('select').length, 0)
    await act(async () => button(view, 'Add Google account').props.onClick())
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { thread_id: 'thread', selections: [{ service: 'calendar', access: 'read_only' }] })
    await f.reply(1, { authorization_url: 'https://accounts.google.com/chooser' })
    assert.deepEqual(f.navigation, ['https://accounts.google.com/chooser'])
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('an Add callback for an existing account lets the user upgrade that email in chat', async () => {
  const f = fixture('?google=account_already_connected')
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(GoogleConnectCard, { threadId: 'thread', service: 'calendar', access: 'read_write', addAccount: true }))) })
    await f.reply(0, twoAccounts())
    assert.match(JSON.stringify(view.toJSON()), /already saved in Bud/)
    assert.equal(view.root.findAllByType('button').length, 0)
    await act(async () => view.root.findByType('select').props.onChange({ target: { value: 'personal' } }))
    await act(async () => button(view, 'Upgrade Calendar access').props.onClick())
    assert.deepEqual(JSON.parse(String(f.requests[1].init?.body)), { thread_id: 'thread', connection_id: 'personal', selections: [{ service: 'calendar', access: 'read_write' }] })
  } finally { await act(async () => view.unmount()); f.restore() }
})

for (const [add, status, returnedId, ready] of [
  [false, 'connected', 'work', true],
  [true, 'connected', 'work', true],
  [true, 'connected', 'personal', false],
  [true, 'account_already_connected', 'personal', false],
] as const) {
  test(`OAuth return ${status} for ${add ? 'Add' : 'Connect'} uses the initiating card and checks ${returnedId}'s grant`, async () => {
    const f = fixture()
    let view!: ReactTestRenderer
    const row = (id: string) => ({ ...messages[0], message_id: id, client_id: id, tool_payload: {
      ...payload, connect_request: { ...payload.connect_request, access: 'read_write', ...(add ? { add_account: true } : {}) },
    } })
    const timeline = (ids: string[]) => authorized(createElement(ChatTimeline, { messages: ids.map(row), threadId: 'thread' }))
    try {
      await act(async () => { view = create(timeline(['initiator'])) })
      await f.reply(0, disconnected)
      await act(async () => button(view, 'Add Google account').props.onClick())
      await f.reply(1, { authorization_url: 'https://accounts.google.com/chooser' })
      await act(async () => view.unmount())
      f.browser.location.search = `?google=${status}&google_connection_id=${returnedId}`
      await act(async () => { view = create(timeline(['initiator', 'unrelated'])) })
      await f.reply(2, twoAccounts())
      await f.reply(3, twoAccounts())
      const [initiator, unrelated] = view.root.findAllByProps({ 'aria-label': 'Google Calendar connection' })
      assert.equal(initiator.findByType('select').props.value, returnedId)
      assert.equal(initiator.findAllByType('button').length, ready ? 0 : 1)
      assert.equal(initiator.findAllByType('p').some(p => p.children.join('').includes('Send a message')), ready)
      assert.equal(unrelated.findAllByType('p').some(p => p.children.join('').includes('Send a message')), false)
      if (!ready) {
        await act(async () => initiator.findByType('button').props.onClick())
        assert.deepEqual(JSON.parse(String(f.requests[4].init?.body)), {
          thread_id: 'thread', connection_id: returnedId, selections: [{ service: 'calendar', access: 'read_write' }],
        })
      }
    } finally { await act(async () => view.unmount()); f.restore() }
  })
}

test('a callback ID without a matching tab receipt cannot select an existing account', async () => {
  const f = fixture('?google=connected&google_connection_id=work')
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(GoogleConnectCard, {
      threadId: 'thread', messageId: 'unrelated', service: 'calendar', access: 'read_write', addAccount: true,
    }))) })
    await f.reply(0, twoAccounts())
    assert.ok(button(view, 'Add Google account'))
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /Send a message|Connected as/)
    const select = view.root.findByType('select')
    await act(async () => select.props.onChange({ target: { value: 'work' } }))
    assert.match(JSON.stringify(view.toJSON()), /Send a message naming work@example.com/)
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('Settings restores cached pages by rechecking inventory and fencing an old consent response', async () => {
  const f = fixture()
  let view!: ReactTestRenderer
  try {
    await act(async () => { view = create(authorized(createElement(ConnectedAppsSettings))) })
    await f.reply(0, twoAccounts())
    await act(async () => button(view, 'Add Google account').props.onClick())
    await act(async () => { f.browser.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })) })
    assert.equal(f.requests[1].init?.signal?.aborted, true)
    assert.equal(f.requests[2].path, '/api/google/connection')
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /work@example.com|personal@example.com/)
    await f.reply(1, { authorization_url: 'https://accounts.google.com/abandoned' })
    assert.deepEqual(f.navigation, [])
    await f.reply(2, inventory({ drive: 'read_write' }, 'fresh', 'fresh@example.com'))
    assert.match(JSON.stringify(view.toJSON()), /fresh@example.com/)
    await act(async () => { f.browser.dispatchEvent(new Event('focus')) })
    await f.reply(3, { error: 'unavailable' }, 503)
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /fresh@example.com/)
    await act(async () => button(view, 'Refresh').props.onClick())
    await f.reply(4, disconnected)
    assert.ok(button(view, 'Add Google account'))
  } finally { await act(async () => view.unmount()); f.restore() }
})

test('one chat consent receipt binds one unambiguous callback and survives a reload of that result', async () => {
  for (const firstReturn of [
    '?google=connected&google_connection_id=work',
    '?google=connected&google_connection_id=work&google_connection_id=personal',
    '?google=connected&google=failed&google_connection_id=work',
    '?google=failed',
  ]) {
    const f = fixture()
    let view!: ReactTestRenderer
    const card = () => authorized(createElement(GoogleConnectCard, {
      threadId: 'thread', messageId: 'initiator', service: 'calendar', access: 'read_write', addAccount: true,
    }))
    async function mount(search: string, data: GoogleInventory) {
      if (view) await act(async () => view.unmount())
      f.browser.location.search = search
      await act(async () => { view = create(card()) })
      await f.reply(f.requests.length - 1, data)
    }
    try {
      await mount('', twoAccounts())
      await act(async () => button(view, 'Add Google account').props.onClick())
      await f.reply(1, { authorization_url: 'https://accounts.google.com/chooser' })
      const successful = firstReturn === '?google=connected&google_connection_id=work'
      for (let visit = 0; visit < 2; visit++) {
        await mount(firstReturn, twoAccounts())
        assert.equal(JSON.stringify(view.toJSON()).includes('Send a message naming work@example.com'), successful)
      }
      const changed = twoAccounts()
      changed.connections[1].access.calendar = 'read_write'
      await mount('?google=connected&google_connection_id=personal', changed)
      assert.doesNotMatch(JSON.stringify(view.toJSON()), /Connected as|Send a message/)
    } finally { await act(async () => view.unmount()); f.restore() }
  }
})

for (const cached of [false, true]) {
  test(`browser Back invalidates abandoned consent (${cached ? 'cached' : 'reloaded'} page)`, async () => {
    const f = fixture()
    let view!: ReactTestRenderer
    const card = () => authorized(createElement(GoogleConnectCard, {
      threadId: 'thread', messageId: 'initiator', service: 'calendar', access: 'read_write', addAccount: true,
    }))
    try {
      await act(async () => { view = create(card()) })
      await f.reply(0, twoAccounts())
      await act(async () => button(view, 'Add Google account').props.onClick())
      await f.reply(1, { authorization_url: 'https://accounts.google.com/chooser' })
      if (cached) {
        await act(async () => { f.browser.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })) })
      } else {
        await act(async () => view.unmount())
        await act(async () => { view = create(card()) })
      }
      await f.reply(2, twoAccounts())
      await act(async () => view.unmount())
      f.browser.location.search = '?google=connected&google_connection_id=work'
      await act(async () => { view = create(card()) })
      await f.reply(3, twoAccounts())
      assert.doesNotMatch(JSON.stringify(view.toJSON()), /Connected as|Send a message/)
      assert.ok(button(view, 'Add Google account'))
    } finally { await act(async () => view.unmount()); f.restore() }
  })
}
