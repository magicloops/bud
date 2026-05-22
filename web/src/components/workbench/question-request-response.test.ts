import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiAskUserQuestionsRequest } from '../../lib/api-types.ts'
import {
  buildAskUserQuestionsResponseInput,
  buildInitialQuestionAnswers,
  buildSkippedQuestionAnswers,
  type QuestionRequestAnswerState,
} from './question-request-response.ts'

const REQUEST: ApiAskUserQuestionsRequest = {
  schema: 'ask_user_questions_request_v1',
  request_id: 'qr_test',
  title: 'Deploy',
  questions: [
    {
      question_id: 'confirm',
      kind: 'boolean',
      label: 'Deploy now?',
      skippable: true,
    },
    {
      question_id: 'env',
      kind: 'single_choice',
      label: 'Environment?',
      skippable: true,
      choices: [
        { choice_id: 'staging', label: 'Staging' },
        { choice_id: 'production', label: 'Production' },
      ],
    },
    {
      question_id: 'checks',
      kind: 'multi_choice',
      label: 'Checks?',
      skippable: true,
      choices: [
        { choice_id: 'unit', label: 'Unit' },
        { choice_id: 'e2e', label: 'E2E' },
      ],
    },
    {
      question_id: 'notes',
      kind: 'text',
      label: 'Notes',
      skippable: true,
    },
    {
      question_id: 'retries',
      kind: 'number',
      label: 'Retries',
      skippable: true,
      unit: 'times',
    },
  ],
}

test('buildAskUserQuestionsResponseInput serializes every v1 answer kind', () => {
  const answers: Record<string, QuestionRequestAnswerState> = {
    confirm: { status: 'answered', answer: { kind: 'boolean', value: true } },
    env: { status: 'answered', answer: { kind: 'single_choice', choice_id: 'staging' } },
    checks: { status: 'answered', answer: { kind: 'multi_choice', choice_ids: ['unit', 'e2e'] } },
    notes: { status: 'answered', answer: { kind: 'text', value: 'Ship it' } },
    retries: { status: 'answered', answer: { kind: 'number', value: 2 } },
  }

  assert.deepEqual(
    buildAskUserQuestionsResponseInput(REQUEST, answers, '018f4f2a-0000-7000-9000-000000000000'),
    {
      schema: 'ask_user_questions_response_v1',
      client_response_id: '018f4f2a-0000-7000-9000-000000000000',
      answers: [
        {
          question_id: 'confirm',
          status: 'answered',
          answer: { kind: 'boolean', value: true },
        },
        {
          question_id: 'env',
          status: 'answered',
          answer: { kind: 'single_choice', choice_id: 'staging' },
        },
        {
          question_id: 'checks',
          status: 'answered',
          answer: { kind: 'multi_choice', choice_ids: ['unit', 'e2e'] },
        },
        {
          question_id: 'notes',
          status: 'answered',
          answer: { kind: 'text', value: 'Ship it' },
        },
        {
          question_id: 'retries',
          status: 'answered',
          answer: { kind: 'number', value: 2 },
        },
      ],
    },
  )
})

test('buildAskUserQuestionsResponseInput serializes per-question and skip-all answers', () => {
  const perQuestionSkip = buildAskUserQuestionsResponseInput(
    REQUEST,
    {
      confirm: { status: 'answered', answer: { kind: 'boolean', value: false } },
      env: { status: 'skipped' },
    },
    '018f4f2a-0000-7000-9000-000000000001',
  )

  assert.equal(perQuestionSkip.answers[0]?.status, 'answered')
  assert.equal(perQuestionSkip.answers[1]?.status, 'skipped')
  assert.equal(perQuestionSkip.answers[1]?.skip_reason, 'user_skipped')
  assert.equal(perQuestionSkip.answers[2]?.status, 'skipped')

  const skipped = buildAskUserQuestionsResponseInput(
    REQUEST,
    buildSkippedQuestionAnswers(REQUEST),
    '018f4f2a-0000-7000-9000-000000000002',
  )

  assert.equal(skipped.answers.length, REQUEST.questions.length)
  assert.equal(skipped.answers.every((answer) => answer.status === 'skipped'), true)
  assert.equal(skipped.answers.every((answer) => answer.skip_reason === 'user_skipped'), true)
})

test('buildInitialQuestionAnswers uses matching default answers only', () => {
  const initial = buildInitialQuestionAnswers({
    ...REQUEST,
    questions: [
      {
        question_id: 'confirm',
        kind: 'boolean',
        label: 'Deploy now?',
        skippable: true,
        default_answer: { kind: 'boolean', value: true },
      },
      {
        question_id: 'notes',
        kind: 'text',
        label: 'Notes',
        skippable: true,
        default_answer: { kind: 'number', value: 2 },
      },
    ],
  })

  assert.deepEqual(initial.confirm, {
    status: 'answered',
    answer: { kind: 'boolean', value: true },
  })
  assert.deepEqual(initial.notes, { status: 'skipped' })
})
