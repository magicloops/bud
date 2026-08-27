import type { ToolContentRenderer } from '../types'
import {
  TerminalObserveContent,
  TerminalRunContent,
  TerminalSendContent,
  TerminalWaitContent,
} from './terminal-run'
import { AskUserQuestionsContent } from './ask-user-questions'

/**
 * Registry mapping tool names to their content renderers.
 *
 * To add a new tool renderer:
 * 1. Create a component file in this directory (e.g., `my-tool.tsx`)
 * 2. Import and add it to this registry
 */
export const toolContentRenderers: Record<string, ToolContentRenderer> = {
  'terminal.run': TerminalRunContent,
  'terminal.send': TerminalSendContent,
  'terminal.observe': TerminalObserveContent,
  'terminal.wait': TerminalWaitContent,
  ask_user_questions: AskUserQuestionsContent,
}
