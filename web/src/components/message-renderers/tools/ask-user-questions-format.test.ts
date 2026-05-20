import test from 'node:test'
import assert from 'node:assert/strict'
import {
  displayAskUserQuestionsResponse,
  formatAskUserQuestionsAnswer,
  parseAskUserQuestionsToolResultPayload,
} from './ask-user-questions-format.ts'

const RESULT = {
  schema: 'ask_user_questions_tool_result_v1',
  request_id: 'qr_test',
  title: 'Deploy',
  responses: [
    {
      question_id: 'env',
      question: {
        question_id: 'env',
        kind: 'single_choice',
        label: 'Environment?',
      },
      status: 'answered',
      answer: { kind: 'single_choice', choice_id: 'staging' },
      display_answer: 'Staging',
    },
    {
      question_id: 'notes',
      question: {
        question_id: 'notes',
        kind: 'text',
        label: 'Notes',
      },
      status: 'skipped',
      skip_reason: 'user_skipped',
    },
  ],
  summary_markdown: 'Question response: Deploy',
}

test('parseAskUserQuestionsToolResultPayload accepts direct and nested result payloads', () => {
  assert.equal(parseAskUserQuestionsToolResultPayload(RESULT)?.request_id, 'qr_test')
  assert.equal(parseAskUserQuestionsToolResultPayload({ result: RESULT })?.title, 'Deploy')
})

test('parseAskUserQuestionsToolResultPayload rejects malformed payloads', () => {
  assert.equal(parseAskUserQuestionsToolResultPayload({}), null)
  assert.equal(
    parseAskUserQuestionsToolResultPayload({
      schema: 'ask_user_questions_tool_result_v1',
      request_id: 'qr_test',
      responses: 'not-array',
    }),
    null,
  )
})

test('displayAskUserQuestionsResponse formats answered and skipped rows', () => {
  assert.equal(displayAskUserQuestionsResponse(RESULT.responses[0]), 'Staging')
  assert.equal(displayAskUserQuestionsResponse(RESULT.responses[1]), 'Skipped (user_skipped)')
  assert.equal(
    displayAskUserQuestionsResponse({
      status: 'answered',
      answer: { kind: 'boolean', value: true },
    }),
    'Yes',
  )
})

test('formatAskUserQuestionsAnswer covers fallback answer formatting', () => {
  assert.equal(formatAskUserQuestionsAnswer({ kind: 'boolean', value: false }), 'No')
  assert.equal(formatAskUserQuestionsAnswer({ kind: 'single_choice', choice_id: 'prod' }), 'prod')
  assert.equal(formatAskUserQuestionsAnswer({ kind: 'multi_choice', choice_ids: ['unit', 'e2e'] }), 'unit, e2e')
  assert.equal(formatAskUserQuestionsAnswer({ kind: 'text', value: 'ship it' }), 'ship it')
  assert.equal(formatAskUserQuestionsAnswer({ kind: 'number', value: 3 }), '3')
  assert.equal(formatAskUserQuestionsAnswer({ kind: 'unknown' }), '(answered)')
})
