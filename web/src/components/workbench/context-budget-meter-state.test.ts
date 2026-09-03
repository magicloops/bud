import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiContextBudget, ApiContextBudgetBreakdownEntry } from '../../lib/api-types.ts'
import {
  formatRoundedTokenCount,
  getContextBudgetMeterPresentation,
  getContextBudgetRingProgress,
} from './context-budget-meter-state.ts'

const TOTAL = 45_000

function entry(kind: ApiContextBudgetBreakdownEntry['kind'], tokens: number): ApiContextBudgetBreakdownEntry {
  return { kind, tokens, percent_of_estimated_input: tokens / TOTAL }
}

const BREAKDOWN: ApiContextBudgetBreakdownEntry[] = [
  entry('system_prompt', 5_000),
  entry('runtime_instructions', 100),
  entry('compaction_summary', 1_400),
  entry('user_messages', 6_000),
  entry('assistant_text', 4_000),
  entry('reasoning', 2_000),
  entry('tool_calls', 3_000),
  entry('tool_output', 21_400),
  entry('images', 100), // < 0.5% → folded into Other
  entry('tool_schemas', 2_000),
]

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
  message_estimated_tokens: 43_000,
  tool_schema_tokens: 2_000,
  estimated_input_tokens: TOTAL,
  breakdown: BREAKDOWN,
  compaction_count: 2,
  remaining_context_tokens: 45_000,
  percent_of_context_budget: 0.5,
  percent_of_model_window: 0.375,
  basis: 'model_agnostic_estimate',
  confidence: 'medium',
  source: 'durable_reconstruction',
  phase: 'idle',
  reason: null,
  turn_id: null,
  checked_at: '2026-05-24T10:00:00.000Z',
  stale: false,
  updated_at: '2026-05-24T10:00:00.000Z',
  latest_checkpoint_id: 'chk-1',
  compacted_through_message_id: null,
  compacted_through_llm_call_id: null,
  provider_usage_estimate: {
    estimated_input_tokens: 55_000,
    input_tokens: 40_000,
    output_tokens: 10_000,
    delta_tokens: 5_000,
    llm_call_id: 'llm-call-1',
    confidence: 'high',
  },
}

test('formatRoundedTokenCount rounds compact token counts', () => {
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

test('headline and subline lead with the limit, using the model display name', () => {
  const presentation = getContextBudgetMeterPresentation(AVAILABLE_BUDGET, { modelLabel: 'GPT Test' })

  assert.equal(presentation.tone, 'normal')
  assert.equal(presentation.percentLabel, '50%')
  assert.equal(presentation.compactLabel, 'Context 50%')
  assert.equal(presentation.headline, 'GPT Test · 50% of auto-compact limit')
  assert.equal(presentation.title, presentation.headline)
  assert.equal(presentation.subline, '45k of 90k · compacts at 90% of the 100k window')
})

test('rows group the breakdown, sort largest first, and fold tiny categories into Other', () => {
  const { rows } = getContextBudgetMeterPresentation(AVAILABLE_BUDGET)

  assert.deepEqual(
    rows.map((row) => [row.id, row.tokens, row.percentLabel]),
    [
      ['tool_output', 21_400, '48%'],
      ['messages', 10_000, '22%'],
      ['system_prompt', 5_100, '11%'],
      ['tool_calls', 3_000, '7%'],
      ['reasoning', 2_000, '4%'],
      ['tool_schemas', 2_000, '4%'],
      ['compaction_summary', 1_400, '3%'],
      ['other', 100, '<1%'],
    ],
  )
  assert.equal(rows.reduce((sum, row) => sum + row.tokens, 0), TOTAL)
  // Fixed palette colors per category, distinct for the major ones.
  const majorColors = ['tool_output', 'messages', 'system_prompt', 'tool_calls', 'reasoning'].map(
    (id) => rows.find((row) => row.id === id)?.color,
  )
  assert.equal(new Set(majorColors).size, majorColors.length)
  assert.ok(majorColors.every((color) => typeof color === 'string' && color.startsWith('oklch(')))
  assert.equal(rows.find((row) => row.id === 'compaction_summary')?.color, rows.find((row) => row.id === 'other')?.color)
})

test('footer states the basis, last measured request, compaction count, and reserve', () => {
  const { footer } = getContextBudgetMeterPresentation(AVAILABLE_BUDGET)
  assert.deepEqual(footer, [
    'Estimated (~4 chars/token) · last request 40k in / 10k out',
    'Compacted 2× · 10k reserved for the reply',
  ])
})

test('policy and provenance details live in diagnostics, not the product copy', () => {
  const presentation = getContextBudgetMeterPresentation(AVAILABLE_BUDGET)
  const productCopy = [presentation.headline, presentation.subline ?? '', ...presentation.footer].join('\n')
  for (const leak of ['Bud cap', 'Hard model window', 'backend estimate', 'durable reconstruction', 'confidence']) {
    assert.equal(productCopy.includes(leak), false, leak)
  }
  assert.ok(presentation.diagnostics.some((line) => line.includes('hard model window 120k')))
  assert.ok(presentation.diagnostics.some((line) => line.includes('durable reconstruction')))
})

test('older services without a breakdown fall back to the messages / tool-schemas split', () => {
  const withoutBreakdown: ApiContextBudget = { ...AVAILABLE_BUDGET, compaction_count: null }
  delete (withoutBreakdown as { breakdown?: unknown }).breakdown
  const { rows } = getContextBudgetMeterPresentation(withoutBreakdown)
  assert.deepEqual(rows.map((row) => [row.id, row.tokens]), [
    ['messages', 43_000],
    ['tool_schemas', 2_000],
  ])
})

test('compaction wording falls back to "Compacted earlier" when only a checkpoint id is known', () => {
  const { footer } = getContextBudgetMeterPresentation({ ...AVAILABLE_BUDGET, compaction_count: null })
  assert.match(footer[1]!, /^Compacted earlier · /)
  const fresh = getContextBudgetMeterPresentation({ ...AVAILABLE_BUDGET, compaction_count: 0, latest_checkpoint_id: null })
  assert.equal(fresh.footer[1], '10k reserved for the reply')
})

test('tone changes near the compaction threshold', () => {
  assert.equal(
    getContextBudgetMeterPresentation({ ...AVAILABLE_BUDGET, percent_of_context_budget: 0.755 }).tone,
    'elevated',
  )
  assert.equal(
    getContextBudgetMeterPresentation({ ...AVAILABLE_BUDGET, percent_of_context_budget: 0.866 }).tone,
    'near',
  )
  assert.equal(
    getContextBudgetMeterPresentation({ ...AVAILABLE_BUDGET, percent_of_context_budget: 1.011 }).tone,
    'over',
  )
})

test('copy changes when auto-compaction is disabled and when the snapshot is stale', () => {
  const disabled = getContextBudgetMeterPresentation({
    ...AVAILABLE_BUDGET,
    compaction_enabled: false,
    effective_budget_tokens: 100_000,
    remaining_context_tokens: 55_000,
    percent_of_context_budget: 0.45,
  })
  assert.match(disabled.headline, /of usable input window$/)
  assert.equal(disabled.subline, '45k of 100k · 100k window')

  const stale = getContextBudgetMeterPresentation({ ...AVAILABLE_BUDGET, stale: true })
  assert.match(stale.headline, /· Refreshing…$/)
})

test('unknown budgets render a reason instead of a breakdown', () => {
  const presentation = getContextBudgetMeterPresentation({
    status: 'unknown',
    model: 'local-model',
    provider: null,
    reason: 'unknown_model_context_window',
    source: 'durable_reconstruction',
    phase: 'idle',
    turn_id: null,
    checked_at: '2026-05-24T10:00:00.000Z',
    stale: true,
    updated_at: '2026-05-24T10:00:00.000Z',
  })

  assert.equal(presentation.tone, 'unknown')
  assert.equal(presentation.percent, null)
  assert.equal(presentation.compactLabel, 'Context --')
  assert.equal(presentation.headline, 'local-model: context unavailable')
  assert.deepEqual(presentation.rows, [])
  assert.ok(presentation.footer.some((line) => line.includes('metadata is missing')))
  assert.ok(presentation.footer.some((line) => line.includes('current turn settles')))
})

test('invalid context policy is reported as unknown', () => {
  const presentation = getContextBudgetMeterPresentation({
    status: 'unknown',
    model: 'local-model',
    provider: null,
    reason: 'invalid_context_policy',
    source: 'durable_reconstruction',
    phase: 'idle',
    turn_id: null,
    checked_at: '2026-05-24T10:00:00.000Z',
    stale: false,
    updated_at: '2026-05-24T10:00:00.000Z',
  })

  assert.equal(presentation.tone, 'unknown')
  assert.ok(presentation.footer.some((line) => line.includes('policy metadata is invalid')))
})
