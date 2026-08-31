import assert from 'node:assert/strict'
import test from 'node:test'
import { formatRelativeTimestamp } from './relative-time.ts'

test('relative timestamps step through the coarse units', () => {
  const now = Date.parse('2026-08-30T12:00:00Z')
  const at = (iso: string) => formatRelativeTimestamp(iso, now)

  assert.equal(at('2026-08-30T11:59:40Z'), 'just now')
  assert.equal(at('2026-08-30T11:59:00Z'), '1 minute ago')
  assert.equal(at('2026-08-30T11:15:00Z'), '45 minutes ago')
  assert.equal(at('2026-08-30T09:00:00Z'), '3 hours ago')
  assert.equal(at('2026-08-29T11:00:00Z'), '1 day ago')
  assert.equal(at('2026-08-23T12:00:00Z'), '7 days ago')
  assert.equal(at('2026-06-30T12:00:00Z'), '2 months ago')
  assert.equal(at('2024-08-30T12:00:00Z'), '2 years ago')
})

test('future and unparseable inputs degrade safely', () => {
  const now = Date.parse('2026-08-30T12:00:00Z')
  // Clock skew: a slightly-future stamp reads as fresh, never negative.
  assert.equal(formatRelativeTimestamp('2026-08-30T12:00:30Z', now), 'just now')
  assert.equal(formatRelativeTimestamp('not-a-date', now), '')
})
