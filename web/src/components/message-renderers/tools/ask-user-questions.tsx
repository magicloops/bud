import type { ToolContentRendererProps } from '../types'
import type { ApiAskUserQuestionsToolResult } from '@/lib/api-types'

export function AskUserQuestionsContent({ payload }: ToolContentRendererProps) {
  const result = parseResult(payload)
  if (!result) {
    return (
      <pre className="overflow-x-auto rounded-md bg-background/80 p-2 text-[11px] text-muted-foreground">
        <code>{JSON.stringify(payload, null, 2)}</code>
      </pre>
    )
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-[12px]">
      {(result.title || result.body) && (
        <div className="space-y-1">
          {result.title && <div className="font-semibold text-foreground">{result.title}</div>}
          {result.body && <div className="text-muted-foreground">{result.body}</div>}
        </div>
      )}
      <div className="space-y-2">
        {result.responses.map((response) => (
          <div key={response.question_id} className="rounded-md bg-background/70 px-2 py-1.5">
            <div className="font-medium text-foreground">{response.question.label}</div>
            {response.status === 'answered' ? (
              <div className="mt-0.5 text-muted-foreground">
                {response.display_answer ?? formatAnswer(response.answer)}
              </div>
            ) : (
              <div className="mt-0.5 text-muted-foreground">
                Skipped{response.skip_reason ? ` (${response.skip_reason})` : ''}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function parseResult(payload: Record<string, unknown>): ApiAskUserQuestionsToolResult | null {
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

function formatAnswer(answer: unknown): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
