import type {
  ApiAskUserQuestionAnswer,
  ApiAskUserQuestionsToolResult,
} from '../../../lib/api-types.ts'

export function parseAskUserQuestionsToolResultPayload(
  payload: Record<string, unknown>,
): ApiAskUserQuestionsToolResult | null {
  const candidate = isRecord(payload.result) ? payload.result : payload
  if (
    candidate.schema !== 'ask_user_questions_tool_result_v1' ||
    typeof candidate.request_id !== 'string' ||
    !Array.isArray(candidate.responses)
  ) {
    return null
  }
  return candidate as ApiAskUserQuestionsToolResult
}

export function formatAskUserQuestionsAnswer(answer: unknown): string {
  if (!isRecord(answer) || typeof answer.kind !== 'string') {
    return '(answered)'
  }
  switch (answer.kind) {
    case 'boolean':
      return answer.value === true ? 'Yes' : answer.value === false ? 'No' : '(answered)'
    case 'single_choice':
      return typeof answer.choice_id === 'string' ? answer.choice_id : '(answered)'
    case 'multi_choice':
      return Array.isArray(answer.choice_ids) ? answer.choice_ids.join(', ') : '(answered)'
    case 'text':
      return typeof answer.value === 'string' ? answer.value : '(answered)'
    case 'number':
      return typeof answer.value === 'number' ? String(answer.value) : '(answered)'
    default:
      return '(answered)'
  }
}

export function displayAskUserQuestionsResponse(response: {
  status: 'answered' | 'skipped'
  answer?: ApiAskUserQuestionAnswer
  display_answer?: string
  skip_reason?: string
}): string {
  if (response.status === 'answered') {
    return response.display_answer ?? formatAskUserQuestionsAnswer(response.answer)
  }
  return `Skipped${response.skip_reason ? ` (${response.skip_reason})` : ''}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
