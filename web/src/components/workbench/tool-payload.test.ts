import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveToolPayload } from './tool-payload.ts'
import { parseAskUserQuestionsToolResultPayload, displayAskUserQuestionsResponse } from '../message-renderers/tools/ask-user-questions-format.ts'

test('answered continuation resolves its actual question and answer despite timing-only metadata', () => {
  const payload = resolveToolPayload({
    metadata: { continuation: true, call_id: 'call_fixture', duration_ms: 3594 },
    content: JSON.stringify({ tool: 'ask_user_questions', call_id: 'call_fixture', kind: 'user_questions',
      result: { schema: 'ask_user_questions_tool_result_v1', request_id: 'qr_fixture',
        responses: [{ question_id: 'lookup', question: { label: 'Which lookup?' }, status: 'answered',
          answer: { kind: 'single_choice', choice_id: 'public_web' }, display_answer: 'Search the public web' }] } }),
  })
  assert.equal(payload?.tool, 'ask_user_questions')
  assert.equal(payload?.duration_ms, 3594)
  const result = parseAskUserQuestionsToolResultPayload(payload!)
  assert.equal(result?.responses[0].question.label, 'Which lookup?')
  assert.equal(displayAskUserQuestionsResponse(result!.responses[0]), 'Search the public web')
})

test('pending forms use metadata and completed content wins over stale payload metadata', () => {
  const pending = { pending: true, tool: 'ask_user_questions', request_id: 'qr_fixture', questions: [] }
  assert.deepEqual(resolveToolPayload({ metadata: pending, content: 'Waiting for answers' }), pending)
  const metadata = { tool: 'terminal.send', summary: 'Old summary', duration_ms: 10 }
  assert.deepEqual(resolveToolPayload({ metadata, content: '{"tool":"terminal.send","summary":"Completed"}' }),
    { ...metadata, summary: 'Completed' })
  assert.equal(metadata.summary, 'Old summary')
})

test('legacy metadata fallback and malformed/non-object content remain safe', () => {
  const metadata = { tool: 'terminal.wait', outcome: 'settled' }
  for (const content of ['plain text', 'null', '[]', '1', '"text"']) {
    assert.deepEqual(resolveToolPayload({ metadata, content }), metadata)
    assert.equal(resolveToolPayload({ content }), null)
  }
  assert.deepEqual(resolveToolPayload({ content: '{"tool":"web_search"}' }), { tool: 'web_search' })
})
