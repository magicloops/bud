import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_AVATAR_COLORS, pickNextAccentColor, withFallbackAccentColors } from './theme-colors.ts'

const [pink, orange, cyan, purple, green] = DEFAULT_AVATAR_COLORS as [string, string, string, string, string]

test('pickNextAccentColor walks the palette in order (mirrors the service rule)', () => {
  assert.equal(pickNextAccentColor([]), pink)
  assert.equal(pickNextAccentColor([pink]), orange)
  assert.equal(pickNextAccentColor([pink, cyan]), orange)
  assert.equal(pickNextAccentColor([null, '#ff0000', pink]), orange)
  assert.equal(pickNextAccentColor([pink, orange, cyan, purple, green]), pink)
})

test('withFallbackAccentColors assigns by creation order, not list order, and respects persisted colors', () => {
  const buds = [
    { bud_id: 'b_3', accent_color: null, created_at: '2026-03-01T00:00:00.000Z' },
    { bud_id: 'b_1', accent_color: null, created_at: '2026-01-01T00:00:00.000Z' },
    { bud_id: 'b_2', accent_color: purple, created_at: '2026-02-01T00:00:00.000Z' },
  ]
  assert.deepEqual(
    withFallbackAccentColors(buds).map((bud) => [bud.bud_id, bud.accent_color]),
    [
      ['b_3', orange],
      ['b_1', pink],
      ['b_2', purple],
    ],
  )
  // Reordering the input (as last_seen_at would) changes nothing.
  assert.deepEqual(
    withFallbackAccentColors([...buds].reverse()).map((bud) => bud.accent_color),
    [purple, pink, orange],
  )
})
