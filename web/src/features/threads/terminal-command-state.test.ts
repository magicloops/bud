import test from 'node:test'
import assert from 'node:assert/strict'
import { reduceTerminalCommandChip } from './terminal-command-state.ts'

test('command_started produces a running chip', () => {
  assert.deepEqual(
    reduceTerminalCommandChip(null, {
      event: 'command_started',
      data: { command_id: 'c1' },
    }),
    { status: 'running', commandId: 'c1' },
  )
})

test('command_finished records the exit code and replaces running', () => {
  const running = reduceTerminalCommandChip(null, {
    event: 'command_started',
    data: { command_id: 'c1' },
  })
  assert.deepEqual(
    reduceTerminalCommandChip(running, {
      event: 'command_finished',
      data: { command_id: 'c1', exit_code: 0, duration_ms: 42 },
    }),
    { status: 'finished', commandId: 'c1', exitCode: 0 },
  )
  assert.deepEqual(
    reduceTerminalCommandChip(running, {
      event: 'command_finished',
      data: { command_id: 'c1', exit_code: 127 },
    }),
    { status: 'finished', commandId: 'c1', exitCode: 127 },
  )
})

test('command_finished without a numeric exit code yields exitCode null', () => {
  assert.deepEqual(
    reduceTerminalCommandChip(null, {
      event: 'command_finished',
      data: { command_id: 'c1' },
    }),
    { status: 'finished', commandId: 'c1', exitCode: null },
  )
})

test('a new command_started supersedes a finished chip', () => {
  const finished = reduceTerminalCommandChip(null, {
    event: 'command_finished',
    data: { command_id: 'c1', exit_code: 1 },
  })
  assert.deepEqual(
    reduceTerminalCommandChip(finished, {
      event: 'command_started',
      data: { command_id: 'c2' },
    }),
    { status: 'running', commandId: 'c2' },
  )
})

test('child_exited clears the chip', () => {
  const running = reduceTerminalCommandChip(null, {
    event: 'command_started',
    data: { command_id: 'c1' },
  })
  assert.equal(reduceTerminalCommandChip(running, { event: 'child_exited' }), null)
})

test('unrelated events leave the chip unchanged', () => {
  const running = reduceTerminalCommandChip(null, {
    event: 'command_started',
    data: { command_id: 'c1' },
  })
  assert.equal(
    reduceTerminalCommandChip(running, {
      event: 'mode_changed',
      data: { mode: 'tui', integration: 'none' },
    }),
    running,
  )
  assert.equal(reduceTerminalCommandChip(running, { event: 'prompt_ready' }), running)
  assert.equal(reduceTerminalCommandChip(running, { event: 'settled' }), running)
  assert.equal(reduceTerminalCommandChip(running, {}), running)
})

test('malformed data payloads are tolerated', () => {
  assert.deepEqual(
    reduceTerminalCommandChip(null, { event: 'command_started', data: 'garbage' }),
    { status: 'running', commandId: null },
  )
  assert.deepEqual(
    reduceTerminalCommandChip(null, {
      event: 'command_finished',
      data: { exit_code: 'zero' },
    }),
    { status: 'finished', commandId: null, exitCode: null },
  )
})
