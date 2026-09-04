import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { ApiMessage } from '../../lib/api-types.ts'
import {
  createTimelineProjector,
  projectTimeline,
  type ProjectTimelineInput,
  type TimelineRow,
  type TurnOutcome,
} from './agent-work-projection.ts'

const FIXTURES_DIR = fileURLToPath(new URL('./__fixtures__/agent-work/', import.meta.url))

type Fixture = {
  name: string
  description: string
  live_turn_id: string | null
  turn_outcomes: Record<string, TurnOutcome>
  messages: ApiMessage[]
  expected: Array<
    | { kind: 'message'; client_id: string }
    | {
        kind: 'work'
        id: string
        live: boolean
        status: string
        duration_ms: number | null
        current_item_client_id: string | null
        sections: Array<{ kind: string; client_id: string }>
      }
  >
}

const fixtureInput = (fixture: Fixture): ProjectTimelineInput => ({
  messages: fixture.messages,
  liveTurnId: fixture.live_turn_id,
  turnOutcomes: new Map(Object.entries(fixture.turn_outcomes)),
})

const serializeRows = (rows: TimelineRow[]): Fixture['expected'] =>
  rows.map((row) =>
    row.kind === 'message'
      ? { kind: 'message', client_id: row.message.client_id }
      : {
          kind: 'work',
          id: row.id,
          live: row.live,
          status: row.status,
          duration_ms: row.durationMs,
          current_item_client_id: row.currentItem?.client_id ?? null,
          sections: row.sections.map((section) => ({
            kind: section.kind,
            client_id: section.message.client_id,
          })),
        },
  )

// Platform-neutral conformance fixtures (shared shape with mobile —
// reference/mobile-agent-work-collapse-web-handoff.md, adapted per
// design/web-agent-work-collapse.md §Conformance fixtures).
for (const file of readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.json')).sort()) {
  const fixture = JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), 'utf-8')) as Fixture
  test(`fixture: ${fixture.name}`, () => {
    assert.deepEqual(serializeRows(projectTimeline(fixtureInput(fixture))), fixture.expected)
  })
}

const buildMessage = (overrides: Partial<ApiMessage> & Pick<ApiMessage, 'client_id'>): ApiMessage => ({
  message_id: overrides.message_id ?? overrides.client_id,
  client_id: overrides.client_id,
  role: overrides.role ?? 'tool',
  display_role: overrides.display_role ?? 'terminal.send',
  content: overrides.content ?? '{"tool":"terminal.send"}',
  created_at: overrides.created_at ?? '2026-08-30T10:00:01.000Z',
  metadata: overrides.metadata ?? { tool: 'terminal.send', turn_id: 'T1' },
})

test('projector reuses row objects when inputs are unchanged', () => {
  const project = createTimelineProjector()
  const user = buildMessage({ client_id: 'u1', role: 'user', display_role: 'You', content: 'hi', metadata: undefined, created_at: '2026-08-30T10:00:00.000Z' })
  const tool = buildMessage({ client_id: 't1' })
  const first = project({ messages: [user, tool], liveTurnId: 'T1' })
  const second = project({ messages: [user, tool], liveTurnId: 'T1' })
  assert.equal(second[0], first[0])
  assert.equal(second[1], first[1])

  // A new streaming reasoning draft rebuilds only the work row.
  const draft = buildMessage({
    client_id: 'r1',
    role: 'reasoning',
    display_role: 'Reasoning',
    content: 'thinking',
    created_at: '2026-08-30T10:00:02.000Z',
    metadata: { turn_id: 'T1', draft: true },
  })
  const third = project({ messages: [user, tool, draft], liveTurnId: 'T1' })
  assert.equal(third[0], first[0])
  assert.notEqual(third[1], first[1])
  assert.equal(third[1].kind, 'work')
  assert.equal(third[1].kind === 'work' ? third[1].currentItem?.client_id : null, 'r1')
})

test('draft→canonical reconciliation keeps the group id and section identity', () => {
  const project = createTimelineProjector()
  const draft = buildMessage({
    client_id: 'r1',
    role: 'reasoning',
    display_role: 'Reasoning',
    content: 'partial',
    metadata: { turn_id: 'T1', draft: true },
  })
  const live = project({ messages: [draft], liveTurnId: 'T1' })
  assert.equal(live[0].kind, 'work')
  const liveRow = live[0]
  assert.equal(liveRow.kind === 'work' ? liveRow.id : null, 'agent-work:T1')

  // Same client_id, canonical row (new message_id, no draft flag).
  const canonical = buildMessage({
    client_id: 'r1',
    message_id: 'persisted-1',
    role: 'reasoning',
    display_role: 'Reasoning',
    content: 'full text',
    metadata: { turn_id: 'T1' },
  })
  const done = project({ messages: [canonical], liveTurnId: null, turnOutcomes: new Map([['T1', 'succeeded']]) })
  assert.equal(done[0].kind, 'work')
  if (done[0].kind === 'work') {
    assert.equal(done[0].id, 'agent-work:T1')
    assert.deepEqual(done[0].sourceClientIds, ['r1'])
    assert.equal(done[0].live, false)
    assert.equal(done[0].currentItem, null)
  }
})

test('a boundary mid-turn flushes; the summary transition is a single row swap', () => {
  const project = createTimelineProjector()
  const tool = buildMessage({ client_id: 't1' })
  const liveRows = project({ messages: [tool], liveTurnId: 'T1' })
  assert.equal(liveRows[0].kind === 'work' ? liveRows[0].live : null, true)

  const final = buildMessage({
    client_id: 'a1',
    role: 'assistant',
    display_role: 'Bud Agent',
    content: 'done',
    created_at: '2026-08-30T10:00:05.000Z',
    metadata: { turn_id: 'T1', segment_kind: 'final' },
  })
  const doneRows = project({ messages: [tool, final], liveTurnId: null })
  assert.equal(doneRows.length, 2)
  assert.equal(doneRows[0].kind === 'work' ? doneRows[0].live : null, false)
  assert.equal(doneRows[0].kind === 'work' ? doneRows[0].status : null, 'ok')
  assert.equal(doneRows[1].kind === 'message' ? doneRows[1].message.client_id : null, 'a1')
})

test('a compaction row stays top-level and splits the turn\'s work around the cut', () => {
  const project = createTimelineProjector()
  const before = buildMessage({ client_id: 't1', created_at: '2026-08-30T10:00:01.000Z' })
  const compaction = buildMessage({
    client_id: 'cmp1',
    role: 'compaction',
    display_role: 'Context compacted',
    content: 'Summary of earlier work.',
    created_at: '2026-08-30T10:00:02.000Z',
    metadata: { artifact_kind: 'context_compaction', model_visible: false, turn_id: 'T1', phase: 'mid_turn' },
  })
  const after = buildMessage({ client_id: 't2', created_at: '2026-08-30T10:00:03.000Z' })
  const rows = project({ messages: [before, compaction, after], liveTurnId: null })
  assert.deepEqual(
    rows.map((row) => (row.kind === 'message' ? `message:${row.message.client_id}` : `work:${row.sourceClientIds.join(',')}`)),
    ['work:t1', 'message:cmp1', 'work:t2'],
  )
})
