import type { ApiAgentInvocation, ApiAgentState } from '../../lib/api-types.ts'

const finished = new Set(['succeeded', 'failed', 'canceled', 'expired'])

export function invocationRevision(state: Pick<ApiAgentState, 'invocations' | 'pending_questions' | 'pending_data_requests' | 'pending_automation_requests' | 'pending_bootstrap_requests'>): string {
  return JSON.stringify([
    state.invocations?.map((row) => [row.invocation_id, row.status, row.reserves_thread, row.attempt, row.cancel_requested_at, row.outcome_code]),
    state.pending_questions?.map((row) => row.request_id),
    state.pending_data_requests?.map((row) => [row.request_id, row.request.version, row.request.status]),
    state.pending_bootstrap_requests?.map((row) => [row.proposal_id, row.proposal.version, row.proposal.status]),
    state.pending_automation_requests?.map((row) => [row.proposal_id, row.proposal.version, row.proposal.status]),
  ])
}

export function invocationSummary(state: Pick<ApiAgentState, 'invocations'>) {
  const rows = state.invocations ?? []
  const current = rows.find((row) => row.reserves_thread)
    ?? rows.find((row) => !finished.has(row.status))
    ?? rows[0]
  if (!current) return null
  const queued = rows.filter((row) => !row.reserves_thread && !finished.has(row.status)).length
  return {
    invocation: current,
    label: invocationLabel(current),
    queuedBehind: Math.max(0, queued - (current.reserves_thread || finished.has(current.status) ? 0 : 1)),
    canCancel: !finished.has(current.status) && current.status !== 'needs_review' && !current.cancel_requested_at,
  }
}

function invocationLabel(row: ApiAgentInvocation): string {
  if (row.cancel_requested_at && !finished.has(row.status) && row.status !== 'needs_review') return 'Stopping…'
  switch (row.status) {
    case 'pending': return 'Queued'
    case 'leased': return 'Preparing'
    case 'running': return 'Running'
    case 'retry_wait': return 'Waiting to retry'
    case 'waiting_for_bud': return 'Waiting for the selected Bud'
    case 'waiting_for_model': return 'Waiting for the selected model'
    case 'waiting_for_user': return 'Waiting for your answer'
    case 'needs_review': return 'Needs review — an action may have run. This thread is paused.'
    case 'expired': return 'Expired before it could start'
    case 'failed': return 'Failed'
    case 'canceled': return 'Canceled'
    case 'succeeded': return 'Completed'
    default: return 'Status unavailable'
  }
}

/** Database state overrides stale process-local activity after recovery. */
export function invocationAllowsLiveActivity(state: ApiAgentState): boolean {
  if (!state.active) return false
  const invocation = state.invocations?.find((row) => row.turn_id === state.turn_id)
  return !invocation || invocation.status === 'running' || invocation.status === 'leased'
}
