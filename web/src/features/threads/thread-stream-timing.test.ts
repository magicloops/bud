import test from 'node:test'
import assert from 'node:assert/strict'
import {
  THREAD_STREAM_DEV_HEARTBEAT_INTERVAL_MS,
  THREAD_STREAM_HEARTBEAT_INTERVAL_MS,
  THREAD_STREAM_HEARTBEAT_TIMEOUT_MULTIPLIER,
  getThreadStreamHeartbeatConfig,
  getThreadStreamReconnectDelay,
  hasMissedThreadStreamHeartbeat,
} from './thread-stream-timing.ts'

test('getThreadStreamReconnectDelay starts at 500ms and caps at 5s', () => {
  assert.equal(getThreadStreamReconnectDelay(0), 500)
  assert.equal(getThreadStreamReconnectDelay(1), 500)
  assert.equal(getThreadStreamReconnectDelay(5), 2500)
  assert.equal(getThreadStreamReconnectDelay(20), 5000)
})

test('heartbeat watchdog timeout is derived from the heartbeat cadence', () => {
  assert.deepEqual(getThreadStreamHeartbeatConfig(true), {
    heartbeatTimeoutMs:
      THREAD_STREAM_DEV_HEARTBEAT_INTERVAL_MS * THREAD_STREAM_HEARTBEAT_TIMEOUT_MULTIPLIER,
    checkIntervalMs: THREAD_STREAM_DEV_HEARTBEAT_INTERVAL_MS,
  })
  assert.deepEqual(getThreadStreamHeartbeatConfig(false), {
    heartbeatTimeoutMs:
      THREAD_STREAM_HEARTBEAT_INTERVAL_MS * THREAD_STREAM_HEARTBEAT_TIMEOUT_MULTIPLIER,
    checkIntervalMs: THREAD_STREAM_HEARTBEAT_INTERVAL_MS,
  })
})

test('watchdog threshold stays at least 2.5x the heartbeat interval', () => {
  assert.equal(THREAD_STREAM_HEARTBEAT_TIMEOUT_MULTIPLIER >= 2.5, true)
  const { heartbeatTimeoutMs } = getThreadStreamHeartbeatConfig(false)
  assert.equal(heartbeatTimeoutMs >= THREAD_STREAM_HEARTBEAT_INTERVAL_MS * 2.5, true)
})

test('production values are unchanged from the pre-derivation constants', () => {
  // The agent stream shares this config; deriving the values must not shift
  // its behavior (prod 15s timeout / 5s check, dev 3s timeout / 1s check).
  assert.deepEqual(getThreadStreamHeartbeatConfig(false), {
    heartbeatTimeoutMs: 15000,
    checkIntervalMs: 5000,
  })
  assert.deepEqual(getThreadStreamHeartbeatConfig(true), {
    heartbeatTimeoutMs: 3000,
    checkIntervalMs: 1000,
  })
})

test('hasMissedThreadStreamHeartbeat only trips after the timeout boundary', () => {
  assert.equal(hasMissedThreadStreamHeartbeat(1_000, 4_000, 3_000), false)
  assert.equal(hasMissedThreadStreamHeartbeat(1_000, 4_001, 3_000), true)
})
