import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { register } from 'node:module'
import type { ApiAgentState, ApiMessagePage } from '../../lib/api-types'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { useThreadMessages } = await import('./use-thread-messages')
const state: ApiAgentState = { active: false, turn_id: null, phase: 'idle', pending_tool: null,
  draft_assistant: null, can_cancel: false, stream_cursor: null, updated_at: '' }
const initial: ApiMessagePage = { messages: [], page: { limit: 100, returned: 0,
  before_cursor: 'obsolete', after_cursor: null, has_more_before: true, has_more_after: false } }
const ignore = () => {}
const authorized = () => false

test('pending inventory clears protected prompts without discarding live work; obsolete cursor resets pagination', async () => {
  let store!: ReturnType<typeof useThreadMessages>
  function Harness() {
    store = useThreadMessages({ initialMessagePage: initial, initialAgentState: state,
      threadId: 'A', onError: ignore, shouldAbortForUnauthorized: authorized })
    return null
  }
  let view!: ReactTestRenderer
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async url => {
    requests.push(String(url))
    return requests.length === 1 ? Response.json({ error: 'invalid_message_cursor' }, { status: 400 }) :
      Response.json({ transcript: { ...initial, page: { ...initial.page, before_cursor: 'v2' } }, agent_state: state, stream_cursor: 'do-not-adopt' })
  }
  try {
    await act(async () => { view = create(createElement(Harness)) })
    await act(async () => {
      store.applyToolCall({ turnId: 'T', clientId: 'question', callId: 'q', name: 'ask_user_questions' })
      store.applyToolCall({ turnId: 'T', clientId: 'browser', callId: 'b', name: 'browser_exec' })
      store.applyAssistantMessageDelta({ turnId: 'T', clientId: 'draft', delta: 'Working' })
      store.applyPendingRequests({ ...state, pending_questions: [] })
    })
    assert.deepEqual(store.messages.map(row => row.client_id).sort(), ['browser', 'draft'])
    await act(async () => store.mergeLatestBootstrap(initial, state))
    assert.equal(store.messages.some(row => row.client_id === 'question'), false)
    await act(async () => store.loadOlderMessages())
    assert.match(requests[0], /before=obsolete/)
    assert.match(requests[1], /\/open\?limit=100$/)
    assert.equal(store.messagePage.before_cursor, 'v2')
    assert.deepEqual(store.messages.map(row => row.client_id).sort(), ['browser', 'draft'])
    assert.equal(store.olderMessagesLoadFailed, false)
  } finally {
    await act(async () => view?.unmount())
    globalThis.fetch = original
  }
})
