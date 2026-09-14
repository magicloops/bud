import { invocationAllowsLiveActivity, invocationSummary } from './invocation-state.ts'
import type { ApiAgentState, ApiMessage, ApiOutputActivity } from '../../lib/api-types'

export type AssistantActivityStatus = 'idle' | 'dispatching' | 'streaming' | 'waiting_for_user' | 'waiting_for_terminal'
export type AssistantActivityGateState = {
  workStarted: boolean
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
  workStarted: false, suppressIndicator: false, activeTurnId: null, llmCallId: null, final: false,
})
export const createAssistantActivityGateFromAgentState = (
  snapshot: Pick<ApiAgentState, 'active' | 'turn_id' | 'output_activity'>,
): AssistantActivityGateState => ({
  workStarted: snapshot.active && snapshot.output_activity != null,
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
        workStarted: event.state !== null || state.workStarted,
        suppressIndicator: event.state === 'text' || event.state === 'awaiting_completion',
        activeTurnId: event.turnId, llmCallId: event.state === null ? null : event.llmCallId, final: false,
      }
    case 'assistant_message_persisted':
      if (state.activeTurnId !== event.turnId || !isFinalAssistantMessage(event.message)) return state
      return { ...state, suppressIndicator: true, final: true }
    case 'final':
      if (!event.turnId) return createIdleAssistantActivityGate()
      if (state.activeTurnId && state.activeTurnId !== event.turnId) return state
      return { workStarted: false, suppressIndicator: true, activeTurnId: event.turnId, llmCallId: null, final: true }
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

/** Apply durable recovery rules at snapshot acceptance, never over newer SSE status. */
export function getStatusFromAgentState(agentState: ApiAgentState): AssistantActivityStatus {
  if (agentState.pending_questions?.length || agentState.pending_data_requests?.length || agentState.pending_automation_requests?.length || agentState.pending_bootstrap_requests?.length) return 'waiting_for_user'
  if (!invocationAllowsLiveActivity(agentState)) {
    // Durable admission can precede the process-local runtime. It is still work
    // in progress, including on the immediate post-send refresh.
    const invocation = invocationSummary(agentState)?.invocation
    if (!agentState.active && invocation &&
        ['pending', 'leased', 'running'].includes(invocation.status)) return 'dispatching'
    return 'idle'
  }
  if (agentState.phase === 'waiting_for_user' || agentState.pending_tool?.name === 'ask_user_questions') {
    return 'waiting_for_user'
  }
  if (agentState.phase === 'waiting_for_terminal' || agentState.pending_tool?.name === 'terminal.wait') {
    return 'waiting_for_terminal'
  }
  return 'streaming'
}
