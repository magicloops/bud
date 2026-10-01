import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveToolPayload } from './tool-payload.ts'
import { parseAskUserQuestionsToolResultPayload, displayAskUserQuestionsResponse } from '../message-renderers/tools/ask-user-questions-format.ts'

test('compact wire payload is used directly without parsing display content', () => {
  const payload = { tool: 'terminal.send', output: 'exact output', duration_ms: 42 }
  assert.deepEqual(resolveToolPayload({ content: '{not JSON', tool_payload: payload,
    metadata: { duration_ms: 300, duration_source: 'service_wall_clock' } }),
    { ...payload, duration_source: 'service_wall_clock' })
})

test('answered continuation resolves its actual question and answer despite timing-only metadata', () => {
  const payload = resolveToolPayload({
    metadata: { continuation: true, call_id: 'call_fixture', duration_ms: 3594 },
    content: 'Questions answered',
    tool_payload: { tool: 'ask_user_questions', call_id: 'call_fixture', kind: 'user_questions',
      result: { schema: 'ask_user_questions_tool_result_v1', request_id: 'qr_fixture',
        responses: [{ question_id: 'lookup', question: { label: 'Which lookup?' }, status: 'answered',
          answer: { kind: 'single_choice', choice_id: 'public_web' }, display_answer: 'Search the public web' }] } },
  })
  assert.equal(payload?.tool, 'ask_user_questions')
  assert.equal(payload?.duration_ms, 3594)
  const result = parseAskUserQuestionsToolResultPayload(payload!)
  assert.equal(result?.responses[0].question.label, 'Which lookup?')
  assert.equal(displayAskUserQuestionsResponse(result!.responses[0]), 'Search the public web')
})

test('pending rows use structured payload and canonical payload wins over stale metadata', () => {
  const pending = { tool: 'ask_user_questions', request_id: 'qr_fixture', questions: [] }
  assert.deepEqual(resolveToolPayload({ metadata: { pending: true }, tool_payload: pending, content: 'Waiting for answers' }),
    { pending: true, ...pending })
  const metadata = { tool: 'old', summary: 'Old summary', duration_ms: 10 }
  const tool_payload = { tool: 'terminal.send', summary: 'Completed' }
  assert.deepEqual(resolveToolPayload({ metadata, tool_payload, content: 'Completed' }),
    { ...metadata, ...tool_payload })
  assert.equal(metadata.summary, 'Old summary')
})

test('null and absent payloads do not resurrect content or metadata tools', () => {
  for (const content of ['plain text', '{broken', 'null', '[]', '{"tool":"web_search"}']) {
    for (const tool_payload of [undefined, null]) {
      assert.equal(resolveToolPayload({ content, tool_payload, metadata: { tool: 'web_search', pending: true } }), null)
    }
  }
})
