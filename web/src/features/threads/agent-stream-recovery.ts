export type AgentStreamErrorRecoveryAction =
  | 'auth_stop'
  | 'bootstrap_recover'
  | 'manual_reconnect'
  | 'ignore'

type AgentStreamErrorRecoveryInput = {
  unauthorized: boolean
  authRedirectPending: boolean
  suppressErrorReconnect: boolean
  hasCurrentThread: boolean
  hasCursor: boolean
  readyState: number
  connectingState: number
  closedState: number
}

export function getAgentStreamErrorRecoveryAction({
  unauthorized,
  authRedirectPending,
  suppressErrorReconnect,
  hasCurrentThread,
  hasCursor,
  readyState,
  connectingState,
  closedState,
}: AgentStreamErrorRecoveryInput): AgentStreamErrorRecoveryAction {
  if (unauthorized || authRedirectPending) {
    return 'auth_stop'
  }

  if (suppressErrorReconnect || !hasCurrentThread) {
    return 'ignore'
  }

  if (readyState === connectingState && hasCursor) {
    return 'bootstrap_recover'
  }

  if (readyState === closedState) {
    return 'manual_reconnect'
  }

  return 'ignore'
}
