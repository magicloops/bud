import test from 'node:test'
import assert from 'node:assert/strict'
import { createTimelineProjector, projectTimeline } from './agent-work-projection.ts'
import type { ApiMessage } from '../../lib/api-types.ts'

const row = (id: string, tool: string, pending: boolean): ApiMessage => ({
  message_id: id, client_id: id, role: 'tool', display_role: 'Tool',
  content: JSON.stringify({ tool }), created_at: '2026-09-06T00:00:00Z',
  metadata: { tool, turn_id: 'turn', pending },
})

const approvalTools = ['automations_request_activation', 'automations_request_existing_contacts', 'data_request_api_key']

test('pending approval reviews stay visible between collapsed work groups', () => {
  for (const tool of approvalTools) {
    const review = row('review', tool, true)
    const result = projectTimeline({ messages: [row('draft', 'automations_create_draft', false), review,
      row('query', 'contacts_search', false)], liveTurnId: null })
    assert.deepEqual(result.map(item => item.kind), ['work', 'message', 'work'])
    assert.deepEqual(result[1], { kind: 'message', message: review })
  }
})

test('canonical approval results fold into work after a decision, including content-only tool identity', () => {
  for (const tool of approvalTools) for (const status of ['approved', 'declined', 'expired', 'canceled', 'stale']) {
    const project = createTimelineProjector()
    const draft = row('draft', 'automations_create_draft', false)
    const pending = row('review', tool, true)
    const before = project({ messages: [draft, pending], liveTurnId: null })
    assert.equal(before[1].kind, 'message')
    const resolved: ApiMessage = { ...pending, message_id: 'canonical-review',
      content: JSON.stringify({ tool, proposal: { status } }),
      metadata: { turn_id: 'turn', continuation: true } }
    const final: ApiMessage = { ...row('final', '', false), role: 'assistant',
      content: 'The decision is saved.', metadata: { turn_id: 'turn', segment_kind: 'final' } }
    const after = project({ messages: [draft, resolved, final], liveTurnId: null })
    assert.deepEqual(after.map(item => item.kind), ['work', 'message'])
    assert.equal(after[0].kind === 'work' && after[0].id, before[0].kind === 'work' && before[0].id)
    assert.deepEqual(after[0].kind === 'work' && after[0].sourceClientIds, ['draft', 'review'])
    assert.equal(after[1].kind === 'message' && after[1].message, final)
  }
})

test('failed approval calls are ordinary work rather than actionable reviews', () => {
  for (const tool of approvalTools) {
    const failed = { ...row('failed', tool, false), content: JSON.stringify({ tool, ok: false, error: 'invalid_request' }) }
    assert.equal(projectTimeline({ messages: [failed], liveTurnId: null })[0].kind, 'work')
  }
})
