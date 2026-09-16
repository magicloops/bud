import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiAgentState, ApiMessage } from '../../lib/api-types.ts'
import { applyAgentStateOverlay } from './thread-message-state.ts'

test('durable browser wait survives inactive runtime and canonical return wins over stale prompt', () => {
  const state = {
    active: false, turn_id: 'turn', phase: 'waiting_for_user',
    pending_tool: { name: 'browser_request_handoff', client_id: 'client', call_id: 'call',
      started_at: '2026-09-14T00:00:00Z', args: { handoff_id: 'handoff', reason: 'Sign in',
        viewer_path: '/browser/browser_01AAAAAAAAAAAAAAAAAAAAAAAA' } },
    invocations: [{ turn_id: 'turn', status: 'waiting_for_user', reserves_thread: true }],
  } as unknown as ApiAgentState
  const pending = applyAgentStateOverlay([], state)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].client_id, 'client')
  assert.equal(pending[0].metadata?.pending, true)
  assert.deepEqual(applyAgentStateOverlay(pending, state), pending)
  const canonical: ApiMessage = { ...pending[0], message_id: 'persisted',
    content: JSON.stringify({ tool: 'browser_request_handoff', ok: true }),
    metadata: { turn_id: 'turn', continuation: true } }
  assert.deepEqual(applyAgentStateOverlay([canonical], state), [canonical])
  assert.deepEqual(applyAgentStateOverlay(pending, { ...state, pending_tool: null }), [])
})
