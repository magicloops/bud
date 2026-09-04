import assert from 'node:assert/strict'
import test from 'node:test'
import type { ApiMessage } from '../../lib/api-types.ts'
import {
  formatCompactTokens,
  formatCompactionPhase,
  getCompactionRowPresentation,
  isCompactionMessage,
} from './compaction-row-state.ts'

const ROW: ApiMessage = {
  message_id: 'm-1',
  client_id: 'c-1',
  role: 'compaction',
  display_role: 'Context compacted',
  content: '  ## Summary\n\nFixed the build.  ',
  created_at: '2026-09-03T10:00:05.000Z',
  metadata: {
    artifact_kind: 'context_compaction',
    model_visible: false,
    checkpoint_id: 'chk-1',
    phase: 'mid_turn',
    tokens_before: 245_000,
    tokens_after: 12_000,
    compacted_through_message_id: 'm-40',
  },
}

test('getCompactionRowPresentation builds the pill detail and trims the summary', () => {
  assert.equal(isCompactionMessage(ROW), true)
  assert.deepEqual(getCompactionRowPresentation(ROW), {
    label: 'Context compacted',
    detail: 'Mid-turn · 245k → 12k',
    summary: '## Summary\n\nFixed the build.',
    checkpointId: 'chk-1',
    compactedThroughMessageId: 'm-40',
  })
})

test('getCompactionRowPresentation tolerates missing metadata (backfilled or sparse rows)', () => {
  const sparse = getCompactionRowPresentation({ ...ROW, display_role: '', content: '', metadata: { phase: 'pre_turn' } })
  assert.equal(sparse.label, 'Context compacted')
  assert.equal(sparse.detail, 'Pre-turn')
  assert.equal(sparse.summary, '')
  assert.equal(sparse.checkpointId, null)
  assert.equal(getCompactionRowPresentation({ ...ROW, metadata: {} }).detail, '')
})

test('formatters', () => {
  assert.equal(formatCompactionPhase('standalone_turn'), 'Standalone')
  assert.equal(formatCompactionPhase('other'), 'other')
  assert.equal(formatCompactTokens(950), '950')
  assert.equal(formatCompactTokens(12_400), '12k')
  assert.equal(formatCompactTokens(1_250_000), '1.3m')
})
