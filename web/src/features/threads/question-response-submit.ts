import type {
  ApiAskUserQuestionsRequest,
  ApiAskUserQuestionsResponseInput,
} from '../../lib/api-types.ts'

export type QuestionResponseContinuation =
  | 'live_tool_result'
  | 'fallback_user_message'
  | 'already_answered'

export type SubmitQuestionResponseResult =
  | { status: 'submitted'; continuation: QuestionResponseContinuation }
  | { status: 'aborted' }
  | { status: 'error'; message: string }

export type SubmitQuestionResponseTransport = {
  submitResponse: (
    threadId: string,
    requestId: string,
    response: ApiAskUserQuestionsResponseInput,
  ) => Promise<{ continuation: QuestionResponseContinuation } | null>
  refreshBootstrap: (threadId: string) => Promise<unknown>
  ensureAgentStreamConnected: () => void
  isAuthRedirectPending?: () => boolean
}

export async function submitQuestionResponseFlow(args: {
  threadId: string | null
  request: ApiAskUserQuestionsRequest
  response: ApiAskUserQuestionsResponseInput
  transport: SubmitQuestionResponseTransport
}): Promise<SubmitQuestionResponseResult> {
  if (!args.threadId) {
    return { status: 'error', message: 'No thread selected' }
  }

  try {
    const result = await args.transport.submitResponse(
      args.threadId,
      args.request.request_id,
      args.response,
    )
    if (!result) {
      return { status: 'aborted' }
    }

    if (
      result.continuation === 'fallback_user_message' ||
      result.continuation === 'already_answered'
    ) {
      await args.transport.refreshBootstrap(args.threadId)
    } else {
      args.transport.ensureAgentStreamConnected()
    }

    return {
      status: 'submitted',
      continuation: result.continuation,
    }
  } catch (error) {
    if (args.transport.isAuthRedirectPending?.()) {
      return { status: 'aborted' }
    }
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Failed to submit answers',
    }
  }
}
