import test from 'node:test'
import assert from 'node:assert/strict'
import { getAgentStreamErrorRecoveryAction } from './agent-stream-recovery.ts'

const CONNECTING = 0
const OPEN = 1
const CLOSED = 2

const baseInput = {
  unauthorized: false,
  authRedirectPending: false,
  suppressErrorReconnect: false,
  hasCurrentThread: true,
  hasCursor: true,
  readyState: OPEN,
  connectingState: CONNECTING,
  closedState: CLOSED,
}

test('agent stream recovery stops when auth is gone', () => {
  assert.equal(
    getAgentStreamErrorRecoveryAction({
      ...baseInput,
      unauthorized: true,
      readyState: CONNECTING,
    }),
    'auth_stop',
  )
  assert.equal(
    getAgentStreamErrorRecoveryAction({
      ...baseInput,
      authRedirectPending: true,
      readyState: CONNECTING,
    }),
    'auth_stop',
  )
})

test('agent stream recovery bootstraps when native EventSource retries a cursor', () => {
  assert.equal(
    getAgentStreamErrorRecoveryAction({
      ...baseInput,
      readyState: CONNECTING,
      hasCursor: true,
    }),
    'bootstrap_recover',
  )
})

test('agent stream recovery does not bootstrap cursorless native reconnects', () => {
  assert.equal(
    getAgentStreamErrorRecoveryAction({
      ...baseInput,
      readyState: CONNECTING,
      hasCursor: false,
    }),
    'ignore',
  )
})

test('agent stream recovery preserves closed-source manual reconnects', () => {
  assert.equal(
    getAgentStreamErrorRecoveryAction({
      ...baseInput,
      readyState: CLOSED,
    }),
    'manual_reconnect',
  )
})

test('agent stream recovery ignores stale or suppressed callbacks', () => {
  assert.equal(
    getAgentStreamErrorRecoveryAction({
      ...baseInput,
      readyState: CONNECTING,
      hasCurrentThread: false,
    }),
    'ignore',
  )
  assert.equal(
    getAgentStreamErrorRecoveryAction({
      ...baseInput,
      readyState: CONNECTING,
      suppressErrorReconnect: true,
    }),
    'ignore',
  )
})
