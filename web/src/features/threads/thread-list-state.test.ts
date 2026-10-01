import assert from 'node:assert/strict'
import test from 'node:test'
import { ThreadListWindow } from './thread-list-state.ts'
import type { ApiThread, ApiThreadListPage } from '../../lib/api-types'
const row = (id: string, title = id, budId = 'bud'): ApiThread => ({ thread_id: id, title, bud_id: budId, created_at: '2026-09-30T00:00:00.000Z' })
const page = (threads: ApiThread[], sequence = 0): ApiThreadListPage => ({ threads,
  page: { has_more: false, next_cursor: null }, feed_checkpoint: { epoch: 'epoch', sequence } })

test('snapshot-covered patches cannot regress canonical rows; later changes apply once', () => {
  const window = new ThreadListWindow('bud', 2)
  window.begin()
  window.patch({ event: 'upsert', epoch: 'epoch', sequence: 1, thread: row('a', 'stale') })
  window.patch({ event: 'upsert', epoch: 'epoch', sequence: 2, thread: row('b') })
  window.snapshot(page([row('a', 'current')], 1))
  assert.deepEqual(window.rows.map(r => r.title), ['b', 'current'])
  assert.equal(window.patch({ event: 'remove', epoch: 'epoch', sequence: 3, thread_id: 'b' }), true)
  assert.equal(window.rows[0].title, 'current')
  window.patch({ event: 'upsert', epoch: 'epoch', sequence: 4, thread: row('a', 'moved', 'other') })
  assert.equal(window.rows.length, 0)
  assert.throws(() => window.patch({ event: 'remove', epoch: 'epoch', sequence: 6, thread_id: 'a' }), /gap/)
  assert.throws(() => window.patch({ event: 'remove', epoch: 'new', sequence: 5, thread_id: 'a' }), /epoch/)
})

test('windows stay bounded, include archived rows and apply the same ties at page boundaries', () => {
  const window = new ThreadListWindow('bud', 2, row('d'))
  window.snapshot(page([row('c'), row('b')]))
  window.patch({ event: 'upsert', epoch: 'epoch', sequence: 1, thread: row('z') })
  assert.deepEqual(window.rows.map(r => r.thread_id), ['c', 'b'])
  window.patch({ event: 'upsert', epoch: 'epoch', sequence: 2, thread: { ...row('c'), archived: true, pinned: true } })
  assert.equal(window.rows[0].archived, true)
  assert.equal(window.rows.length, 2)
})
