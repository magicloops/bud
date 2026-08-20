import assert from 'node:assert/strict'
import test from 'node:test'
import {
  persistableWorkbenchView,
  resolveInitialViewMode,
  writeStoredWorkbenchView,
  WORKBENCH_VIEW_STORAGE_KEY,
} from './workbench-view.ts'

test('phones always start on chat; larger screens restore the stored view', () => {
  assert.equal(resolveInitialViewMode(true, 'web'), 'chat')
  assert.equal(resolveInitialViewMode(true, null), 'chat')
  assert.equal(resolveInitialViewMode(false, 'web'), 'web')
  assert.equal(resolveInitialViewMode(false, 'terminal'), 'terminal')
  assert.equal(resolveInitialViewMode(false, null), 'terminal')
  // Transient/mobile-only modes never resolve from storage.
  assert.equal(resolveInitialViewMode(false, 'file'), 'terminal')
  assert.equal(resolveInitialViewMode(false, 'chat'), 'terminal')
  assert.equal(resolveInitialViewMode(false, 'garbage'), 'terminal')
})

test('only workbench views persist; chat and file are never written', () => {
  assert.equal(persistableWorkbenchView('terminal'), 'terminal')
  assert.equal(persistableWorkbenchView('web'), 'web')
  assert.equal(persistableWorkbenchView('chat'), null)
  assert.equal(persistableWorkbenchView('file'), null)

  const writes: Array<[string, string]> = []
  const storage = { setItem: (k: string, v: string) => writes.push([k, v]) }
  writeStoredWorkbenchView(storage, 'web')
  writeStoredWorkbenchView(storage, 'file')
  writeStoredWorkbenchView(storage, 'chat')
  assert.deepEqual(writes, [[WORKBENCH_VIEW_STORAGE_KEY, 'web']])
})
