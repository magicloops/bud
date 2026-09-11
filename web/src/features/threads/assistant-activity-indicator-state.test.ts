import test from 'node:test'
import assert from 'node:assert/strict'
import { createAssistantActivityGateFromAgentState, createIdleAssistantActivityGate, deriveAssistantActivityIndicatorVisible, reduceAssistantActivityGate } from './assistant-activity-indicator-state.ts'

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
