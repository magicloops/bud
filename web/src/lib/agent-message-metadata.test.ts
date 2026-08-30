import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiMessage } from './api-types.ts'
import {
  getMessageTiming,
  getSegmentKind,
  getToolName,
  getTurnId,
  isIntermediateAssistantMessage,
} from './agent-message-metadata.ts'

const buildMessage = (overrides: Partial<ApiMessage> & Pick<ApiMessage, 'client_id'>): ApiMessage => ({
  message_id: overrides.message_id ?? overrides.client_id,
  client_id: overrides.client_id,
  role: overrides.role ?? 'assistant',
  display_role: overrides.display_role ?? 'Bud Agent',
  content: overrides.content ?? '',
  created_at: overrides.created_at ?? '2026-08-30T10:00:00.000Z',
  metadata: overrides.metadata,
})

test('getTurnId returns the stamped turn and null for legacy rows', () => {
  assert.equal(getTurnId(buildMessage({ client_id: 'a', metadata: { turn_id: 'T1' } })), 'T1')
  assert.equal(getTurnId(buildMessage({ client_id: 'b' })), null)
  assert.equal(getTurnId(buildMessage({ client_id: 'c', metadata: { turn_id: 42 } })), null)
})

test('segment kind defaults to final when absent (wire-compat rule)', () => {
  assert.equal(getSegmentKind(buildMessage({ client_id: 'a' })), 'final')
  assert.equal(
    getSegmentKind(buildMessage({ client_id: 'b', metadata: { segment_kind: 'intermediate' } })),
    'intermediate',
  )
  assert.equal(
    isIntermediateAssistantMessage(
      buildMessage({ client_id: 'c', role: 'reasoning', metadata: { segment_kind: 'intermediate' } }),
    ),
    false,
  )
})

test('timing requires the service_wall_clock source and parseable bounds', () => {
  const timed = buildMessage({
    client_id: 'a',
    metadata: {
      started_at: '2026-08-30T10:00:01.000Z',
      finished_at: '2026-08-30T10:00:03.500Z',
      duration_ms: 2500,
      duration_source: 'service_wall_clock',
    },
  })
  assert.deepEqual(getMessageTiming(timed), {
    startedAtMs: Date.parse('2026-08-30T10:00:01.000Z'),
    finishedAtMs: Date.parse('2026-08-30T10:00:03.500Z'),
    durationMs: 2500,
  })

  // Unknown sources are never authoritative; no estimates for legacy rows.
  assert.equal(
    getMessageTiming(
      buildMessage({
        client_id: 'b',
        metadata: { started_at: '2026-08-30T10:00:01.000Z', finished_at: '2026-08-30T10:00:02.000Z' },
      }),
    ),
    null,
  )
  assert.equal(
    getMessageTiming(
      buildMessage({
        client_id: 'c',
        metadata: { started_at: 'nope', finished_at: 'nope', duration_source: 'service_wall_clock' },
      }),
    ),
    null,
  )
})

test('timing derives duration from bounds when duration_ms is absent', () => {
  const timing = getMessageTiming(
    buildMessage({
      client_id: 'a',
      metadata: {
        started_at: '2026-08-30T10:00:01.000Z',
        finished_at: '2026-08-30T10:00:02.000Z',
        duration_source: 'service_wall_clock',
      },
    }),
  )
  assert.equal(timing?.durationMs, 1000)
})

test('tool name comes from metadata, falling back to the content payload', () => {
  assert.equal(
    getToolName(buildMessage({ client_id: 'a', role: 'tool', metadata: { tool: 'terminal.send' } })),
    'terminal.send',
  )
  assert.equal(
    getToolName(
      buildMessage({ client_id: 'b', role: 'tool', content: '{"tool":"ask_user_questions"}' }),
    ),
    'ask_user_questions',
  )
  assert.equal(getToolName(buildMessage({ client_id: 'c', role: 'tool', content: 'not json' })), null)
  assert.equal(getToolName(buildMessage({ client_id: 'd', role: 'assistant' })), null)
})
