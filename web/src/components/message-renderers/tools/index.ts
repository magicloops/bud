import { AppPermissionContent } from './app-permission'
import { WebRetrievalContent } from './web-retrieval'
import type { ToolContentRenderer } from '../types'
import {
  TerminalObserveContent,
  TerminalRunContent,
  TerminalSendContent,
  TerminalWaitContent,
} from './terminal-run'
import { AskUserQuestionsContent } from './ask-user-questions'
import { AutomationProposalContent } from './automation-proposal'

/**
 * Registry mapping tool names to their content renderers.
 *
 * To add a new tool renderer:
 * 1. Create a component file in this directory (e.g., `my-tool.tsx`)
 * 2. Import and add it to this registry
 */
export const toolContentRenderers: Record<string, ToolContentRenderer> = {
  web_search: WebRetrievalContent,
  web_read: WebRetrievalContent,
  'terminal.run': TerminalRunContent,
  'terminal.send': TerminalSendContent,
  'terminal.observe': TerminalObserveContent,
  'terminal.wait': TerminalWaitContent,
  data_request_api_key: AppPermissionContent,
  ask_user_questions: AskUserQuestionsContent,
  automations_request_activation: AutomationProposalContent,
  automations_request_existing_contacts: AutomationProposalContent,
}
