import test from 'node:test'
import assert from 'node:assert/strict'
import { isTurnTiming, mergeTurnTimings } from './turn-timing.ts'

test('pages, snapshots and replay merge only valid settled totals without evicting history', () => {
  const original = mergeTurnTimings(new Map(), [{ turn_id: 'old', work_duration_ms: 95000 }])
  const next = mergeTurnTimings(original, [{ turn_id: 'new', work_duration_ms: 0 }, { turn_id: 'old' }])
  assert.equal(next.get('old'), 95000)
  assert.equal(next.get('new'), 0)
  assert.equal(mergeTurnTimings(next), next)
  assert.equal(mergeTurnTimings(next, [{ turn_id: 'old', work_duration_ms: 95000 }]), next)
  assert.equal(mergeTurnTimings(next, [{ turn_id: 'old', work_duration_ms: null }]).get('old'), null)
  assert.equal(original.size, 1)
  for (const value of [-1, undefined, NaN, Infinity, '100', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isTurnTiming({ turn_id: 'x', work_duration_ms: value }), false)
  }
})
