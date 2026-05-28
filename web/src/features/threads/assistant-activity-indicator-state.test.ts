import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiAgentState, ApiMessage } from '../../lib/api-types.ts'
import {
  createAssistantActivityGateFromAgentState,
  createIdleAssistantActivityGate,
  deriveAssistantActivityIndicatorVisible,
  isFinalAssistantMessage,
  reduceAssistantActivityGate,
} from './assistant-activity-indicator-state.ts'

const buildAgentState = (overrides: Partial<ApiAgentState> = {}): ApiAgentState => ({
  active: false,
  turn_id: null,
  phase: 'idle',
  can_cancel: false,
  stream_cursor: 'cursor-0',
  pending_tool: null,
  draft_assistant: null,
  updated_at: '2026-05-28T10:00:00.000Z',
  ...overrides,
})

const buildAssistantMessage = (metadata?: Record<string, unknown>): ApiMessage => ({
  message_id: 'message-1',
  client_id: 'client-1',
  role: 'assistant',
  display_role: 'Bud Agent',
  content: 'Done.',
  created_at: '2026-05-28T10:00:01.000Z',
  metadata,
})

test('bootstrap suppresses the indicator only when a draft assistant exists', () => {
  assert.deepEqual(
    createAssistantActivityGateFromAgentState(buildAgentState({
      active: true,
      turn_id: 'turn-1',
      draft_assistant: {
        client_id: 'assistant-client',
        text: 'streaming text',
        updated_at: '2026-05-28T10:00:01.000Z',
      },
    })),
    {
      suppressIndicator: true,
      activeTurnId: 'turn-1',
      pendingUnsuppressTurnId: null,
    },
  )

  assert.deepEqual(
    createAssistantActivityGateFromAgentState(buildAgentState({
      active: true,
      turn_id: 'turn-1',
      draft_assistant: null,
    })),
    {
      suppressIndicator: false,
      activeTurnId: null,
      pendingUnsuppressTurnId: null,
    },
  )
})

test('assistant message start and delta suppress the indicator', () => {
  const started = reduceAssistantActivityGate(createIdleAssistantActivityGate(), {
    type: 'assistant_message_start',
    turnId: 'turn-1',
  })
  const delta = reduceAssistantActivityGate(started, {
    type: 'assistant_message_delta',
    turnId: 'turn-1',
  })

  assert.deepEqual(delta, {
    suppressIndicator: true,
    activeTurnId: 'turn-1',
    pendingUnsuppressTurnId: null,
  })
  assert.equal(
    deriveAssistantActivityIndicatorVisible({
      status: 'streaming',
      activeCompaction: false,
      gate: delta,
    }),
    false,
  )
})

test('message_done schedules the gate to clear and the timer event reveals the indicator', () => {
  const done = reduceAssistantActivityGate(createIdleAssistantActivityGate(), {
    type: 'assistant_message_done',
    turnId: 'turn-1',
  })
  assert.deepEqual(done, {
    suppressIndicator: true,
    activeTurnId: 'turn-1',
    pendingUnsuppressTurnId: 'turn-1',
  })

  const elapsed = reduceAssistantActivityGate(done, {
    type: 'message_done_timer',
    turnId: 'turn-1',
  })
  assert.deepEqual(elapsed, {
    suppressIndicator: false,
    activeTurnId: 'turn-1',
    pendingUnsuppressTurnId: null,
  })
  assert.equal(
    deriveAssistantActivityIndicatorVisible({
      status: 'streaming',
      activeCompaction: false,
      gate: elapsed,
    }),
    true,
  )
})

test('stale message_done timers do not clear a newer streaming turn', () => {
  const state = reduceAssistantActivityGate(
    reduceAssistantActivityGate(createIdleAssistantActivityGate(), {
      type: 'assistant_message_done',
      turnId: 'turn-1',
    }),
    {
      type: 'assistant_message_start',
      turnId: 'turn-2',
    },
  )

  assert.deepEqual(
    reduceAssistantActivityGate(state, {
      type: 'message_done_timer',
      turnId: 'turn-1',
    }),
    state,
  )
})

test('final assistant messages keep the indicator suppressed until final event', () => {
  const done = reduceAssistantActivityGate(createIdleAssistantActivityGate(), {
    type: 'assistant_message_done',
    turnId: 'turn-1',
  })
  const persistedFinal = reduceAssistantActivityGate(done, {
    type: 'assistant_message_persisted',
    turnId: 'turn-1',
    message: buildAssistantMessage({
      segment_kind: 'final',
      assistant_phase: 'final_answer',
    }),
  })

  assert.deepEqual(persistedFinal, {
    suppressIndicator: true,
    activeTurnId: 'turn-1',
    pendingUnsuppressTurnId: null,
  })
  assert.equal(isFinalAssistantMessage(buildAssistantMessage({ segment_kind: 'final' })), true)
  assert.equal(isFinalAssistantMessage(buildAssistantMessage({ assistant_phase: 'final_answer' })), true)
  assert.equal(isFinalAssistantMessage(buildAssistantMessage({ segment_kind: 'intermediate' })), false)
})

test('intermediate assistant messages leave the scheduled reveal in place', () => {
  const done = reduceAssistantActivityGate(createIdleAssistantActivityGate(), {
    type: 'assistant_message_done',
    turnId: 'turn-1',
  })
  const persistedIntermediate = reduceAssistantActivityGate(done, {
    type: 'assistant_message_persisted',
    turnId: 'turn-1',
    message: buildAssistantMessage({
      segment_kind: 'intermediate',
      assistant_phase: 'commentary',
      followed_by_tool_call: true,
    }),
  })

  assert.deepEqual(persistedIntermediate, done)
})

test('final resets the gate and compaction overrides normal visibility', () => {
  const suppressed = reduceAssistantActivityGate(createIdleAssistantActivityGate(), {
    type: 'assistant_message_start',
    turnId: 'turn-1',
  })

  assert.deepEqual(
    reduceAssistantActivityGate(suppressed, { type: 'final' }),
    createIdleAssistantActivityGate(),
  )
  assert.equal(
    deriveAssistantActivityIndicatorVisible({
      status: 'streaming',
      activeCompaction: true,
      gate: suppressed,
    }),
    true,
  )
})
