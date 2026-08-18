import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TERMINAL_INPUT_QUEUE_MAX_BYTES,
  emptyTerminalInputQueue,
  enqueueTerminalInput,
  hasQueuedTerminalInput,
  takeQueuedTerminalInput,
} from './terminal-input-queue.ts'

test('enqueue accumulates chunks in order and tracks byte totals', () => {
  let { state } = enqueueTerminalInput(emptyTerminalInputQueue, 'ls -la')
  ;({ state } = enqueueTerminalInput(state, '\r'))

  assert.equal(hasQueuedTerminalInput(state), true)
  assert.equal(state.totalBytes, 7)

  const { state: drained, text } = takeQueuedTerminalInput(state)
  assert.equal(text, 'ls -la\r')
  assert.equal(hasQueuedTerminalInput(drained), false)
  assert.equal(drained.totalBytes, 0)
})

test('empty text is a no-op', () => {
  const { state, droppedBytes } = enqueueTerminalInput(emptyTerminalInputQueue, '')
  assert.equal(state, emptyTerminalInputQueue)
  assert.equal(droppedBytes, 0)
})

test('overflow drops oldest chunks first and reports dropped bytes', () => {
  const half = 'a'.repeat(TERMINAL_INPUT_QUEUE_MAX_BYTES / 2)
  let { state } = enqueueTerminalInput(emptyTerminalInputQueue, half)
  ;({ state } = enqueueTerminalInput(state, half))

  const result = enqueueTerminalInput(state, 'zz')
  assert.equal(result.droppedBytes, half.length)
  assert.equal(result.state.totalBytes, half.length + 2)

  const { text } = takeQueuedTerminalInput(result.state)
  assert.equal(text, `${half}zz`)
})

test('a single oversized chunk keeps only its tail bytes', () => {
  const oversized = 'x'.repeat(TERMINAL_INPUT_QUEUE_MAX_BYTES + 100)
  const { state, droppedBytes } = enqueueTerminalInput(emptyTerminalInputQueue, oversized)

  assert.equal(droppedBytes, 100)
  assert.equal(state.totalBytes, TERMINAL_INPUT_QUEUE_MAX_BYTES)

  const { text } = takeQueuedTerminalInput(state)
  assert.equal(text, 'x'.repeat(TERMINAL_INPUT_QUEUE_MAX_BYTES))
})

test('oversized chunk trim lands on a UTF-8 code point boundary', () => {
  // '✓' is 3 bytes; build a chunk that exceeds the cap by one byte so a naive
  // byte slice would land mid-code-point.
  const filler = 'a'.repeat(TERMINAL_INPUT_QUEUE_MAX_BYTES - 2)
  const oversized = `${filler}✓` // cap + 1 bytes total
  const { state } = enqueueTerminalInput(emptyTerminalInputQueue, oversized)

  const { text } = takeQueuedTerminalInput(state)
  assert.equal(text.endsWith('✓'), true)
  assert.equal(state.totalBytes <= TERMINAL_INPUT_QUEUE_MAX_BYTES, true)
})
