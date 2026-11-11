import test from 'node:test'
import assert from 'node:assert/strict'
import { placeSearchErrorMessage, placeSearchLabel, placeSearchPath } from './place-search.ts'

test('placeSearchPath trims, biases to the map centre and refuses short queries', () => {
  assert.equal(placeSearchPath(' 3327 26th St ', null), '/api/places/search?q=3327+26th+St')
  assert.equal(placeSearchPath('cafe', { lat: 37.76, lon: -122.42 }), '/api/places/search?q=cafe&near=37.76%2C-122.42')
  assert.equal(placeSearchPath(' a ', null), null)
  assert.equal(new URLSearchParams(placeSearchPath('x'.repeat(250), null)!.split('?')[1]).get('q')!.length, 200)
})

test('placeSearchLabel titles named places with their address underneath, and addresses alone', () => {
  const coordinate = { lat: 37.76, lon: -122.42 }
  assert.deepEqual(placeSearchLabel({ name: 'Café', address: '500 Valencia St', coordinate, category: 'catering.cafe' }),
    { title: 'Café', detail: '500 Valencia St' })
  assert.deepEqual(placeSearchLabel({ name: null, address: '3327 26th St', coordinate, category: null }), { title: '3327 26th St', detail: null })
  assert.deepEqual(placeSearchLabel({ name: null, address: null, coordinate, category: null }), { title: '37.76000, -122.42000', detail: null })
})

test('placeSearchErrorMessage explains rate limits and missing search, and keeps the map usable', () => {
  assert.match(placeSearchErrorMessage('place_search_rate_limited'), /Too many searches/)
  assert.match(placeSearchErrorMessage('place_lookup_unavailable'), /isn't set up on this server/)
  assert.match(placeSearchErrorMessage('place_lookup_failed'), /isn't working right now/)
  assert.match(placeSearchErrorMessage('invalid_query'), /at least 2 characters/)
})
