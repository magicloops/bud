import test from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceAppliedOffset,
  buildTerminalSnapshotText,
  buildTerminalStreamPath,
  planTerminalConnect,
  resolveOutputEndOffset,
} from './terminal-resume.ts'

test('planTerminalConnect requires a snapshot before any offset is known', () => {
  assert.deepEqual(
    planTerminalConnect({ snapshotRequired: false, appliedOffset: null }),
    { mode: 'snapshot' },
  )
})

test('planTerminalConnect forces a snapshot when one is explicitly required', () => {
  assert.deepEqual(
    planTerminalConnect({ snapshotRequired: true, appliedOffset: 4096 }),
    { mode: 'snapshot' },
  )
})

test('planTerminalConnect resumes from the applied offset otherwise', () => {
  assert.deepEqual(
    planTerminalConnect({ snapshotRequired: false, appliedOffset: 4096 }),
    { mode: 'resume', fromOffset: 4096 },
  )
  assert.deepEqual(
    planTerminalConnect({ snapshotRequired: false, appliedOffset: 0 }),
    { mode: 'resume', fromOffset: 0 },
  )
})

test('resolveOutputEndOffset prefers the numeric SSE event id', () => {
  assert.equal(
    resolveOutputEndOffset({ lastEventId: '2048', byteOffset: 999, decodedByteLength: 10 }),
    2048,
  )
  assert.equal(
    resolveOutputEndOffset({ lastEventId: '0', decodedByteLength: 10 }),
    0,
  )
})

test('resolveOutputEndOffset falls back to byte_offset + decoded length', () => {
  assert.equal(
    resolveOutputEndOffset({ lastEventId: '', byteOffset: 100, decodedByteLength: 28 }),
    128,
  )
  assert.equal(
    resolveOutputEndOffset({ lastEventId: 'not-a-number', byteOffset: 0, decodedByteLength: 5 }),
    5,
  )
  assert.equal(
    resolveOutputEndOffset({ byteOffset: 7, decodedByteLength: 3 }),
    10,
  )
})

test('resolveOutputEndOffset rejects negative and fractional values', () => {
  assert.equal(
    resolveOutputEndOffset({ lastEventId: '-5', byteOffset: null, decodedByteLength: 3 }),
    null,
  )
  assert.equal(
    resolveOutputEndOffset({ lastEventId: '1.5', decodedByteLength: 3 }),
    null,
  )
  assert.equal(
    resolveOutputEndOffset({ decodedByteLength: 3 }),
    null,
  )
})

test('advanceAppliedOffset is monotonic and ignores unknown offsets', () => {
  assert.equal(advanceAppliedOffset(null, null), null)
  assert.equal(advanceAppliedOffset(null, 128), 128)
  assert.equal(advanceAppliedOffset(128, 256), 256)
  assert.equal(advanceAppliedOffset(256, 128), 256)
  assert.equal(advanceAppliedOffset(256, null), 256)
})

test('buildTerminalStreamPath only appends from_offset when known', () => {
  assert.equal(
    buildTerminalStreamPath('t1', null),
    '/api/threads/t1/terminal/stream',
  )
  assert.equal(
    buildTerminalStreamPath('t1', 0),
    '/api/threads/t1/terminal/stream?from_offset=0',
  )
  assert.equal(
    buildTerminalStreamPath('t1', 8192),
    '/api/threads/t1/terminal/stream?from_offset=8192',
  )
})

test('buildTerminalSnapshotText joins history above the screen grid', () => {
  assert.equal(buildTerminalSnapshotText('', ''), '')
  assert.equal(buildTerminalSnapshotText('a\nb', ''), 'a\nb')
  assert.equal(buildTerminalSnapshotText('', 'screen'), 'screen')
  assert.equal(buildTerminalSnapshotText('a\nb', '$ prompt'), 'a\nb\n$ prompt')
})
