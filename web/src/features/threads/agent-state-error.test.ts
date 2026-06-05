import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiAgentState } from '../../lib/api-types.ts'
import { getAgentStateRuntimeErrorMessage } from './agent-state-error.ts'

const buildAgentState = (overrides: Partial<ApiAgentState> = {}): ApiAgentState => ({
  active: false,
  turn_id: null,
  phase: 'idle',
  can_cancel: false,
  stream_cursor: 'cursor-0',
  pending_tool: null,
  draft_assistant: null,
  updated_at: '2026-06-04T00:00:00.000Z',
  ...overrides,
})

test('getAgentStateRuntimeErrorMessage reads runtime last_error copy', () => {
  assert.equal(
    getAgentStateRuntimeErrorMessage(buildAgentState({
      last_error: {
        turn_id: 'turn-1',
        code: 'DATA_PLANE_STREAM_LIMIT_EXCEEDED',
        message: 'The local model is already busy.\n\nError: DATA_PLANE_STREAM_LIMIT_EXCEEDED',
        retryable: true,
        occurred_at: '2026-06-04T00:00:00.000Z',
      },
    })),
    'The local model is already busy.\n\nError: DATA_PLANE_STREAM_LIMIT_EXCEEDED',
  )
})

test('getAgentStateRuntimeErrorMessage clears when no runtime error is present', () => {
  assert.equal(getAgentStateRuntimeErrorMessage(buildAgentState()), null)
  assert.equal(getAgentStateRuntimeErrorMessage(buildAgentState({ last_error: null })), null)
})
