import assert from 'node:assert/strict'
import test from 'node:test'
import {
  persistableWorkbenchView,
  resolveInitialViewMode,
  writeStoredWorkbenchView,
  WORKBENCH_VIEW_STORAGE_KEY,
} from './workbench-view.ts'

test('phones start on chat; larger screens start chat-first with the viewer collapsed', () => {
  assert.equal(resolveInitialViewMode(true, 'web'), 'chat')
  assert.equal(resolveInitialViewMode(true, null), 'chat')
  // The stored view is a record only — it never opens a viewer on load.
  assert.equal(resolveInitialViewMode(false, 'web'), 'none')
  assert.equal(resolveInitialViewMode(false, 'terminal'), 'none')
  assert.equal(resolveInitialViewMode(false, null), 'none')
  assert.equal(resolveInitialViewMode(false, 'file'), 'none')
  assert.equal(resolveInitialViewMode(false, 'chat'), 'none')
  assert.equal(resolveInitialViewMode(false, 'garbage'), 'none')
})

test('only workbench views persist; chat, file, and none are never written', () => {
  assert.equal(persistableWorkbenchView('terminal'), 'terminal')
  assert.equal(persistableWorkbenchView('web'), 'web')
  assert.equal(persistableWorkbenchView('chat'), null)
  assert.equal(persistableWorkbenchView('file'), null)
  assert.equal(persistableWorkbenchView('none'), null)

  const writes: Array<[string, string]> = []
  const storage = { setItem: (k: string, v: string) => writes.push([k, v]) }
  writeStoredWorkbenchView(storage, 'web')
  writeStoredWorkbenchView(storage, 'file')
  writeStoredWorkbenchView(storage, 'chat')
  assert.deepEqual(writes, [[WORKBENCH_VIEW_STORAGE_KEY, 'web']])
})
