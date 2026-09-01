import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_AVATAR_COLORS, budAccentColorFor, fnv1a32 } from './theme-colors.ts'

test('fnv1a32 matches the reference vectors (and therefore the service copy)', () => {
  assert.equal(fnv1a32(''), 0x811c9dc5)
  assert.equal(fnv1a32('a'), 0xe40c292c)
  assert.equal(fnv1a32('foobar'), 0xbf9cf968)
})

test('budAccentColorFor depends only on the id', () => {
  const id = 'b_01ARZ3NDEKTSV4RRFFQ69G5FAV'
  assert.equal(budAccentColorFor(id), budAccentColorFor(id))
  assert.ok(DEFAULT_AVATAR_COLORS.includes(budAccentColorFor(id)))
  const seen = new Set(Array.from({ length: 50 }, (_, i) => budAccentColorFor(`b_${i}`)))
  assert.ok(seen.size > 1)
})
