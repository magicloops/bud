import type { ToolContentRenderer } from './types'
import { toolContentRenderers } from './tools'

export type { ToolContentRendererProps, ToolContentRenderer } from './types'

/**
 * Get the content renderer for a specific tool.
 * Returns null if no custom renderer exists for the tool.
 */
export function getToolContentRenderer(toolName: string): ToolContentRenderer | null {
  return toolContentRenderers[toolName] ?? null
}
