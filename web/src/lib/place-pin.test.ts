import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiPlace } from './api-types.ts'
import {
  clampRadius,
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
  geometry_revision: 'rev1',
  created_by: 'user',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
}

test('placeUpdateBody sends only what changed', () => {
  assert.equal(placeUpdateBody(HOME, { name: 'Home', center: HOME.coordinate, radius: 50 }), null)
  assert.deepEqual(placeUpdateBody(HOME, { name: ' House ', center: HOME.coordinate, radius: 50 }), { name: 'House' })
  assert.deepEqual(placeUpdateBody(HOME, { name: 'Home', center: HOME.coordinate, radius: 125 }), { radius_m: 125 })
  assert.deepEqual(
    placeUpdateBody(HOME, { name: 'Home', center: { lat: 37.7491, lon: -122.4165 }, radius: 50 }),
    { latitude: 37.7491, longitude: -122.4165 },
  )
})

test('map rounding below 0.1 m is not a move', () => {
  const nudged = { lat: HOME.coordinate.lat + 1e-8, lon: HOME.coordinate.lon - 1e-8 }
  assert.equal(placeUpdateBody(HOME, { name: 'Home', center: nudged, radius: 50 }), null)
  assert.deepEqual(pinCenter(HOME.coordinate, nudged), HOME.coordinate)
  assert.deepEqual(pinCenter(HOME.coordinate, { lat: 37.74912345678, lon: -122.41651234567 }), { lat: 37.749123, lon: -122.416512 })
  assert.deepEqual(pinCenter(null, { lat: 1.23456789, lon: 2 }), { lat: 1.234568, lon: 2 })
})

test('restartsPresence flags moves and resizes of a starting point', () => {
  const start = { name: 'Home', center: HOME.coordinate, radius: 50 }
  assert.equal(restartsPresence(start, { name: 'Other', center: HOME.coordinate, radius: 50 }), false)
  assert.equal(restartsPresence(start, { name: 'Home', center: HOME.coordinate, radius: 75 }), true)
  assert.equal(restartsPresence(start, { name: 'Home', center: { lat: 37.75, lon: -122.416487 }, radius: 50 }), true)
})

test('radius is clamped to saved-place limits', () => {
  assert.equal(clampRadius(10), 50)
  assert.equal(clampRadius(5000), 2000)
  assert.equal(clampRadius(Number.NaN), 100)
  assert.deepEqual(placeCreateBody({ name: ' Work ', center: { lat: 1, lon: 2 }, radius: 99.6 }),
    { name: 'Work', latitude: 1, longitude: 2, radius_m: 100 })
})

test('placeAnswer builds the ask_user_questions place answer', () => {
  assert.deepEqual(placeAnswer({ name: 'Home', center: HOME.coordinate, radius: 50 }), {
    kind: 'place', name: 'Home', latitude: 37.749003, longitude: -122.416487, radius_m: 50,
  })
})

test('placeQuestionStart seeds from the query or the existing place', () => {
  assert.deepEqual(placeQuestionStart({ name: 'Home', query: '3327 26th St, San Francisco', radius_m: 100 }, undefined),
    { name: 'Home', center: null, radius: 100, query: '3327 26th St, San Francisco' })
  assert.deepEqual(placeQuestionStart({ name: 'Home', place_id: HOME.id }, HOME), { name: 'Home', center: HOME.coordinate, radius: 50 })
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
