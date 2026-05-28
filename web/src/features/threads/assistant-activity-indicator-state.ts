import type { ApiAgentState, ApiMessage } from '../../lib/api-types'

export const ASSISTANT_ACTIVITY_INDICATOR_RETURN_DELAY_MS = 250

export type AssistantActivityStatus = 'idle' | 'dispatching' | 'streaming' | 'waiting_for_user'

export type AssistantActivityGateState = {
  suppressIndicator: boolean
  activeTurnId: string | null
  pendingUnsuppressTurnId: string | null
}

export type AssistantActivityGateEvent =
  | {
      type: 'bootstrap'
      agentState: Pick<ApiAgentState, 'active' | 'turn_id' | 'draft_assistant'>
    }
  | {
      type: 'assistant_message_start' | 'assistant_message_delta' | 'assistant_message_done'
      turnId: string
    }
  | {
      type: 'assistant_message_persisted'
      turnId: string
      message?: Pick<ApiMessage, 'role' | 'metadata'> | null
    }
  | {
      type: 'message_done_timer'
      turnId: string
    }
  | {
      type: 'final'
    }

export const createIdleAssistantActivityGate = (): AssistantActivityGateState => ({
  suppressIndicator: false,
  activeTurnId: null,
  pendingUnsuppressTurnId: null,
})

export const createAssistantActivityGateFromAgentState = (
  agentState: Pick<ApiAgentState, 'active' | 'turn_id' | 'draft_assistant'>,
): AssistantActivityGateState => {
  const hasDraftAssistant = Boolean(agentState.active && agentState.draft_assistant)
  return {
    suppressIndicator: hasDraftAssistant,
    activeTurnId: hasDraftAssistant ? agentState.turn_id : null,
    pendingUnsuppressTurnId: null,
  }
}

export function reduceAssistantActivityGate(
  state: AssistantActivityGateState,
  event: AssistantActivityGateEvent,
): AssistantActivityGateState {
  switch (event.type) {
    case 'bootstrap':
      return createAssistantActivityGateFromAgentState(event.agentState)
    case 'assistant_message_start':
    case 'assistant_message_delta':
      return {
        suppressIndicator: true,
        activeTurnId: event.turnId,
        pendingUnsuppressTurnId: null,
      }
    case 'assistant_message_done':
      return {
        suppressIndicator: true,
        activeTurnId: event.turnId,
        pendingUnsuppressTurnId: event.turnId,
      }
    case 'assistant_message_persisted':
      if (!isFinalAssistantMessage(event.message)) {
        return state
      }
      return {
        suppressIndicator: true,
        activeTurnId: event.turnId,
        pendingUnsuppressTurnId: null,
      }
    case 'message_done_timer':
      if (state.pendingUnsuppressTurnId !== event.turnId) {
        return state
      }
      return {
        suppressIndicator: false,
        activeTurnId: state.activeTurnId === event.turnId ? event.turnId : state.activeTurnId,
        pendingUnsuppressTurnId: null,
      }
    case 'final':
      return createIdleAssistantActivityGate()
  }
}

export function isFinalAssistantMessage(message?: Pick<ApiMessage, 'role' | 'metadata'> | null): boolean {
  if (!message || message.role !== 'assistant') {
    return false
  }

  return (
    message.metadata?.segment_kind === 'final' ||
    message.metadata?.assistant_phase === 'final_answer'
  )
}

export function deriveAssistantActivityIndicatorVisible(args: {
  status: AssistantActivityStatus
  activeCompaction: boolean
  gate: AssistantActivityGateState
}): boolean {
  return args.activeCompaction || (args.status === 'streaming' && !args.gate.suppressIndicator)
}
