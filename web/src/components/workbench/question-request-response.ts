import type {
  ApiAskUserQuestion,
  ApiAskUserQuestionAnswer,
  ApiAskUserQuestionsRequest,
  ApiAskUserQuestionsResponseInput,
} from '../../lib/api-types.ts'
import { generateMessageClientId } from '../../lib/messages.ts'

export type QuestionRequestAnswerState =
  | { status: 'skipped'; answer?: undefined }
  | { status: 'answered'; answer: ApiAskUserQuestionAnswer }

export function initialAnswerForQuestion(question: ApiAskUserQuestion): QuestionRequestAnswerState {
  if (question.default_answer && question.default_answer.kind === question.kind) {
    return { status: 'answered', answer: question.default_answer }
  }
  return { status: 'skipped' }
}

export function buildInitialQuestionAnswers(
  request: ApiAskUserQuestionsRequest,
): Record<string, QuestionRequestAnswerState> {
  return Object.fromEntries(
    request.questions.map((question) => [
      question.question_id,
      initialAnswerForQuestion(question),
    ]),
  )
}

export function buildSkippedQuestionAnswers(
  request: ApiAskUserQuestionsRequest,
): Record<string, QuestionRequestAnswerState> {
  return Object.fromEntries(
    request.questions.map((question) => [
      question.question_id,
      { status: 'skipped' as const },
    ]),
  )
}

export function buildAskUserQuestionsResponseInput(
  request: ApiAskUserQuestionsRequest,
  answers: Record<string, QuestionRequestAnswerState>,
  clientResponseId = generateMessageClientId(),
): ApiAskUserQuestionsResponseInput {
  return {
    schema: 'ask_user_questions_response_v1',
    client_response_id: clientResponseId,
    answers: request.questions.map((question) => {
      const local = answers[question.question_id] ?? { status: 'skipped' as const }
      if (local.status === 'answered') {
        return {
          question_id: question.question_id,
          status: 'answered',
          answer: local.answer,
        }
      }
      return {
        question_id: question.question_id,
        status: 'skipped',
        skip_reason: 'user_skipped',
      }
    }),
  }
}
