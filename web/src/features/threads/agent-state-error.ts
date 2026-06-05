import type { ApiAgentState } from '../../lib/api-types'

export function getAgentStateRuntimeErrorMessage(
  agentState: Pick<ApiAgentState, 'last_error'>,
): string | null {
  return agentState.last_error?.message ?? null
}
