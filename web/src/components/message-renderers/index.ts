import { SourceUnavailableContent } from './tools/source-request'
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
export function getToolContentRenderer(toolName: string, payload?: Record<string, unknown> | null): ToolContentRenderer | null {
  // A personal-data read refused for a setting offers a way to turn the source on.
  return toolContentRenderers[toolName] ?? (typeof payload?.unavailable_source === 'string' ? SourceUnavailableContent : null)
}

/**
 * Get the content renderer for a specific message role.
 * Returns null if no custom renderer exists for the role.
 */
export function getRoleContentRenderer(role: string): MessageContentRenderer | null {
  return roleContentRenderers[role] ?? null
}
