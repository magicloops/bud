import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiMessage } from './api-types.ts'
import { computeAgentWorkDurationMs, formatWorkDuration } from './agent-work-duration.ts'

const timedMessage = (
  clientId: string,
  role: string,
  startedAt: string,
  finishedAt: string,
): ApiMessage => ({
  message_id: clientId,
  client_id: clientId,
  role,
  display_role: role,
  content: '',
  created_at: startedAt,
  metadata: {
    started_at: startedAt,
    finished_at: finishedAt,
    duration_source: 'service_wall_clock',
  },
})

test('overlapping intervals are counted once (union, not sum)', () => {
  const duration = computeAgentWorkDurationMs([
    timedMessage('r1', 'reasoning', '2026-08-30T10:00:00.000Z', '2026-08-30T10:00:04.000Z'),
    timedMessage('t1', 'tool', '2026-08-30T10:00:02.000Z', '2026-08-30T10:00:06.000Z'),
  ])
  assert.equal(duration, 6000)
})

test('disjoint intervals sum without counting the gap between them', () => {
  const duration = computeAgentWorkDurationMs([
    timedMessage('t1', 'tool', '2026-08-30T10:00:00.000Z', '2026-08-30T10:00:02.000Z'),
    timedMessage('t2', 'tool', '2026-08-30T10:00:10.000Z', '2026-08-30T10:00:13.000Z'),
  ])
  assert.equal(duration, 5000)
})

test('legacy pure-tool groups sum payload duration_ms; mixed groups do not', () => {
  const legacyTool = (clientId: string, durationMs: number): ApiMessage => ({
    message_id: clientId,
    client_id: clientId,
    role: 'tool',
    display_role: 'shell.run',
    content: '',
    created_at: '2026-08-30T10:00:00.000Z',
    metadata: { duration_ms: durationMs },
  })
  assert.equal(computeAgentWorkDurationMs([legacyTool('t1', 1500), legacyTool('t2', 2500)]), 4000)

  const legacyReasoning: ApiMessage = {
    message_id: 'r1',
    client_id: 'r1',
    role: 'reasoning',
    display_role: 'Reasoning',
    content: '',
    created_at: '2026-08-30T10:00:00.000Z',
  }
  assert.equal(computeAgentWorkDurationMs([legacyTool('t1', 1500), legacyReasoning]), null)
})

test('no trustworthy metadata yields null, never an estimate', () => {
  assert.equal(computeAgentWorkDurationMs([]), null)
  const bare: ApiMessage = {
    message_id: 'r1',
    client_id: 'r1',
    role: 'reasoning',
    display_role: 'Reasoning',
    content: '',
    created_at: '2026-08-30T10:00:00.000Z',
  }
  assert.equal(computeAgentWorkDurationMs([bare]), null)
})

test('formatWorkDuration renders seconds then minutes+seconds', () => {
  assert.equal(formatWorkDuration(400), '0s')
  assert.equal(formatWorkDuration(42_000), '42s')
  assert.equal(formatWorkDuration(88_000), '1m 28s')
  assert.equal(formatWorkDuration(120_000), '2m')
})
