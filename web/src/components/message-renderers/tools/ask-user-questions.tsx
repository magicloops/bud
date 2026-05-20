import type { ToolContentRendererProps } from '../types'
import {
  displayAskUserQuestionsResponse,
  parseAskUserQuestionsToolResultPayload,
} from './ask-user-questions-format'

export function AskUserQuestionsContent({ payload }: ToolContentRendererProps) {
  const result = parseAskUserQuestionsToolResultPayload(payload)
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
            <div className="mt-0.5 text-muted-foreground">
              {displayAskUserQuestionsResponse(response)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
