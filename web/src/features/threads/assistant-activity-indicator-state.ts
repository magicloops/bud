import type { ApiAgentState, ApiMessage, ApiOutputActivity } from '../../lib/api-types'

export type AssistantActivityStatus = 'idle' | 'dispatching' | 'streaming' | 'waiting_for_user' | 'waiting_for_terminal'
export type AssistantActivityGateState = {
  suppressIndicator: boolean
  activeTurnId: string | null
  llmCallId: string | null
  final: boolean
}
export type AssistantActivityGateEvent =
  | { type: 'output_activity'; turnId: string; llmCallId: string; state: ApiOutputActivity['state'] | null }
  | { type: 'assistant_message_persisted'; turnId: string; message?: Pick<ApiMessage, 'role' | 'metadata'> | null }
  | { type: 'final'; turnId?: string }

export const createIdleAssistantActivityGate = (): AssistantActivityGateState => ({
  suppressIndicator: false, activeTurnId: null, llmCallId: null, final: false,
})
export const createAssistantActivityGateFromAgentState = (
  snapshot: Pick<ApiAgentState, 'active' | 'turn_id' | 'output_activity'>,
): AssistantActivityGateState => ({
  suppressIndicator: snapshot.active && (snapshot.output_activity?.state === 'text' || snapshot.output_activity?.state === 'awaiting_completion'),
  activeTurnId: snapshot.active ? snapshot.turn_id : null,
  llmCallId: snapshot.active ? snapshot.output_activity?.llm_call_id ?? null : null,
  final: false,
})
export function reduceAssistantActivityGate(state: AssistantActivityGateState, event: AssistantActivityGateEvent): AssistantActivityGateState {
  switch (event.type) {
    case 'output_activity':
      if (state.final && state.activeTurnId === event.turnId) return state
      if (event.state === null && (state.activeTurnId !== event.turnId || state.llmCallId !== event.llmCallId)) return state
      // New model calls begin with working; a late text/clear cannot begin one.
      if (event.state !== 'working' && event.state !== null && state.llmCallId !== event.llmCallId) return state
      return {
        suppressIndicator: event.state === 'text' || event.state === 'awaiting_completion',
        activeTurnId: event.turnId, llmCallId: event.state === null ? null : event.llmCallId, final: false,
      }
    case 'assistant_message_persisted':
      if (state.activeTurnId !== event.turnId || !isFinalAssistantMessage(event.message)) return state
      return { ...state, suppressIndicator: true, final: true }
    case 'final':
      if (!event.turnId) return createIdleAssistantActivityGate()
      if (state.activeTurnId && state.activeTurnId !== event.turnId) return state
      return { suppressIndicator: true, activeTurnId: event.turnId, llmCallId: null, final: true }
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
  status: AssistantActivityStatus; activeCompaction: boolean; gate: AssistantActivityGateState
}): boolean {
  return args.activeCompaction || ((args.status === 'streaming' || args.status === 'dispatching') && !args.gate.suppressIndicator)
}
