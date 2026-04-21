import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getThreadStreamHeartbeatConfig,
  getThreadStreamReconnectDelay,
  hasMissedThreadStreamHeartbeat,
  shouldTreatTerminalStatusAsStale,
} from './thread-stream-timing.ts'

test('getThreadStreamReconnectDelay starts at 500ms and caps at 5s', () => {
  assert.equal(getThreadStreamReconnectDelay(0), 500)
  assert.equal(getThreadStreamReconnectDelay(1), 500)
  assert.equal(getThreadStreamReconnectDelay(5), 2500)
  assert.equal(getThreadStreamReconnectDelay(20), 5000)
})

test('getThreadStreamHeartbeatConfig uses tighter timings in development', () => {
  assert.deepEqual(getThreadStreamHeartbeatConfig(true), {
    heartbeatTimeoutMs: 3000,
    checkIntervalMs: 1000,
  })
  assert.deepEqual(getThreadStreamHeartbeatConfig(false), {
    heartbeatTimeoutMs: 15000,
    checkIntervalMs: 5000,
  })
})

test('hasMissedThreadStreamHeartbeat only trips after the timeout boundary', () => {
  assert.equal(hasMissedThreadStreamHeartbeat(1_000, 4_000, 3_000), false)
  assert.equal(hasMissedThreadStreamHeartbeat(1_000, 4_001, 3_000), true)
})

test('shouldTreatTerminalStatusAsStale waits until the status gap exceeds five seconds', () => {
  assert.equal(shouldTreatTerminalStatusAsStale(10_000, 15_000), false)
  assert.equal(shouldTreatTerminalStatusAsStale(10_000, 15_001), true)
})
