import test from 'node:test'
import assert from 'node:assert/strict'
import { accessGroupLine, accessOperation, accessOutcome, phoneNeedsAttention, phonePermission, readersSummary, sourceChangeLine,
  sourceRequestClosedLine, sourceRequestPurpose, storedSummary,
  webAccessSteps, type AccessGroup, type DataSource } from './data-sources.ts'

const phone = (overrides: Partial<DataSource['installations'][number]> = {}): DataSource['installations'][number] => ({
  installation_id: 'phone', permission: 'granted', level: null, caveats: [], asked_at: null,
  reported_at: '2026-11-11T18:04:00Z', last_received_at: null, ...overrides })

test('stored counts read in a fixed order and skip zeros', () => {
  const stored = (counts: Record<string, number>) => ({ first_at: null, last_received_at: null, counts })
  assert.equal(storedSummary({ id: 'location', stored: stored({ points: 9120, visits: 412 }) }), '412 visits · 9,120 points')
  assert.equal(storedSummary({ id: 'health', stored: stored({ workouts: 1, sleep_segments: 0 }) }), '1 workout')
  assert.equal(storedSummary({ id: 'contacts', stored: stored({ contacts: 0 }) }), 'Nothing yet')
  assert.equal(storedSummary({ id: 'photos', stored: stored({ assets: 3 }) }), 'Nothing yet', 'a source this client does not know')
})

test('a phone’s permission reads per source, with what needs attention', () => {
  assert.equal(phonePermission('location', phone({ level: 'always' })), 'always')
  assert.equal(phonePermission('location', phone({ level: 'while_using', caveats: ['reduced_accuracy'] })),
    'only while using the app, with Precise Location off')
  assert.equal(phonePermission('contacts', phone({ caveats: ['limited'] })), 'limited access')
  assert.equal(phonePermission('health', phone({ permission: 'unknowable' })), 'asked; iOS does not say whether Health reading is allowed')
  assert.equal(phonePermission('location', phone({ permission: 'denied' })), 'denied; change it in iOS Settings on that phone')
  assert.equal(phoneNeedsAttention(phone({ permission: 'denied' })), true)
  assert.equal(phoneNeedsAttention(phone({ level: 'always', caveats: ['reduced_accuracy'] })), true)
  assert.equal(phoneNeedsAttention(phone({ permission: 'unknowable' })), false)
  assert.equal(phoneNeedsAttention(phone({ level: 'always' })), false)
})

test('readers are named, and kept while a source is off', () => {
  const app = { key_id: 'k', label: 'Week in review', last_used_at: null }
  assert.equal(readersSummary({ enabled: true, agent: { allowed: false }, apps: [] }), 'Nothing is allowed to read this.')
  assert.equal(readersSummary({ enabled: true, agent: { allowed: true }, apps: [app] }), 'Your agent and 1 app can read this.')
  assert.equal(readersSummary({ enabled: false, agent: { allowed: true }, apps: [] }), 'Your agent can read this once it is turned back on.')
})

test('an access request on the web walks the agent and the switch, then hands iOS permission to the phone', () => {
  const source = (overrides: Partial<Pick<DataSource, 'enabled' | 'agent' | 'installations'>> = {}) =>
    ({ enabled: true, agent: { allowed: true }, installations: [phone({ level: 'always' })], ...overrides })
  assert.deepEqual(webAccessSteps(source()), [])
  assert.deepEqual(webAccessSteps(source({ enabled: false, agent: { allowed: false }, installations: [] })),
    ['turn_on', 'continue_on_phone'])
  assert.deepEqual(webAccessSteps(source({ agent: { allowed: false } })), ['turn_on'], 'the agent’s permission alone is still one click')
  assert.deepEqual(webAccessSteps(source({ installations: [phone({ permission: 'denied' })] })), ['continue_on_phone'])
  assert.deepEqual(webAccessSteps(source({ installations: [phone({ permission: 'denied' }), phone({ permission: 'unknowable' })] })), [],
    'one phone that can collect is enough')
})

test('recent access names who read, how often, and for an agent, in which conversation', () => {
  const group = (overrides: Partial<AccessGroup>): AccessGroup => ({ actor: { kind: 'agent', ref: 't', label: null }, thread: null,
    reads: 1, refused: 0, last_at: '2026-11-12T10:00:00Z', ...overrides })
  const thread = { id: 't', title: 'Trip planning', bud_id: 'bud', exists: true }
  assert.equal(accessGroupLine(group({ reads: 3, refused: 1, thread })), 'Your agent · 3 reads, 1 refused · Trip planning')
  assert.equal(accessGroupLine(group({ thread: { ...thread, title: null } })), 'Your agent · 1 read · a conversation')
  assert.equal(accessGroupLine(group({ thread: { ...thread, title: null, exists: false } })), 'Your agent · 1 read · a deleted conversation')
  assert.equal(accessGroupLine(group({ reads: 0, refused: 2, thread })), 'Your agent · 2 refused · Trip planning')
  assert.equal(accessGroupLine(group({ actor: { kind: 'automation', ref: 'a', label: 'Evening summary' } })), 'Evening summary (automation) · 1 read')
  assert.equal(accessGroupLine(group({ actor: { kind: 'automation', ref: 'a', label: null } })), 'A deleted automation · 1 read')
  assert.equal(accessGroupLine(group({ actor: { kind: 'app', ref: 'k', label: 'Week in review', revoked: true }, reads: 12 })),
    'Week in review (app, revoked) · 12 reads')
  assert.equal(accessGroupLine(group({ actor: { kind: 'processor', ref: 'geoapify', label: 'Geoapify' }, reads: 4 })), 'Geoapify (outside service) · 4 lookups')
})

test('a read says what was read and what came of it, never content', () => {
  assert.equal(accessOperation('location_recent'), 'Latest location')
  assert.equal(accessOperation('reverse_geocode'), 'A visit’s coordinates, for its address')
  assert.equal(accessOperation('something_new'), 'something new')
  const agent = { kind: 'agent', ref: 't', label: null }
  assert.equal(accessOutcome({ outcome: 'ok', record_count: 12, actor: agent }), '12 records')
  assert.equal(accessOutcome({ outcome: 'ok', record_count: 1, actor: agent }), '1 record')
  assert.equal(accessOutcome({ outcome: 'ok', record_count: null, actor: agent }), 'read')
  assert.equal(accessOutcome({ outcome: 'ok', record_count: 1, actor: { kind: 'processor', ref: 'geoapify', label: 'Geoapify' } }), 'sent')
  assert.equal(accessOutcome({ outcome: 'source_off', record_count: null, actor: agent }), 'refused: the source was off')
  assert.equal(accessOutcome({ outcome: 'visit_not_found', record_count: null, actor: agent }), 'not completed (visit not found)')
})

test('changes to who may read a source read as sentences', () => {
  const at = '2026-11-12T10:00:00Z'
  assert.equal(sourceChangeLine({ at, kind: 'switch', enabled: false, by: 'web' }), 'Turned off on the web')
  assert.equal(sourceChangeLine({ at, kind: 'switch', enabled: true, by: 'migration' }), 'Turned on when switches were introduced')
  assert.equal(sourceChangeLine({ at, kind: 'agent', allowed: true }), 'Your agent was allowed to read this')
  assert.equal(sourceChangeLine({ at, kind: 'agent', allowed: false }), 'Your agent’s access was removed')
  assert.equal(sourceChangeLine({ at, kind: 'agent_detail', detail: { history_days: 30 } }), 'Your agent’s access changed: 30 days of history')
  assert.equal(sourceChangeLine({ at, kind: 'app', label: 'Week in review', action: 'revoked' }), 'Week in review was revoked')
})

test('a source request reads as one sentence and one closing line', () => {
  assert.equal(sourceRequestPurpose('tell you where you are'), 'Your agent wants this to tell you where you are.')
  assert.equal(sourceRequestPurpose(' To tell you where you are. '), 'Your agent wants this to tell you where you are.')
  assert.equal(sourceRequestPurpose('  '), 'Your agent asked for this.')
  assert.equal(sourceRequestClosedLine({ status: 'granted' }, 'Location'), 'Location turned on')
  assert.equal(sourceRequestClosedLine({ status: 'granted', result: { reading: 'received' } }, 'Location'), 'Location shared, with a fresh reading')
  assert.equal(sourceRequestClosedLine({ status: 'declined' }, 'Health'), 'Health not shared')
  assert.equal(sourceRequestClosedLine({ status: 'superseded' }, 'Contacts'), 'Contacts request closed')
  assert.equal(sourceChangeLine({ at: '', kind: 'request', outcome: 'declined' }), 'Your agent asked, and you chose not to share')
  assert.equal(sourceChangeLine({ at: '', kind: 'request', outcome: 'granted' }), 'Your agent asked, and you turned this on')
})
