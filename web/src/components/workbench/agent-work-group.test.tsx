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

const message = (id: string, role: ApiMessage['role'], content: string, extra: Record<string, unknown> = {}): ApiMessage => ({
  message_id: id, client_id: id, role, display_role: role, content,
  tool_payload: role === 'tool' && extra.tool ? { tool: extra.tool } : null,
  created_at: '2026-09-09T10:00:00Z', metadata: { turn_id: 'T', ...extra },
})
const tool = message('tool', 'tool', 'tool result', { tool: 'test_tool' })
const reasoning = message('reason', 'reasoning', 'Current reasoning', { draft: true })
const commentary = message('comment', 'assistant', 'Visible update', { segment_kind: 'intermediate' })
function render(messages: ApiMessage[], live = true, expanded = false, expandedItems = new Set<string>()) {
  const final = message('final', 'assistant', 'Answer', { segment_kind: 'final' })
  const row = projectTimeline({ messages: live ? messages : [...messages, final], liveTurnId: live ? 'T' : null })[0] as TimelineWorkRow
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
  assert.match(render([tool, commentary], false, true, new Set(['activity:tool', 'item:tool'])), /tool result/)
})

test('reasoning disclosure titles remove Markdown decoration for live and completed items', () => {
  for (const title of ['**Browsing Hacker News**', '## __Browsing Hacker News__', '*Browsing Hacker News*', '`Browsing Hacker News`', 'Browsing Hacker News']) {
    const item = message('reason', 'reasoning', `\n${title}\n\nReasoning body`)
    for (const html of [render([item]), render([item], false, true)]) {
      assert.match(html, />Browsing Hacker News<\/span>/)
      assert.doesNotMatch(html, /\*\*|__|Reasoning body/)
    }
  }
})

test('completed activity summaries describe membership instead of the last action', () => {
  const items = [reasoning, message('r2', 'reasoning', 'Last reasoning'), tool,
    message('t2', 'tool', '', { tool: 'browser_act' }), message('t3', 'tool', '', { tool: 'browser_observe' })]
  const completed = render([...items, commentary], false, true)
  assert.match(completed, /2 reasoning steps and 3 tool calls/)
  assert.doesNotMatch(completed, /browser_observe|Last reasoning|5 activities/)
  assert.match(render([...items, commentary]), /lucide-globe/)
  assert.match(render([reasoning, commentary], false, true), /1 reasoning step<\/span>/)
  assert.match(render([tool, commentary], false, true), /1 tool call<\/span>/)
})

test('no-commentary work reveals compact rows without mounting full details', () => {
  const html = render([tool, reasoning], false, true)
  assert.doesNotMatch(html, /tool result|data-work-detail/)
  assert.match(html, /Current reasoning/)
  assert.equal((html.match(/<button/g) ?? []).length, 3)
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
  assert.doesNotMatch(html, /tool result|data-work-detail/)
  assert.equal((html.match(/data-activity-section=/g) ?? []).length, 1)
})

const { ChatTimeline } = await import('./chat-timeline')
const { AuthSessionContext } = await import('@/contexts/auth-session-context')
test('timeline reserves eligible progress immediately without showing the spinner during grace', () => {
  for (const visible of [true, false]) {
    const html = renderToStaticMarkup(createElement(AuthSessionContext.Provider, {
      value: { currentUser: null, isAuthenticated: true, setCurrentUser: () => {} },
    }, createElement(ChatTimeline, {
      messages: [tool, commentary], liveTurnId: 'T', activityIndicatorVisible: visible,
    })))
    assert.equal(html.includes('data-response-slot'), visible)
    assert.equal(html.includes('lucide-loader-circle'), false)
    assert.match(html, /Visible update/)
  }
})


test('fifty live calls mount one collapsed header and zero details', () => {
  const calls = Array.from({ length: 50 }, (_, index) => message(`t${index}`, 'tool', 'SECRET LARGE RESULT', { tool: 'test_tool' }))
  const html = render(calls)
  assert.equal((html.match(/data-activity-section=/g) ?? []).length, 1)
  assert.equal((html.match(/<button/g) ?? []).length, 1)
  assert.match(html, /50 activities/)
  assert.doesNotMatch(html, /SECRET LARGE RESULT|data-work-detail/)
})

test('inactive work without final remains inspectable without an outer fold', () => {
  const row = projectTimeline({ messages: [tool, commentary], liveTurnId: null })[0] as TimelineWorkRow
  const html = renderToStaticMarkup(createElement(AgentWorkGroup, { row, expanded: false, expandedItems: new Set(), onToggle: () => {}, onToggleItem: () => {} }))
  assert.match(html, /Visible update/)
  assert.doesNotMatch(html, /Worked/)
})

test('spinner reserves space, reveals on working or 500 ms, and cancels hidden fallback', async (t) => {
  const { act, create } = await import('react-test-renderer')
  const { ThinkingIndicator } = await import('./thinking-indicator')
  const previousWindow = globalThis.window
  const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousAct = actGlobal.IS_REACT_ACT_ENVIRONMENT
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.window = globalThis as unknown as Window & typeof globalThis
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let root: ReturnType<typeof create> | undefined
  try {
    await act(() => { root = create(createElement(ThinkingIndicator, { isVisible: true })) })
    const statuses = () => root!.root.findAllByProps({ role: 'status' }).length
    assert.equal(root!.root.findAllByProps({ 'data-response-slot': true }).length, 1)
    assert.equal(statuses(), 0)
    await act(() => t.mock.timers.tick(499))
    assert.equal(statuses(), 0)
    await act(() => t.mock.timers.tick(1))
    assert.equal(statuses(), 1)
    await act(() => root!.update(createElement(ThinkingIndicator, { isVisible: false })))
    await act(() => root!.update(createElement(ThinkingIndicator, { isVisible: true })))
    assert.equal(statuses(), 0)
    await act(() => root!.update(createElement(ThinkingIndicator, { isVisible: true, workStarted: true })))
    assert.equal(statuses(), 1)
    await act(() => root!.update(createElement(ThinkingIndicator, { isVisible: false, workStarted: true })))
    await act(() => t.mock.timers.tick(500))
    assert.equal(statuses(), 0)
    await act(() => root!.update(createElement(ThinkingIndicator, { isVisible: true, workStarted: true })))
    assert.equal(statuses(), 1)
  } finally {
    await act(() => root?.unmount())
    t.mock.timers.reset()
    globalThis.window = previousWindow
    actGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct
  }
})


test('compact tool rows show structured tool identity and command, including pending calls', () => {
  const browser = { ...tool, display_role: 'Tool', content: 'Browser operation completed.',
    tool_payload: { tool: 'browser_exec', result: 'private output' }, metadata: { turn_id: 'T' } }
  assert.match(render([browser]), /lucide-globe/)
  assert.doesNotMatch(render([browser]), /private output/)
  const terminal = { ...browser, tool_payload: { tool: 'terminal.run', command: 'pwd' },
    metadata: { turn_id: 'T', pending: true } }
  assert.match(render([terminal]), /terminal.run · pwd/)
  assert.match(render([terminal]), /1 running/)
  const historical = { ...browser, tool_payload: null, content: 'Historical output' }
  const html = render([historical], false, true, new Set(['item:tool']))
  assert.match(html, /Historical output/)
  assert.doesNotMatch(html, /Show payload/)
})

test('grouped generic and specialized tools disclose full payload only on request', async () => {
  const { act, create } = await import('react-test-renderer')
  const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousAct = actGlobal.IS_REACT_ACT_ENVIRONMENT
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true
  try {
    for (const toolName of ['browser_exec', 'terminal.run']) {
      let formats = 0
      const payload = { tool: toolName, command: 'pwd', output: 'terminal output',
        result: { nested: 'full payload value' }, toJSON() { formats++; return { tool: toolName, result: this.result } } }
      const item = { ...tool, content: 'Operation completed.', tool_payload: payload }
      const row = projectTimeline({ messages: [item], liveTurnId: 'T' })[0] as TimelineWorkRow
      let root: ReturnType<typeof create> | undefined
      try {
        await act(() => { root = create(createElement(AgentWorkGroup, {
          row, expanded: true, expandedItems: new Set(['activity:tool', 'item:tool']),
          onToggle: () => {}, onToggleItem: () => {},
        })) })
        assert.equal(formats, 0)
        assert.doesNotMatch(JSON.stringify(root!.toJSON()), /full payload value/)
        const toggle = () => root!.root.findAllByType('button').find(button => button.children.includes('Show payload') || button.children.includes('Hide payload'))!
        await act(() => toggle().props.onClick())
        assert.equal(toggle().props['aria-expanded'], true)
        assert.match(JSON.stringify(root!.toJSON()), /full payload value/)
        assert.ok(formats > 0)
        await act(() => toggle().props.onClick())
        assert.doesNotMatch(JSON.stringify(root!.toJSON()), /full payload value/)
      } finally {
        await act(() => root?.unmount())
      }
    }
  } finally {
    actGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct
  }
})


test('browser intent uses a globe with tool identity and fenced code in expanded details', () => {
  const args = { summary: 'Find the pricing page', code: 'await browser.tabs.list()' }
  for (const payload of [{ tool: 'browser_exec', ...args }, { tool: 'browser_exec', args, summary: 'Browser outcome is unknown.' }]) {
    const item = { ...tool, tool_payload: payload }
    assert.match(render([item]), /lucide-globe/)
    assert.match(render([item]), /Find the pricing page/)
    assert.doesNotMatch(render([item]), /browser_exec/)
    const opened = render([item], false, true, new Set(['item:tool']))
    assert.match(opened, /browser_exec/)
    assert.match(opened, /Find the pricing page/)
    assert.match(opened, /data-language="javascript"/)
    assert.match(opened, /await browser.tabs.list/)
    assert.match(opened, /Show payload/)
    assert.doesNotMatch(render([item]), /await browser.tabs.list/)
  }
})


test('browser code containing Markdown fences stays inside a code block', () => {
  const item = { ...tool, tool_payload: { tool: 'browser_exec', args: {
    summary: 'Inspect page text', code: '// ```\n// # Not a heading\nconsole.log("```")',
  } } }
  const html = render([item], false, true, new Set(['item:tool']))
  assert.match(html, /Not a heading/)
  assert.doesNotMatch(html, /<h1/)
  assert.match(html, /data-language="javascript"/)
})
