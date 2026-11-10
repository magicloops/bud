import test from 'node:test'
import assert from 'node:assert/strict'
import { savedAddress, visitAddress, visitDuration, visitNearby, visitTitle, type LocationVisit } from './location-format.ts'

const visit = (overrides: Partial<LocationVisit> = {}): LocationVisit => ({ id: 'v', state: 'completed',
  arrival_at: '2026-10-15T09:00:00Z', departure_at: '2026-10-15T10:30:00Z', duration_s: 5400,
  coordinate: { lat: 37.78251, lon: -122.40791 }, horizontal_accuracy_m: 30,
  address: { full: '1 Mint Plaza, San Francisco, CA', short: '1 Mint Plaza', city: 'San Francisco' },
  place: { name: 'Blue Bottle Coffee', distance_m: 12 }, ...overrides })

test('visit titles prefer a nearby place, then the street, city and coordinates', () => {
  assert.equal(visitTitle(visit()), 'Blue Bottle Coffee')
  assert.equal(visitTitle(visit({ place: { name: 'Far Cafe', distance_m: 180 } })), '1 Mint Plaza')
  assert.equal(visitNearby(visit({ place: { name: 'Far Cafe', distance_m: 180 } })), 'Near Far Cafe (180 m)')
  assert.equal(visitNearby(visit()), null)
  assert.equal(visitTitle(visit({ place: null, address: { city: 'San Francisco' } })), 'San Francisco')
  assert.equal(visitTitle(visit({ place: null, address: null })), '37.7825, -122.4079')
})

test('visit durations describe in-progress and unknown ends', () => {
  assert.equal(visitDuration(visit()), '1 h 30 min')
  assert.equal(visitDuration(visit({ duration_s: 1500 })), '25 min')
  assert.equal(visitDuration(visit({ state: 'in_progress', duration_s: null })), 'Here now')
  assert.equal(visitDuration(visit({ state: 'end_unknown', duration_s: null })), 'End unknown')
  assert.equal(visitDuration(visit({ state: 'left', duration_s: null, left: { by: '2026-10-15T09:23:00Z', last_seen_at: null, max_duration_s: 1380 } })), 'Under 23 min')
})

test('saved places title a visit before Apple Maps names', () => {
  assert.equal(visitTitle(visit({ places: [{ id: 'p1', name: 'Home' }] })), 'Home')
  assert.equal(visitTitle(visit({ places: [{ id: 'p1', name: 'Office' }, { id: 'p2', name: 'Campus' }] })), 'Office · Campus')
  assert.equal(visitTitle(visit({ places: [] })), 'Blue Bottle Coffee')
})

test('a visit at a saved place shows the place\'s own address, never Apple\'s', () => {
  const apple = { full: '3384 26th St, San Francisco, CA', short: '3384 26th St', city: 'San Francisco' }
  const at = (places: LocationVisit['places']) => visit({ address: apple, places })
  assert.equal(visitAddress(at([{ id: 'h', name: 'Home', address: '3327 26th St, San Francisco' }])), '3327 26th St, San Francisco')
  assert.equal(visitAddress(at([{ id: 'h', name: 'Home', address: null }])), null, 'a saved place without one shows none')
  assert.equal(visitAddress(at([])), '3384 26th St, San Francisco, CA')
  assert.equal(savedAddress([{ id: 'o', name: 'Office' }, { id: 'h', name: 'Home', address: '3327 26th St' }]), '3327 26th St')
  assert.equal(savedAddress(undefined), null)
})
