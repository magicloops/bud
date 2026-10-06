import type { ApiAgentInvocation, ApiAgentState } from '../../lib/api-types.ts'

const finished = new Set(['succeeded', 'failed', 'canceled', 'expired'])

const lifecycleOrder: Record<string, number> = {
  pending: 0, leased: 1, running: 2, waiting_for_user: 3,
  waiting_for_bud: 3, waiting_for_model: 3, retry_wait: 3,
  succeeded: 4, failed: 4, expired: 4, needs_review: 4, canceled: 5,
}

export function isInvocationEvent(value: unknown): value is ApiAgentInvocation {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return ['invocation_id', 'turn_id', 'input_message_id', 'model', 'reasoning_effort', 'created_at', 'updated_at', 'next_attempt_at']
    .every(key => typeof row[key] === 'string') &&
    typeof row.status === 'string' && Object.hasOwn(lifecycleOrder, row.status) &&
    ['human', 'automation'].includes(String(row.origin)) && typeof row.reserves_thread === 'boolean' &&
    Number.isSafeInteger(row.attempt) && Number(row.attempt) >= 0 &&
    ['cancel_requested_at', 'latest_start_at', 'outcome_code'].every(key => row[key] === null || typeof row[key] === 'string')
}

/** Attempt increments on every claim; within an attempt lifecycle only advances. */
export function mergeInvocationEvent(state: ApiAgentState, row: ApiAgentInvocation): ApiAgentState {
  const previous = state.invocations?.find(item => item.invocation_id === row.invocation_id)
  if (previous && (previous.attempt > row.attempt ||
      (previous.attempt === row.attempt && lifecycleOrder[previous.status] > lifecycleOrder[row.status]) ||
      previous.updated_at > row.updated_at)) return state
  const invocations = [...(state.invocations ?? []).filter(item => item.invocation_id !== row.invocation_id), row]
    .sort((a, b) => Number(b.reserves_thread) - Number(a.reserves_thread) ||
      b.created_at.localeCompare(a.created_at) || b.invocation_id.localeCompare(a.invocation_id)).slice(0, 50)
  return { ...state, invocations }
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
    case 'failed': return row.outcome_code === 'invalid_model'
      ? 'Model unavailable. Select a supported model; update and review any affected automation.'
      : 'Failed'
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
