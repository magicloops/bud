import type { MessageContentRenderer } from '../types'
import { AssistantContent } from './assistant'
import { UserContent } from './user'

/**
 * Registry mapping message roles to their content renderers.
 *
 * To add a new role renderer:
 * 1. Create a component file in this directory (e.g., `system.tsx`)
 * 2. Import and add it to this registry
 */
export const roleContentRenderers: Record<string, MessageContentRenderer> = {
  assistant: AssistantContent,
  user: UserContent,
}
