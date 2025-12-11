import type { ToolContentRenderer, MessageContentRenderer } from './types'
import { toolContentRenderers } from './tools'
import { roleContentRenderers } from './roles'

export type {
  ToolContentRendererProps,
  ToolContentRenderer,
  MessageContentRendererProps,
  MessageContentRenderer,
} from './types'

/**
 * Get the content renderer for a specific tool.
 * Returns null if no custom renderer exists for the tool.
 */
export function getToolContentRenderer(toolName: string): ToolContentRenderer | null {
  return toolContentRenderers[toolName] ?? null
}

/**
 * Get the content renderer for a specific message role.
 * Returns null if no custom renderer exists for the role.
 */
export function getRoleContentRenderer(role: string): MessageContentRenderer | null {
  return roleContentRenderers[role] ?? null
}
