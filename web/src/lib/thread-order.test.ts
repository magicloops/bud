import assert from 'node:assert/strict'
import test from 'node:test'
import { compareThreads, latestConversationAt } from './thread-order.ts'

test('work activity does not reorder; persisted conversation events do', () => {
  const a = { thread_id: 'a', created_at: '2026-01-01', last_conversation_at: '2026-01-02', last_activity_at: '2026-01-10' }
  const b = { thread_id: 'b', created_at: '2026-01-01', last_conversation_at: '2026-01-03', last_activity_at: '2026-01-04' }
  assert.deepEqual([a,b].sort(compareThreads).map(t => t.thread_id), ['b','a'])
  a.last_conversation_at = '2026-01-05'
  assert.deepEqual([a,b].sort(compareThreads).map(t => t.thread_id), ['a','b'])
  assert.equal(latestConversationAt(a.last_conversation_at, '2026-01-02'), '2026-01-05')
  assert.equal(latestConversationAt(a.last_conversation_at, undefined), '2026-01-05')
})

test('creation fallback and ties agree with server ordering', () => {
  const rows = [{thread_id:'a',created_at:'2026-01-01'}, {thread_id:'b',created_at:'2026-01-01'}, {thread_id:'c',created_at:'2026-01-02'}]
  assert.deepEqual(rows.sort(compareThreads).map(t => t.thread_id), ['c','b','a'])
})
