import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiAgentState } from '../../lib/api-types.ts'
import { getStatusFromAgentState, createAssistantActivityGateFromAgentState, createIdleAssistantActivityGate, deriveAssistantActivityIndicatorVisible, reduceAssistantActivityGate } from './assistant-activity-indicator-state.ts'

const update = (state: ReturnType<typeof createIdleAssistantActivityGate>, activity: 'working' | 'text' | 'awaiting_completion' | null, turnId = 'T', llmCallId = 'L') =>
  reduceAssistantActivityGate(state, { type: 'output_activity', turnId, llmCallId, state: activity })

test('commentary remains unfinished while tool assembly restores progress', () => {
  let state = update(createIdleAssistantActivityGate(), 'working')
  assert.equal(state.suppressIndicator, false)
  state = update(state, 'text')
  assert.equal(state.suppressIndicator, true)
  state = update(state, 'awaiting_completion')
  assert.equal(state.suppressIndicator, true)
  state = update(state, 'working')
  assert.equal(deriveAssistantActivityIndicatorVisible({ status: 'streaming', activeCompaction: false, gate: state }), true)
  state = update(state, 'text')
  assert.equal(state.suppressIndicator, true)
})

test('snapshot restores actual activity instead of inferring it from draft presence', () => {
  for (const activity of ['working', 'text', 'awaiting_completion'] as const) {
    const state = createAssistantActivityGateFromAgentState({ active: true, turn_id: 'T', output_activity: { llm_call_id: 'L', state: activity } })
    assert.equal(state.suppressIndicator, activity !== 'working')
    assert.equal(update(state, 'working').suppressIndicator, false)
  }
  assert.equal(createAssistantActivityGateFromAgentState({ active: false, turn_id: null, output_activity: { llm_call_id: 'L', state: 'text' } }).suppressIndicator, false)
})

test('old call clears and old turn finals do not affect current text', () => {
  let state = update(createIdleAssistantActivityGate(), 'working', 'new', 'new-call')
  state = update(state, 'text', 'new', 'new-call')
  assert.deepEqual(update(state, null, 'old', 'old-call'), state)
  assert.deepEqual(update(state, null, 'new', 'old-call'), state)
  assert.deepEqual(update(state, 'text', 'new', 'old-call'), state)
  assert.deepEqual(reduceAssistantActivityGate(state, { type: 'final', turnId: 'old' }), state)
})

test('final persistence and runtime clear never flash; next turn can begin', () => {
  let state = update(createIdleAssistantActivityGate(), 'working')
  state = update(state, 'awaiting_completion')
  state = reduceAssistantActivityGate(state, { type: 'assistant_message_persisted', turnId: 'T', message: { role: 'assistant', metadata: { segment_kind: 'final' } } })
  assert.equal(update(state, null).suppressIndicator, true)
  state = reduceAssistantActivityGate(state, { type: 'final', turnId: 'T' })
  assert.equal(update(state, 'working').suppressIndicator, true)
  assert.equal(update(state, 'working', 'new', 'new-call').suppressIndicator, false)
})

test('empty output, pending sends, waits, idle and compaction keep existing eligibility', () => {
  const state = createIdleAssistantActivityGate()
  for (const status of ['dispatching', 'streaming', 'waiting_for_user', 'waiting_for_terminal', 'idle'] as const) {
    assert.equal(deriveAssistantActivityIndicatorVisible({ status, activeCompaction: false, gate: state }), status === 'dispatching' || status === 'streaming')
  }
  assert.equal(deriveAssistantActivityIndicatorVisible({ status: 'streaming', activeCompaction: true, gate: update(update(state, 'working'), 'text') }), true)
})

const snapshot = (overrides: Partial<ApiAgentState> = {}): ApiAgentState => ({
  active: false, turn_id: null, phase: 'idle', pending_tool: null,
  draft_assistant: null, can_cancel: false, stream_cursor: null, updated_at: '',
  invocations: [], ...overrides,
})

test('fresh working status remains eligible despite the last snapshot being idle', () => {
  const idle = snapshot()
  let status = getStatusFromAgentState(idle)
  let gate = createAssistantActivityGateFromAgentState(idle)
  const visible = () => deriveAssistantActivityIndicatorVisible({ status, gate, activeCompaction: false })
  assert.equal(visible(), false)
  status = 'dispatching'
  assert.equal(visible(), true)
  // The next SSE working event does not mutate the last fetched snapshot.
  gate = update(gate, 'working')
  status = 'streaming'
  assert.equal(idle.active, false)
  assert.equal(visible(), true)
  gate = update(gate, 'text')
  assert.equal(visible(), false)
  gate = update(gate, 'awaiting_completion')
  assert.equal(visible(), false)
  gate = update(gate, 'working')
  assert.equal(visible(), true)
  status = 'waiting_for_user'
  assert.equal(visible(), false)
  status = 'waiting_for_terminal'
  assert.equal(visible(), false)
  gate = reduceAssistantActivityGate(gate, { type: 'final', turnId: 'T' })
  status = 'streaming'
  assert.equal(visible(), false)
})

test('accepted recovery snapshots still suppress inactive, waiting and finished invocations', () => {
  for (const invocationStatus of ['waiting_for_bud', 'waiting_for_model', 'needs_review', 'failed', 'succeeded', 'canceled', 'expired'] as const) {
    const recovered = snapshot({ active: true, turn_id: 'T', phase: 'thinking',
      invocations: [{ turn_id: 'T', status: invocationStatus } as NonNullable<ApiAgentState['invocations']>[number]] })
    assert.equal(getStatusFromAgentState(recovered), 'idle')
  }
  assert.equal(getStatusFromAgentState(snapshot({ active: true, turn_id: 'T', phase: 'waiting_for_user' })), 'waiting_for_user')
  assert.equal(getStatusFromAgentState(snapshot({ active: true, turn_id: 'T', phase: 'waiting_for_terminal' })), 'waiting_for_terminal')
  assert.equal(getStatusFromAgentState(snapshot({ active: true, turn_id: 'T', phase: 'thinking' })), 'streaming')
})


test('post-send admission stays visible until runtime starts, then text suppresses it', () => {
  let status: ReturnType<typeof getStatusFromAgentState> = 'dispatching'
  let gate = createIdleAssistantActivityGate()
  const visible = () => deriveAssistantActivityIndicatorVisible({ status, gate, activeCompaction: false })
  assert.equal(visible(), true)
  for (const invocationStatus of ['pending', 'leased', 'running'] as const) {
    const admitted = snapshot({ invocations: [{
      invocation_id: 'new', turn_id: 'T', status: invocationStatus, reserves_thread: true,
    } as NonNullable<ApiAgentState['invocations']>[number]] })
    status = getStatusFromAgentState(admitted)
    gate = createAssistantActivityGateFromAgentState(admitted)
    assert.equal(status, 'dispatching')
    assert.equal(visible(), true)
  }
  gate = update(gate, 'working')
  status = 'streaming'
  assert.equal(visible(), true)
  gate = update(gate, 'text')
  assert.equal(visible(), false)
})

test('inactive admitted waits and terminal outcomes do not hold startup progress open', () => {
  for (const invocationStatus of ['waiting_for_bud', 'waiting_for_model', 'waiting_for_user', 'retry_wait', 'needs_review', 'failed', 'succeeded', 'canceled', 'expired'] as const) {
    const ended = snapshot({ invocations: [{
      invocation_id: 'new', turn_id: 'T', status: invocationStatus, reserves_thread: true,
    } as NonNullable<ApiAgentState['invocations']>[number]] })
    assert.equal(deriveAssistantActivityIndicatorVisible({
      status: getStatusFromAgentState(ended), gate: createAssistantActivityGateFromAgentState(ended), activeCompaction: false,
    }), false)
  }
})

test('working signal bypasses grace through tool gaps and resets on a new send', () => {
  let gate = createIdleAssistantActivityGate()
  assert.equal(gate.workStarted, false)
  gate = update(gate, 'working')
  assert.equal(gate.workStarted, true)
  gate = update(gate, 'text')
  assert.equal(gate.suppressIndicator, true)
  gate = update(gate, null)
  assert.equal(gate.workStarted, true)
  assert.equal(gate.suppressIndicator, false)
  gate = reduceAssistantActivityGate(gate, { type: 'final' })
  assert.equal(gate.workStarted, false)
  assert.equal(createAssistantActivityGateFromAgentState(snapshot()).workStarted, false)
  assert.equal(createAssistantActivityGateFromAgentState(snapshot({ active: true, turn_id: 'T', output_activity: { llm_call_id: 'L', state: 'working' } })).workStarted, true)
})
