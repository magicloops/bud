import type { MessageContentRendererProps } from '../types'
import { MarkdownContent } from './markdown-content'

export function ReasoningContent(props: MessageContentRendererProps) {
  return (
    <div className="text-muted-foreground">
      <MarkdownContent {...props} />
    </div>
  )
}
