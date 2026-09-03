import assert from 'node:assert/strict'
import test from 'node:test'
import type { ApiModelContext } from '../../lib/api-types.ts'
import { buildModelViewPresentation, prettyJson } from './model-context-view-state.ts'
import { CONTEXT_CATEGORY_COLORS } from '../../components/workbench/context-budget-meter-state.ts'

const DOC: ApiModelContext = {
  model: 'gpt-5.6-sol',
  provider: 'openai',
  generated_at: '2026-09-03T10:00:00.000Z',
  turn_active: false,
  compaction: { checkpoint_id: 'chk-1', compacted_through_message_id: 'm-0' },
  system_prompt: { scope: 'default', version: 'sha256:1a2b3c4d5e6f7a8b' },
  tools: [{ name: 'terminal_send', description: 'Send', parameters: {} }],
  tool_schema_tokens: 1_600,
  estimated_input_tokens: 12_000,
  context_budget: null,
  messages: [
    { index: 0, role: 'system', source: { kind: 'system_prompt', scope: 'default', version: 'sha256:1a2b3c4d5e6f7a8b' }, content: [{ type: 'text', text: 'You are Bud.' }], estimated_tokens: 8_000 },
    { index: 1, role: 'system', source: { kind: 'runtime_instruction' }, content: [{ type: 'text', text: 'Offline.' }], estimated_tokens: 20 },
    { index: 2, role: 'user', source: { kind: 'checkpoint_summary', checkpoint_id: 'chk-1' }, content: [{ type: 'text', text: 'Summary.' }], estimated_tokens: 300 },
    { index: 3, role: 'user', source: { kind: 'message', message_id: 'm-1', client_id: 'c-1', role: 'user' }, content: [{ type: 'text', text: 'ls please' }], estimated_tokens: 10 },
    {
      index: 4,
      role: 'assistant',
      source: { kind: 'ledger', llm_call_id: 'llm-1' },
      content: [
        { type: 'reasoning', text: 'Plan.' },
        { type: 'text', text: 'Running.', assistant_phase: 'commentary' },
        { type: 'tool_use', id: 'call-1', name: 'terminal_send', input: { text: 'ls' } },
      ],
      estimated_tokens: 40,
    },
    { index: 5, role: 'user', source: { kind: 'repair' }, content: [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'a\nb' }], is_error: true }], estimated_tokens: 30 },
  ],
}

test('buildModelViewPresentation labels blocks by provenance and role', () => {
  const presentation = buildModelViewPresentation(DOC, { modelLabel: 'GPT-5.6 Sol' })
  assert.match(presentation.headline, /^GPT-5\.6 Sol · as of /)
  assert.equal(presentation.subline, '6 messages · 12k tokens')
  assert.ok(presentation.compactionBanner)
  assert.equal(presentation.tools.label, 'Tools · 1 · 1.6k tokens')
  assert.equal(presentation.toolsAfterIndex, 0)
  assert.deepEqual(
    presentation.blocks.map((block) => [block.label, block.badge]),
    [
      ['System prompt', 'default · v1a2b3c4d5e6f7a8b'],
      ['Runtime instruction', 'not stored'],
      ['Compaction summary', 'from checkpoint'],
      ['User', null],
      ['Bud', 'provider replay'],
      ['Tool result', 'synthesized'],
    ],
  )
  assert.equal(presentation.blocks[2]!.isCompactionSummary, true)
})

test('buildModelViewPresentation colors parts by category and flattens nested tool results', () => {
  const { blocks } = buildModelViewPresentation(DOC)
  assert.equal(blocks[0]!.color, CONTEXT_CATEGORY_COLORS.system_prompt)
  assert.equal(blocks[3]!.color, CONTEXT_CATEGORY_COLORS.messages)
  const assistant = blocks[4]!
  assert.deepEqual(assistant.parts.map((part) => part.kind), ['reasoning', 'text', 'tool_use'])
  assert.equal(assistant.color, CONTEXT_CATEGORY_COLORS.reasoning)
  const toolUse = assistant.parts[2]
  assert.ok(toolUse && toolUse.kind === 'tool_use')
  assert.equal(toolUse.args, '{\n  "text": "ls"\n}')
  const text = assistant.parts[1]
  assert.ok(text && text.kind === 'text')
  assert.equal(text.label, 'commentary')
  const result = blocks[5]!.parts[0]
  assert.ok(result && result.kind === 'tool_result')
  assert.equal(result.text, 'a\nb')
  assert.equal(result.json, null)
  assert.equal(result.isError, true)
  assert.equal(result.color, CONTEXT_CATEGORY_COLORS.tool_output)
})

test('buildModelViewPresentation reports an active turn and a budget when available', () => {
  const presentation = buildModelViewPresentation({
    ...DOC,
    turn_active: true,
    compaction: null,
    context_budget: {
      status: 'available',
      model: 'gpt-5.6-sol',
      provider: 'openai',
      context_window_tokens: 1_050_000,
      usable_context_window_tokens: 272_000,
      reserved_output_tokens: 128_000,
      usable_input_window_tokens: 272_000,
      compaction_enabled: true,
      compaction_threshold_ratio: 0.9,
      compaction_threshold_tokens: 244_800,
      effective_budget_tokens: 244_800,
      message_estimated_tokens: 10_400,
      tool_schema_tokens: 1_600,
      estimated_input_tokens: 12_000,
      remaining_context_tokens: 232_800,
      percent_of_context_budget: 0.05,
      percent_of_model_window: 0.01,
      basis: 'model_agnostic_estimate',
      confidence: 'medium',
      source: 'durable_reconstruction',
      phase: 'idle',
      reason: null,
      turn_id: null,
      checked_at: null,
      stale: false,
      updated_at: '2026-09-03T10:00:00.000Z',
      latest_checkpoint_id: null,
      compacted_through_message_id: null,
      compacted_through_llm_call_id: null,
    },
  })
  assert.match(presentation.headline, /refreshing when the turn ends$/)
  assert.equal(
    buildModelViewPresentation({ ...DOC, messages: DOC.messages.slice(3) }).toolsAfterIndex,
    null,
    'no system prompt block → tools render first',
  )
  assert.equal(presentation.subline, '6 messages · 12k of 245k tokens')
  assert.equal(presentation.compactionBanner, null)
})

test('prettyJson formats JSON objects and arrays and leaves everything else alone', () => {
  assert.equal(prettyJson('{"ok":true,"lines":[1,2]}'), '{\n  "ok": true,\n  "lines": [\n    1,\n    2\n  ]\n}')
  assert.equal(prettyJson('  [1, 2]  '), '[\n  1,\n  2\n]')
  assert.equal(prettyJson('42'), null)
  assert.equal(prettyJson('"just a string"'), null)
  assert.equal(prettyJson('{not json'), null)
  assert.equal(prettyJson('make: nothing to be done'), null)
})
