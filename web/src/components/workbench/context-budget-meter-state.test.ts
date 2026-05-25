import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiContextBudget } from '../../lib/api-types.ts'
import {
  formatRoundedTokenCount,
  getContextBudgetMeterPresentation,
  getContextBudgetRingProgress,
} from './context-budget-meter-state.ts'

const AVAILABLE_BUDGET: ApiContextBudget = {
  status: 'available',
  model: 'gpt-test',
  provider: 'openai',
  context_window_tokens: 120_000,
  usable_context_window_tokens: 110_000,
  reserved_output_tokens: 10_000,
  usable_input_window_tokens: 100_000,
  compaction_enabled: true,
  compaction_threshold_ratio: 0.9,
  compaction_threshold_tokens: 90_000,
  effective_budget_tokens: 90_000,
  estimated_input_tokens: 45_000,
  remaining_context_tokens: 45_000,
  percent_of_context_budget: 0.5,
  percent_of_model_window: 0.375,
  basis: 'provider_usage_plus_delta',
  confidence: 'high',
  stale: false,
  updated_at: '2026-05-24T10:00:00.000Z',
  latest_checkpoint_id: null,
  compacted_through_message_id: null,
  compacted_through_llm_call_id: null,
}

test('formatRoundedTokenCount rounds compact token counts for the meter tooltip', () => {
  assert.equal(formatRoundedTokenCount(999), '999')
  assert.equal(formatRoundedTokenCount(1_250), '1.3k')
  assert.equal(formatRoundedTokenCount(312_000), '312k')
  assert.equal(formatRoundedTokenCount(1_250_000), '1.3m')
})

test('getContextBudgetRingProgress clamps the radial send-button ring', () => {
  assert.equal(getContextBudgetRingProgress({ percent: null }), 0)
  assert.equal(getContextBudgetRingProgress({ percent: 0 }), 0)
  assert.equal(getContextBudgetRingProgress({ percent: 0.5 }), 50)
  assert.equal(getContextBudgetRingProgress({ percent: 1 }), 100)
  assert.equal(getContextBudgetRingProgress({ percent: 1.25 }), 100)
})

test('getContextBudgetMeterPresentation uses compaction-budget percent as the primary label', () => {
  const presentation = getContextBudgetMeterPresentation(AVAILABLE_BUDGET)

  assert.equal(presentation.tone, 'normal')
  assert.equal(presentation.percentLabel, '50%')
  assert.equal(presentation.compactLabel, 'Context 50%')
  assert.match(presentation.title, /auto-compact limit/)
  assert.ok(presentation.detailLines.some((line) => line.includes('45k remaining')))
  assert.ok(presentation.detailLines.some((line) => line.includes('Bud cap 110k')))
  assert.ok(presentation.detailLines.some((line) => line.includes('output reserve 10k')))
  assert.ok(presentation.detailLines.some((line) => line.includes('Usable input window 100k')))
  assert.ok(presentation.detailLines.some((line) => line.includes('Hard model window 120k')))
  assert.ok(presentation.detailLines.some((line) => line.includes('last provider usage plus new messages')))
  assert.ok(presentation.detailLines.some((line) => line.includes('high confidence')))
})

test('getContextBudgetMeterPresentation changes tone near the compaction threshold', () => {
  assert.equal(
    getContextBudgetMeterPresentation({
      ...AVAILABLE_BUDGET,
      estimated_input_tokens: 68_000,
      remaining_context_tokens: 22_000,
      percent_of_context_budget: 0.755,
    }).tone,
    'elevated',
  )
  assert.equal(
    getContextBudgetMeterPresentation({
      ...AVAILABLE_BUDGET,
      estimated_input_tokens: 78_000,
      remaining_context_tokens: 12_000,
      percent_of_context_budget: 0.866,
    }).tone,
    'near',
  )
  assert.equal(
    getContextBudgetMeterPresentation({
      ...AVAILABLE_BUDGET,
      estimated_input_tokens: 91_000,
      remaining_context_tokens: 0,
      percent_of_context_budget: 1.011,
    }).tone,
    'over',
  )
})

test('getContextBudgetMeterPresentation changes copy when auto-compaction is disabled', () => {
  const presentation = getContextBudgetMeterPresentation({
    ...AVAILABLE_BUDGET,
    compaction_enabled: false,
    effective_budget_tokens: 100_000,
    remaining_context_tokens: 55_000,
    percent_of_context_budget: 0.45,
  })

  assert.match(presentation.title, /usable input window/)
  assert.ok(presentation.detailLines.some((line) => line.includes('before the usable input window')))
  assert.equal(
    presentation.detailLines.some((line) => line.includes('before auto-compaction')),
    false,
  )
})

test('getContextBudgetMeterPresentation handles unknown budgets', () => {
  const presentation = getContextBudgetMeterPresentation({
    status: 'unknown',
    model: 'local-model',
    provider: null,
    reason: 'unknown_model_context_window',
    stale: true,
    updated_at: '2026-05-24T10:00:00.000Z',
  })

  assert.equal(presentation.tone, 'unknown')
  assert.equal(presentation.percent, null)
  assert.equal(presentation.compactLabel, 'Context --')
  assert.ok(presentation.detailLines.some((line) => line.includes('metadata is missing')))
  assert.ok(presentation.detailLines.some((line) => line.includes('current turn settles')))
})

test('getContextBudgetMeterPresentation handles invalid context policy', () => {
  const presentation = getContextBudgetMeterPresentation({
    status: 'unknown',
    model: 'local-model',
    provider: null,
    reason: 'invalid_context_policy',
    stale: false,
    updated_at: '2026-05-24T10:00:00.000Z',
  })

  assert.equal(presentation.tone, 'unknown')
  assert.ok(presentation.detailLines.some((line) => line.includes('policy metadata is invalid')))
})
