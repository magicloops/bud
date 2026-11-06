import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiPlace } from './api-types.ts'
import type { PlacePin } from './place-pin.ts'
import {
  ADDRESS_DROP_M,
  addressAtPin,
  addressAtResult,
  clampRadius,
  distanceM,
  keepAddress,
  startAddress,
  typeAddress,
  pinCenter,
  placeAnswer,
  placeCreateBody,
  placeErrorMessage,
  placeQuestionStart,
  placeQuestionTitle,
  placeUpdateBody,
  restartsPresence,
} from './place-pin.ts'

const HOME: ApiPlace = {
  id: '01JAAAAAAAAAAAAAAAAAAAAAAA',
  name: 'Home',
  note: null,
  coordinate: { lat: 37.749003, lon: -122.416487 },
  radius_m: 50,
  address: '3327 26th St, San Francisco',
  geometry_revision: 'rev1',
  created_by: 'user',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
}

const pin = (changes: Partial<PlacePin> = {}): PlacePin =>
  ({ name: 'Home', center: HOME.coordinate, radius: 50, address: HOME.address!, ...changes })

test('placeUpdateBody sends only what changed', () => {
  assert.equal(placeUpdateBody(HOME, pin()), null)
  assert.deepEqual(placeUpdateBody(HOME, pin({ name: ' House ' })), { name: 'House' })
  assert.deepEqual(placeUpdateBody(HOME, pin({ radius: 125 })), { radius_m: 125 })
  assert.deepEqual(placeUpdateBody(HOME, pin({ address: ' 3329 26th St ' })), { address: '3329 26th St' })
  assert.deepEqual(placeUpdateBody(HOME, pin({ address: '  ' })), { address: null })
  assert.equal(placeUpdateBody({ ...HOME, address: null }, pin({ address: '' })), null)
})

test('placeUpdateBody always sends the address with a move, kept or cleared', () => {
  const moved = { lat: 37.7491, lon: -122.4165 }
  assert.deepEqual(placeUpdateBody(HOME, pin({ center: moved })),
    { latitude: 37.7491, longitude: -122.4165, address: '3327 26th St, San Francisco' })
  assert.deepEqual(placeUpdateBody(HOME, pin({ center: moved, address: '' })), { latitude: 37.7491, longitude: -122.4165, address: null })
})

test('map rounding below 0.1 m is not a move', () => {
  const nudged = { lat: HOME.coordinate.lat + 1e-8, lon: HOME.coordinate.lon - 1e-8 }
  assert.equal(placeUpdateBody(HOME, pin({ center: nudged })), null)
  assert.deepEqual(pinCenter(HOME.coordinate, nudged), HOME.coordinate)
  assert.deepEqual(pinCenter(HOME.coordinate, { lat: 37.74912345678, lon: -122.41651234567 }), { lat: 37.749123, lon: -122.416512 })
  assert.deepEqual(pinCenter(null, { lat: 1.23456789, lon: 2 }), { lat: 1.234568, lon: 2 })
})

test('restartsPresence flags moves and resizes of a starting point', () => {
  const start = { name: 'Home', center: HOME.coordinate, radius: 50 }
  assert.equal(restartsPresence(start, pin({ name: 'Other', address: '' })), false)
  assert.equal(restartsPresence(start, pin({ radius: 75 })), true)
  assert.equal(restartsPresence(start, pin({ center: { lat: 37.75, lon: -122.416487 } })), true)
})

test('radius is clamped to saved-place limits', () => {
  assert.equal(clampRadius(10), 50)
  assert.equal(clampRadius(5000), 2000)
  assert.equal(clampRadius(Number.NaN), 100)
  assert.deepEqual(placeCreateBody({ name: ' Work ', center: { lat: 1, lon: 2 }, radius: 99.6, address: ' ' }),
    { name: 'Work', latitude: 1, longitude: 2, radius_m: 100 })
  assert.deepEqual(placeCreateBody({ name: 'Work', center: { lat: 1, lon: 2 }, radius: 100, address: ' 3384 26th St ' }),
    { name: 'Work', latitude: 1, longitude: 2, radius_m: 100, address: '3384 26th St' })
})

test('placeAnswer builds the ask_user_questions place answer', () => {
  assert.deepEqual(placeAnswer(pin()), {
    kind: 'place', name: 'Home', latitude: 37.749003, longitude: -122.416487, radius_m: 50, address: '3327 26th St, San Francisco',
  })
  assert.equal('address' in placeAnswer(pin({ address: '' })), false)
})

test('placeQuestionStart seeds from the query or the existing place', () => {
  assert.deepEqual(placeQuestionStart({ name: 'Home', query: '3327 26th St, San Francisco', radius_m: 100 }, undefined),
    { name: 'Home', center: null, radius: 100, query: '3327 26th St, San Francisco', address: '3327 26th St, San Francisco' })
  assert.deepEqual(placeQuestionStart({ name: 'Home', place_id: HOME.id }, HOME),
    { name: 'Home', center: HOME.coordinate, radius: 50, address: '3327 26th St, San Francisco' })
  assert.equal(placeQuestionStart({ name: 'Home', place_id: HOME.id, radius_m: 75 }, HOME).radius, 75)
  assert.equal(placeQuestionStart({ name: 'Home', place_id: HOME.id }, undefined).radius, 100)
})

test('placeQuestionTitle names the address or the existing place', () => {
  assert.equal(placeQuestionTitle({ name: 'Home', query: '3327 26th St' }, undefined), 'Home — 3327 26th St')
  assert.equal(placeQuestionTitle({ name: 'Home' }, undefined), 'Home')
  assert.equal(placeQuestionTitle({ name: 'House', place_id: HOME.id }, HOME), 'Home')
})

test('placeErrorMessage explains refused place saves and passes other errors through', () => {
  assert.match(placeErrorMessage('place_not_found'), /no longer exists/)
  assert.match(placeErrorMessage('place_limit_reached'), /limit/)
  assert.equal(placeErrorMessage('HTTP 500'), 'HTTP 500')
})

/** A point `metres` north of `from`. */
const north = (from: { lat: number; lon: number }, metres: number) => ({ lat: from.lat + metres / 111_195, lon: from.lon })

test('an address stays within 50 m of its anchor and is cleared past it', () => {
  const start = startAddress({ name: 'Home', center: HOME.coordinate, radius: 50, address: HOME.address! })
  assert.deepEqual(start, { value: HOME.address, anchor: HOME.coordinate, dropped: null })
  assert.ok(Math.abs(distanceM(HOME.coordinate, north(HOME.coordinate, 49)) - 49) < 0.5)
  assert.equal(addressAtPin(start, north(HOME.coordinate, ADDRESS_DROP_M - 1)), start)
  const far = north(HOME.coordinate, ADDRESS_DROP_M + 1)
  const cleared = addressAtPin(start, far)
  assert.deepEqual(cleared, { value: '', anchor: HOME.coordinate, dropped: HOME.address })
  // Coming back doesn't restore it on its own; "Keep it" does, anchored at the current pin.
  assert.equal(addressAtPin(cleared, HOME.coordinate).value, '')
  const kept = keepAddress(cleared, far)
  assert.deepEqual(kept, { value: HOME.address, anchor: far, dropped: null })
  assert.equal(addressAtPin(kept, north(far, 40)).value, HOME.address)
})

test('typing re-anchors at the current pin', () => {
  const start = startAddress({ name: 'Home', center: HOME.coordinate, radius: 50 })
  const far = north(HOME.coordinate, 200)
  const typed = typeAddress('3384 26th St', far)
  assert.deepEqual(typed, { value: '3384 26th St', anchor: far, dropped: null })
  assert.equal(addressAtPin(typed, north(far, 30)).value, '3384 26th St')
  assert.deepEqual(start.value, '')
})

test('search results anchor the address; a pick fills it, the seed search only anchors the query', () => {
  const seeded = startAddress({ name: 'Home', center: null, radius: 100, query: '3327 26th St', address: '3327 26th St' })
  assert.equal(seeded.anchor, null)
  const result = { lat: 37.749, lon: -122.4165 }
  const anchored = addressAtResult(seeded, result, null)
  assert.deepEqual(anchored, { value: '3327 26th St', anchor: result, dropped: null })
  assert.equal(addressAtPin(anchored, north(result, 60)).value, '')
  assert.deepEqual(addressAtResult(anchored, result, '3327 26th St, San Francisco, CA 94110'),
    { value: '3327 26th St, San Francisco, CA 94110', anchor: result, dropped: null })
  // With no result to anchor on, the first pin anchors it.
  assert.deepEqual(addressAtPin(seeded, result), { ...seeded, anchor: result })
})
