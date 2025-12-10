import type { ComponentType } from 'react'

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
