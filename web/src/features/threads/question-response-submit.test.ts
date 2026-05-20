import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  ApiAskUserQuestionsRequest,
  ApiAskUserQuestionsResponseInput,
} from '../../lib/api-types.ts'
import {
  submitQuestionResponseFlow,
  type QuestionResponseContinuation,
} from './question-response-submit.ts'

const REQUEST: ApiAskUserQuestionsRequest = {
  schema: 'ask_user_questions_request_v1',
  request_id: 'qr_test',
  questions: [
    {
      question_id: 'env',
      kind: 'single_choice',
      label: 'Environment?',
      choices: [{ choice_id: 'staging', label: 'Staging' }],
    },
  ],
}

const RESPONSE: ApiAskUserQuestionsResponseInput = {
  schema: 'ask_user_questions_response_v1',
  client_response_id: '018f4f2a-0000-7000-9000-000000000000',
  answers: [
    {
      question_id: 'env',
      status: 'answered',
      answer: { kind: 'single_choice', choice_id: 'staging' },
    },
  ],
}

test('submitQuestionResponseFlow keeps live continuations on the stream path', async () => {
  const calls: string[] = []

  const result = await submitQuestionResponseFlow({
    threadId: 'thread-1',
    request: REQUEST,
    response: RESPONSE,
    transport: createTransport('live_tool_result', calls),
  })

  assert.deepEqual(result, {
    status: 'submitted',
    continuation: 'live_tool_result',
  })
  assert.deepEqual(calls, ['submit:thread-1:qr_test', 'ensure-stream'])
})

test('submitQuestionResponseFlow refreshes bootstrap for fallback and already-answered continuations', async () => {
  for (const continuation of ['fallback_user_message', 'already_answered'] as const) {
    const calls: string[] = []

    const result = await submitQuestionResponseFlow({
      threadId: 'thread-1',
      request: REQUEST,
      response: RESPONSE,
      transport: createTransport(continuation, calls),
    })

    assert.deepEqual(result, {
      status: 'submitted',
      continuation,
    })
    assert.deepEqual(calls, ['submit:thread-1:qr_test', 'refresh:thread-1'])
  }
})

test('submitQuestionResponseFlow reports errors and auth aborts without reconciling', async () => {
  const errorCalls: string[] = []
  const errorResult = await submitQuestionResponseFlow({
    threadId: 'thread-1',
    request: REQUEST,
    response: RESPONSE,
    transport: {
      async submitResponse() {
        errorCalls.push('submit')
        throw new Error('question_request_already_answered')
      },
      async refreshBootstrap() {
        errorCalls.push('refresh')
      },
      ensureAgentStreamConnected() {
        errorCalls.push('ensure-stream')
      },
    },
  })

  assert.deepEqual(errorResult, {
    status: 'error',
    message: 'question_request_already_answered',
  })
  assert.deepEqual(errorCalls, ['submit'])

  const authAbort = await submitQuestionResponseFlow({
    threadId: 'thread-1',
    request: REQUEST,
    response: RESPONSE,
    transport: {
      async submitResponse() {
        throw new Error('unauthorized')
      },
      async refreshBootstrap() {
        assert.fail('refresh should not run after auth redirect')
      },
      ensureAgentStreamConnected() {
        assert.fail('stream should not reconnect after auth redirect')
      },
      isAuthRedirectPending: () => true,
    },
  })

  assert.deepEqual(authAbort, { status: 'aborted' })
})

test('submitQuestionResponseFlow returns a stable error without a selected thread', async () => {
  const result = await submitQuestionResponseFlow({
    threadId: null,
    request: REQUEST,
    response: RESPONSE,
    transport: createTransport('live_tool_result', []),
  })

  assert.deepEqual(result, {
    status: 'error',
    message: 'No thread selected',
  })
})

function createTransport(continuation: QuestionResponseContinuation, calls: string[]) {
  return {
    async submitResponse(
      threadId: string,
      requestId: string,
      _response: ApiAskUserQuestionsResponseInput,
    ) {
      calls.push(`submit:${threadId}:${requestId}`)
      return { continuation }
    },
    async refreshBootstrap(threadId: string) {
      calls.push(`refresh:${threadId}`)
    },
    ensureAgentStreamConnected() {
      calls.push('ensure-stream')
    },
  }
}
