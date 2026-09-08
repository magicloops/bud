import test from 'node:test'
import assert from 'node:assert/strict'
import { projectTimeline } from './agent-work-projection.ts'
import type { ApiMessage } from '../../lib/api-types.ts'

const row = (id: string, tool: string, pending: boolean): ApiMessage => ({
  message_id: id, client_id: id, role: 'tool', display_role: 'Tool',
  content: JSON.stringify({ tool }), created_at: '2026-09-06T00:00:00Z',
  metadata: { tool, turn_id: 'turn', pending },
})

test('pending and resolved automation reviews stay visible between collapsed work groups', () => {
  for (const tool of ['automations_request_activation', 'automations_request_existing_contacts']) for (const pending of [true, false]) {
    const review = row('review', tool, pending)
    const result = projectTimeline({ messages: [row('draft', 'automations_create_draft', false), review,
      row('query', 'contacts_search', false)], liveTurnId: null })
    assert.deepEqual(result.map(item => item.kind), ['work', 'message', 'work'])
    assert.deepEqual(result[1], { kind: 'message', message: review })
  }
})
