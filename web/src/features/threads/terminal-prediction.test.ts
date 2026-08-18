import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ackApplied,
  assignFlushSeq,
  clearPredictions,
  emptyPredictionState,
  predictKeystroke,
  predictionGhostText,
} from './terminal-prediction.ts'

const BACKSPACE = String.fromCharCode(127)
const ENTER = String.fromCharCode(13)

test('printables accumulate as pending ghost text', () => {
  let state = emptyPredictionState
  for (const ch of ['l', 's', ' ', '-', 'l']) {
    const result = predictKeystroke(state, ch)
    assert.equal(result.cleared, false)
    state = result.state
  }
  assert.equal(predictionGhostText(state), 'ls -l')
})

test('backspace edits the unflushed tail but clears past it', () => {
  let state = predictKeystroke(emptyPredictionState, 'ab').state
  state = predictKeystroke(state, BACKSPACE).state
  assert.equal(predictionGhostText(state), 'a')

  // Flushed chunk + empty pending: backspace would edit already-sent text —
  // bail out conservatively.
  state = assignFlushSeq(state, 1)
  const result = predictKeystroke(state, BACKSPACE)
  assert.equal(result.cleared, true)
  assert.equal(predictionGhostText(result.state), '')
})

test('control input clears all predictions', () => {
  let state = predictKeystroke(emptyPredictionState, 'abc').state
  state = assignFlushSeq(state, 1)
  state = predictKeystroke(state, 'd').state
  const result = predictKeystroke(state, ENTER)
  assert.equal(result.cleared, true)
  assert.equal(predictionGhostText(result.state), '')
})

test('flush assigns a seq and acks retire covered chunks only', () => {
  let state = predictKeystroke(emptyPredictionState, 'ab').state
  state = assignFlushSeq(state, 1)
  state = predictKeystroke(state, 'cd').state
  state = assignFlushSeq(state, 2)
  state = predictKeystroke(state, 'e').state
  assert.equal(predictionGhostText(state), 'abcde')

  state = ackApplied(state, 1)
  assert.equal(predictionGhostText(state), 'cde')
  state = ackApplied(state, 2)
  assert.equal(predictionGhostText(state), 'e')
  // Acks never touch unflushed pending text.
  state = ackApplied(state, 99)
  assert.equal(predictionGhostText(state), 'e')
})

test('multi-codepoint pending text backspaces one grapheme-ish unit', () => {
  let state = predictKeystroke(emptyPredictionState, 'héŷ').state
  state = predictKeystroke(state, BACKSPACE).state
  assert.equal(predictionGhostText(state), 'hé')
})

test('oversized bursts and clears are conservative', () => {
  const huge = 'x'.repeat(200)
  const result = predictKeystroke(predictKeystroke(emptyPredictionState, 'a').state, huge)
  assert.equal(result.cleared, true)
  assert.equal(predictionGhostText(clearPredictions()), '')
})
