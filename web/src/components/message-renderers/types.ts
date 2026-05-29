import type { ComponentType } from 'react'
import type { FilePathCandidate, OpenFileSource } from '@/lib/file-paths'

/**
 * Props passed to tool content renderers.
 * The payload is the parsed tool result from message.metadata or message.content.
 */
export type ToolContentRendererProps = {
  payload: Record<string, unknown>
}

/**
 * A React component that renders tool-specific content.
 */
export type ToolContentRenderer = ComponentType<ToolContentRendererProps>

export type MessageFileActionContext = {
  source: OpenFileSource
  onOpenFileCandidate: (candidate: FilePathCandidate) => void
}

/**
 * Props passed to message content renderers (for roles like user, assistant).
 * These render the full message content, not just tool-specific summaries.
 */
export type MessageContentRendererProps = {
  content: string
  fileActions?: MessageFileActionContext
  isStreaming?: boolean
}

/**
 * A React component that renders message content for a specific role.
 */
export type MessageContentRenderer = ComponentType<MessageContentRendererProps>
