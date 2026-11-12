import test from 'node:test'
import assert from 'node:assert/strict'
import { phoneNeedsAttention, phonePermission, readersSummary, storedSummary, webAccessSteps, type DataSource } from './data-sources.ts'

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
    ['allow_agent', 'turn_on', 'continue_on_phone'])
  assert.deepEqual(webAccessSteps(source({ installations: [phone({ permission: 'denied' })] })), ['continue_on_phone'])
  assert.deepEqual(webAccessSteps(source({ installations: [phone({ permission: 'denied' }), phone({ permission: 'unknowable' })] })), [],
    'one phone that can collect is enough')
})
