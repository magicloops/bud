import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiAgentState, ApiMessage, ApiMessagePage } from '../../lib/api-types.ts'
import {
  applyAgentStateOverlay,
  finalizeTurnMessages,
  mergeLatestBootstrapState,
  reconcileMessagePersistence,
} from './thread-message-state.ts'

const buildMessage = (overrides: Partial<ApiMessage> & Pick<ApiMessage, 'client_id'>): ApiMessage => ({
  message_id: overrides.message_id ?? overrides.client_id,
  client_id: overrides.client_id,
  role: overrides.role ?? 'user',
  display_role: overrides.display_role ?? 'User',
  content: overrides.content ?? '',
  created_at: overrides.created_at ?? '2026-04-21T10:00:00.000Z',
  metadata: overrides.metadata,
})

const buildAgentState = (overrides: Partial<ApiAgentState> = {}): ApiAgentState => ({
  active: false,
  turn_id: null,
  phase: 'idle',
  can_cancel: false,
  stream_cursor: 'cursor-0',
  pending_tool: null,
  draft_assistant: null,
  updated_at: '2026-04-21T10:05:00.000Z',
  ...overrides,
})

test('reconcileMessagePersistence swaps ids and removes only the optimistic metadata flag', () => {
  const optimistic = buildMessage({
    client_id: 'temp-1',
    message_id: 'temp-1',
    metadata: {
      optimistic: true,
      preserved: 'yes',
    },
    content: 'hello',
  })

  const [reconciled] = reconcileMessagePersistence([optimistic], 'temp-1', 'msg-1', 'client-1')

  assert.equal(reconciled.message_id, 'msg-1')
  assert.equal(reconciled.client_id, 'client-1')
  assert.deepEqual(reconciled.metadata, { preserved: 'yes' })
})

test('applyAgentStateOverlay replaces stale synthetic rows with the current pending tool and draft assistant', () => {
  const canonicalUser = buildMessage({
    client_id: 'user-1',
    content: 'run the command',
    created_at: '2026-04-21T10:00:00.000Z',
  })
  const staleTool = buildMessage({
    client_id: 'old-tool',
    message_id: 'old-tool',
    role: 'tool',
    display_role: 'terminal.send',
    content: '{}',
    created_at: '2026-04-21T10:00:01.000Z',
    metadata: { pending: true, turn_id: 'turn-old' },
  })
  const staleDraft = buildMessage({
    client_id: 'old-draft',
    message_id: 'old-draft',
    role: 'assistant',
    display_role: 'Bud Agent',
    content: 'old draft',
    created_at: '2026-04-21T10:00:02.000Z',
    metadata: { draft: true, turn_id: 'turn-old' },
  })

  const nextState = buildAgentState({
    active: true,
    turn_id: 'turn-new',
    phase: 'tool_running',
    pending_tool: {
      client_id: 'tool-new',
      call_id: 'call-1',
      name: 'terminal.send',
      args: { input: 'ls\n' },
    },
    draft_assistant: {
      client_id: 'draft-new',
      text: 'working...',
      updated_at: '2026-04-21T10:05:01.000Z',
    },
  })

  const nextMessages = applyAgentStateOverlay([canonicalUser, staleTool, staleDraft], nextState)

  assert.deepEqual(
    nextMessages.map((message) => message.client_id),
    ['user-1', 'tool-new', 'draft-new'],
  )
  assert.equal(nextMessages[1]?.metadata?.turn_id, 'turn-new')
  assert.equal(nextMessages[2]?.content, 'working...')
})

test('mergeLatestBootstrapState preserves older canonical history and earlier pagination cursors', () => {
  const olderLoaded = buildMessage({
    client_id: 'older-1',
    message_id: 'older-1',
    content: 'older context',
    created_at: '2026-04-21T09:55:00.000Z',
  })
  const latestCanonical = buildMessage({
    client_id: 'latest-1',
    message_id: 'latest-1',
    content: 'latest user message',
    created_at: '2026-04-21T10:00:00.000Z',
  })
  const syntheticDraft = buildMessage({
    client_id: 'draft-temp',
    role: 'assistant',
    display_role: 'Bud Agent',
    content: 'draft',
    created_at: '2026-04-21T10:00:01.000Z',
    metadata: { draft: true, turn_id: 'turn-1' },
  })

  const currentPage: ApiMessagePage['page'] = {
    limit: 100,
    returned: 3,
    has_more_before: true,
    has_more_after: false,
    before_cursor: 'before-oldest',
    after_cursor: null,
  }

  const nextPage: ApiMessagePage = {
    messages: [
      latestCanonical,
      buildMessage({
        client_id: 'latest-2',
        message_id: 'latest-2',
        role: 'assistant',
        display_role: 'Bud Agent',
        content: 'canonical assistant',
        created_at: '2026-04-21T10:00:02.000Z',
      }),
    ],
    page: {
      limit: 100,
      returned: 2,
      has_more_before: false,
      has_more_after: false,
      before_cursor: 'before-latest-window',
      after_cursor: null,
    },
  }

  const merged = mergeLatestBootstrapState(
    [olderLoaded, latestCanonical, syntheticDraft],
    currentPage,
    nextPage,
    buildAgentState(),
  )

  assert.deepEqual(
    merged.messages.map((message) => message.client_id),
    ['older-1', 'latest-1', 'latest-2'],
  )
  assert.equal(merged.page.before_cursor, 'before-oldest')
  assert.equal(merged.page.has_more_before, true)
  assert.equal(merged.page.returned, 3)
})

test('finalizeTurnMessages removes pending tool rows and only drops draft assistant text on failed turns', () => {
  const pendingTool = buildMessage({
    client_id: 'tool-1',
    role: 'tool',
    display_role: 'terminal.send',
    content: '{}',
    created_at: '2026-04-21T10:00:00.000Z',
    metadata: { pending: true, turn_id: 'turn-1' },
  })
  const draftAssistant = buildMessage({
    client_id: 'draft-1',
    role: 'assistant',
    display_role: 'Bud Agent',
    content: 'streaming',
    created_at: '2026-04-21T10:00:01.000Z',
    metadata: { draft: true, turn_id: 'turn-1' },
  })
  const persistedAssistant = buildMessage({
    client_id: 'assistant-1',
    message_id: 'assistant-1',
    role: 'assistant',
    display_role: 'Bud Agent',
    content: 'done',
    created_at: '2026-04-21T10:00:02.000Z',
  })

  const failedTurnMessages = finalizeTurnMessages(
    [pendingTool, draftAssistant, persistedAssistant],
    'turn-1',
    'failed',
  )
  const succeededTurnMessages = finalizeTurnMessages(
    [pendingTool, draftAssistant, persistedAssistant],
    'turn-1',
    'succeeded',
  )

  assert.deepEqual(failedTurnMessages.map((message) => message.client_id), ['assistant-1'])
  assert.deepEqual(
    succeededTurnMessages.map((message) => message.client_id),
    ['draft-1', 'assistant-1'],
  )
})
