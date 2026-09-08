import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiAgentInvocation, ApiAgentState, ApiPendingQuestion } from '../../lib/api-types.ts'
import { invocationAllowsLiveActivity, invocationRevision, invocationSummary } from './invocation-state.ts'
import { applyAgentStateOverlay } from './thread-message-state.ts'

const invocation = (overrides: Partial<ApiAgentInvocation> = {}): ApiAgentInvocation => ({
  invocation_id: 'inv-1', turn_id: 'turn-1', input_message_id: 'input-1', origin: 'human',
  status: 'pending', model: 'selected-model', reasoning_effort: 'high', reserves_thread: false,
  attempt: 0, outcome_code: null, latest_start_at: null, next_attempt_at: '2026-09-04T00:00:00Z',
  cancel_requested_at: null, created_at: '2026-09-04T00:00:00Z', updated_at: '2026-09-04T00:00:00Z', ...overrides,
})
const state = (overrides: Partial<ApiAgentState> = {}): ApiAgentState => ({
  active: false, turn_id: null, phase: 'idle', can_cancel: false, stream_cursor: 'cursor',
  pending_tool: null, draft_assistant: null, updated_at: '2026-09-04T00:00:00Z', ...overrides,
})
const question: ApiPendingQuestion = {
  request_id: 'q-1', client_id: 'question-client', call_id: 'call-1', turn_id: 'turn-1',
  created_at: '2026-09-04T00:00:00Z',
  request: { schema: 'ask_user_questions_request_v1', request_id: 'q-1',
    questions: [{ question_id: 'choice', kind: 'boolean', label: 'Continue?' }] },
}

test('reserved review state wins over newer queued work and disables cancellation', () => {
  const summary = invocationSummary(state({ invocations: [invocation(), invocation({ invocation_id: 'older', status: 'needs_review', reserves_thread: true })] }))
  assert.equal(summary?.invocation.invocation_id, 'older')
  assert.match(summary!.label, /Needs review/)
  assert.equal(summary?.queuedBehind, 1)
  assert.equal(summary?.canCancel, false)
})

test('offline, expired and unknown statuses have honest labels without fallback', () => {
  assert.equal(invocationSummary(state({ invocations: [invocation({ status: 'waiting_for_model' })] }))?.label, 'Waiting for the selected model')
  assert.equal(invocationSummary(state({ invocations: [invocation({ status: 'expired' })] }))?.canCancel, false)
  assert.equal(invocationSummary(state({ invocations: [invocation({ status: 'future_status' })] }))?.label, 'Status unavailable')
  assert.equal(invocationSummary(state()), null)
})

test('durable recovery suppresses stale activity but preserves legacy runtime behavior', () => {
  const active = state({ active: true, turn_id: 'turn-1' })
  assert.equal(invocationAllowsLiveActivity(active), true)
  assert.equal(invocationAllowsLiveActivity({ ...active, invocations: [invocation({ status: 'needs_review' })] }), false)
  assert.equal(invocationAllowsLiveActivity({ ...active, invocations: [invocation({ status: 'running' })] }), true)
})

test('canonical refresh ignores lease heartbeats but detects answer and lifecycle transitions', () => {
  const before = state({ invocations: [invocation()], pending_questions: [question] })
  assert.equal(invocationRevision(before), invocationRevision({ ...before, invocations: [invocation({ updated_at: 'later' })] }))
  assert.notEqual(invocationRevision(before), invocationRevision({ ...before, pending_questions: [] }))
  assert.notEqual(invocationRevision(before), invocationRevision({ ...before, invocations: [invocation({ status: 'running' })] }))
})

test('cold bootstrap restores a question once, then removes it after answer', () => {
  const snapshot = state({ pending_questions: [question] })
  const rows = applyAgentStateOverlay([], snapshot)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].client_id, question.client_id)
  assert.equal(rows[0].created_at, question.created_at)
  assert.equal(JSON.parse(rows[0].content).request_id, 'q-1')
  assert.equal(applyAgentStateOverlay(rows, snapshot).length, 1)
  assert.deepEqual(applyAgentStateOverlay(rows, state({ pending_questions: [] })), [])
})

test('canonical question result wins over stale durable and runtime pending snapshots', () => {
  const result = { message_id: 'result', client_id: question.client_id, role: 'tool', display_role: 'Tool',
    content: 'accepted answers', created_at: '2026-09-04T00:01:00Z' }
  const snapshot = state({ active: true, turn_id: question.turn_id, pending_questions: [question],
    pending_tool: { client_id: question.client_id, call_id: question.call_id, name: 'ask_user_questions', args: question.request } })
  assert.deepEqual(applyAgentStateOverlay([result], snapshot), [result])
})

test('permission creation and resolution refresh canonical thread state', () => {
  const pending = { request_id: 'dar_request', turn_id: 'turn-1', client_id: 'client', call_id: 'call',
    created_at: '2026-09-04T00:00:00Z', request: { request_id: 'dar_request', app_label: 'Contacts', purpose: 'Read names', status: 'pending', version: 0 } }
  const before = state({ invocations: [invocation({ status: 'waiting_for_user', reserves_thread: true })], pending_data_requests: [] })
  const waiting = { ...before, pending_data_requests: [pending] }
  assert.notEqual(invocationRevision(before), invocationRevision(waiting))
  assert.notEqual(invocationRevision(waiting), invocationRevision({ ...waiting, pending_data_requests: [] }))
  assert.notEqual(invocationRevision(waiting), invocationRevision({ ...waiting,
    pending_data_requests: [{ ...pending, request: { ...pending.request, version: 1, status: 'approved' } }] }))
})

test('automation reviews recover once and completed decisions beat stale pending state', () => {
  const pending: NonNullable<ApiAgentState['pending_automation_requests']>[number] = {
    proposal_id: 'ap_pending', turn_id: 'turn-1', client_id: 'review-client', call_id: 'review-call',
    created_at: '2026-09-06T00:00:00Z',
    proposal: {
      proposal_id: 'ap_pending', automation_id: 'auto_test', invocation_id: 'inv-1',
      thread_id: 'thread-1', bud_id: 'bud-1', call_id: 'review-call',
      definition: { event_type: 'contact.added', name: 'Contact note', instruction: 'Write a note',
        sources: { source_ids: [] }, bud_id: 'bud-1', model: 'selected-model', reasoning_effort: 'high',
        target: { mode: 'new_thread' }, data_access: { scopes: ['contacts.read'], history_days: 30 },
        latest_start_seconds: 86400, max_invocations_per_day: 5 },
      draft_version: 0, grant_version: 1, version: 0, status: 'pending', activated_revision: null,
      expires_at: '2026-09-07T00:00:00Z', decided_at: null,
      created_at: '2026-09-06T00:00:00Z', updated_at: '2026-09-06T00:00:00Z',
    },
  }
  const snapshot = state({ pending_automation_requests: [pending] })
  const rows = applyAgentStateOverlay([], snapshot)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].client_id, pending.client_id)
  assert.equal(rows[0].created_at, pending.created_at)
  assert.equal(JSON.parse(rows[0].content).proposal_id, pending.proposal_id)
  assert.deepEqual(applyAgentStateOverlay(rows, snapshot), rows)
  const runtime = { client_id: 'review-client', call_id: pending.call_id,
    name: 'automations_request_activation', args: pending.proposal }
  const cleared = state({ active: true, turn_id: 'turn-1', pending_tool: runtime, pending_automation_requests: [] })
  assert.deepEqual(applyAgentStateOverlay(rows, cleared), [])
  assert.equal(applyAgentStateOverlay([], { ...cleared, pending_automation_requests: undefined }).length, 1)
  const canonical = { ...rows[0], content: 'approved', metadata: { turn_id: 'turn-1' } }
  assert.deepEqual(applyAgentStateOverlay([canonical], snapshot), [canonical])
  assert.deepEqual(applyAgentStateOverlay([], { ...snapshot,
    pending_automation_requests: [{ ...pending, client_id: null }] }), [])
  assert.notEqual(invocationRevision(snapshot), invocationRevision(cleared))
  assert.notEqual(invocationRevision(snapshot), invocationRevision({ ...snapshot,
    pending_automation_requests: [{ ...pending, proposal: { ...pending.proposal, version: 1, status: 'approved' } }] }))
})

test('existing-contact reviews recover once and completed decisions beat stale pending state', () => {
  const pending: NonNullable<ApiAgentState['pending_bootstrap_requests']>[number] = {
    proposal_id: 'bp_pending', turn_id: 'turn-1', client_id: 'review-client', call_id: 'review-call',
    created_at: '2026-09-06T00:00:00Z',
    proposal: {
      proposal_id: 'bp_pending', automation_id: 'auto_test', invocation_id: 'inv-1',
      thread_id: 'thread-1', bud_id: 'bud-1', call_id: 'review-call',
      definition: { event_type: 'contact.added', name: 'Contact note', instruction: 'Write a note',
        sources: { source_ids: [] }, bud_id: 'bud-1', model: 'selected-model', reasoning_effort: 'high',
        target: { mode: 'new_thread' }, data_access: { scopes: ['contacts.read'], history_days: 30 },
        latest_start_seconds: 86400, max_invocations_per_day: 5 },
      kind: 'existing_contacts', revision: 1, grant_version: 1, version: 0, status: 'pending', bootstrap_id: null,
      selection: { automation_id: 'auto_test', expected_version: 0, sources: { source_ids: [] }, search: '', max_contacts: 50, mode: 'batched', exclude_previously_delivered: true },
      member_count: 3, group_size: 25, group_count: 1,
      expires_at: '2026-09-07T00:00:00Z', decided_at: null,
      created_at: '2026-09-06T00:00:00Z', updated_at: '2026-09-06T00:00:00Z',
    },
  }
  const snapshot = state({ pending_bootstrap_requests: [pending] })
  const rows = applyAgentStateOverlay([], snapshot)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].client_id, pending.client_id)
  assert.equal(rows[0].created_at, pending.created_at)
  assert.equal(JSON.parse(rows[0].content).proposal_id, pending.proposal_id)
  assert.deepEqual(applyAgentStateOverlay(rows, snapshot), rows)
  const runtime = { client_id: 'review-client', call_id: pending.call_id,
    name: 'automations_request_existing_contacts', args: pending.proposal }
  const cleared = state({ active: true, turn_id: 'turn-1', pending_tool: runtime, pending_bootstrap_requests: [] })
  assert.deepEqual(applyAgentStateOverlay(rows, cleared), [])
  assert.equal(applyAgentStateOverlay([], { ...cleared, pending_bootstrap_requests: undefined }).length, 1)
  const canonical = { ...rows[0], content: 'approved', metadata: { turn_id: 'turn-1' } }
  assert.deepEqual(applyAgentStateOverlay([canonical], snapshot), [canonical])
  assert.deepEqual(applyAgentStateOverlay([], { ...snapshot,
    pending_bootstrap_requests: [{ ...pending, client_id: null }] }), [])
  assert.notEqual(invocationRevision(snapshot), invocationRevision(cleared))
  assert.notEqual(invocationRevision(snapshot), invocationRevision({ ...snapshot,
    pending_bootstrap_requests: [{ ...pending, proposal: { ...pending.proposal, version: 1, status: 'approved' } }] }))
})
