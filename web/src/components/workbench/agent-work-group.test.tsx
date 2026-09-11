import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { register } from 'node:module'
// Node render tests need CSS stubs and empty defaults for Vite environment reads.
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
const { AgentWorkGroup } = await import('./agent-work-group')
import { projectTimeline, type TimelineWorkRow } from '@/features/threads/agent-work-projection'
import type { ApiMessage } from '@/lib/api-types'

const message = (id: string, role: ApiMessage['role'], content: string, extra = {}): ApiMessage => ({
  message_id: id, client_id: id, role, display_role: role, content,
  created_at: '2026-09-09T10:00:00Z', metadata: { turn_id: 'T', ...extra },
})
const tool = message('tool', 'tool', 'tool result', { tool: 'test_tool' })
const reasoning = message('reason', 'reasoning', 'Current reasoning', { draft: true })
const commentary = message('comment', 'assistant', 'Visible update', { segment_kind: 'intermediate' })
function render(messages: ApiMessage[], live = true, expanded = false, expandedItems = new Set<string>()) {
  const row = projectTimeline({ messages, liveTurnId: live ? 'T' : null })[0] as TimelineWorkRow
  return renderToStaticMarkup(createElement(AgentWorkGroup, {
    row, expanded, expandedItems, onToggle: () => {}, onToggleItem: () => {},
  }))
}

test('live commentary remains visible while preceding activity collapses and current reasoning renders', () => {
  const html = render([tool, commentary, reasoning])
  assert.match(html, /Visible update/)
  assert.match(html, /Current reasoning/)
  assert.doesNotMatch(html, /tool result|Worked for/)
  assert.match(html, /aria-expanded="false"/)
})

test('completed work collapses, then opens commentary and segment summaries', () => {
  assert.doesNotMatch(render([tool, commentary], false), /Visible update|tool result/)
  const opened = render([tool, commentary], false, true)
  assert.match(opened, /Visible update/)
  assert.doesNotMatch(opened, /tool result/)
  assert.match(render([tool, commentary], false, true, new Set(['activity:tool'])), /tool result/)
})

test('no-commentary work reveals useful content on the first expansion', () => {
  const html = render([tool, reasoning], false, true)
  assert.match(html, /tool result/)
  assert.match(html, /Current reasoning/)
  assert.equal((html.match(/<button/g) ?? []).length, 1)
})

test('an external streaming assistant closes the live activity segment without collapsing all work', () => {
  const draft = message('answer', 'assistant', 'Final tokens', { draft: true })
  const html = render([tool, draft])
  assert.doesNotMatch(html, /tool result|Worked/)
  assert.match(html, /aria-expanded="false"/)
})

test('parallel unfinished tools remain discoverable after commentary', () => {
  const running = { ...tool, metadata: { ...tool.metadata, pending: true } }
  const html = render([running, commentary, reasoning])
  assert.match(html, /1 running/)
  assert.match(html, /Visible update/)
})

test('empty commentary does not add an activity disclosure', () => {
  const html = render([tool, { ...commentary, content: ' ' }, reasoning])
  assert.match(html, /tool result/)
  assert.doesNotMatch(html, /<button/)
})

const { ChatTimeline } = await import('./chat-timeline')
const { AuthSessionContext } = await import('@/contexts/auth-session-context')
test('timeline keeps commentary visible while progress waits for its client-side grace period', () => {
  for (const visible of [true, false]) {
    const html = renderToStaticMarkup(createElement(AuthSessionContext.Provider, {
      value: { currentUser: null, isAuthenticated: true, setCurrentUser: () => {} },
    }, createElement(ChatTimeline, {
      messages: [tool, commentary], liveTurnId: 'T', activityIndicatorVisible: visible,
    })))
    assert.equal(html.includes('lucide-loader-circle'), false)
    assert.match(html, /Visible update/)
  }
})
