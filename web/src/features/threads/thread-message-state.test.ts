import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiAgentState, ApiMessage, ApiMessagePage } from '../../lib/api-types.ts'
import {
  applyAgentStateOverlay,
  buildPendingToolMessageFromToolCall,
  finalizeTurnMessages,
  mergeLatestBootstrapState,
  removeDraftAssistantMessageForTurn,
  removeDraftReasoningMessage,
  reconcileMessagePersistence,
  upsertDraftReasoningMessage,
  upsertMessage,
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

test('reconcileMessagePersistence replaces optimistic rows with canonical messages for server ordering', () => {
  const optimistic = buildMessage({
    client_id: '11111111-1111-4111-8111-111111111111',
    message_id: '11111111-1111-4111-8111-111111111111',
    role: 'user',
    content: 'follow up',
    created_at: '2026-05-19T12:00:00.000Z',
    metadata: { optimistic: true },
  })
  const supersededToolResult = buildMessage({
    client_id: '22222222-2222-4222-8222-222222222222',
    message_id: '22222222-2222-4222-8222-222222222222',
    role: 'tool',
    display_role: 'Tool',
    content: '{}',
    created_at: '2026-05-19T12:00:01.000Z',
    metadata: { tool: 'ask_user_questions', turn_id: 'turn-old' },
  })
  const canonicalUser = buildMessage({
    client_id: '11111111-1111-4111-8111-111111111111',
    message_id: '33333333-3333-4333-8333-333333333333',
    role: 'user',
    content: 'follow up',
    created_at: '2026-05-19T12:00:02.000Z',
    metadata: {},
  })

  const nextMessages = reconcileMessagePersistence(
    [optimistic, supersededToolResult],
    optimistic.client_id,
    canonicalUser.message_id,
    canonicalUser.client_id,
    canonicalUser,
  )

  assert.deepEqual(
    nextMessages.map((message) => message.client_id),
    [supersededToolResult.client_id, canonicalUser.client_id],
  )
  assert.equal(nextMessages[1]?.created_at, canonicalUser.created_at)
  assert.deepEqual(nextMessages[1]?.metadata, {})
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
      started_at: '2026-04-21T10:05:00.000Z',
      args: { input: 'ls\n' },
    },
    draft_assistant: {
      client_id: 'draft-new',
      text: 'working...',
      started_at: '2026-04-21T10:05:01.000Z',
      updated_at: '2026-04-21T10:05:02.000Z',
    },
  })

  const nextMessages = applyAgentStateOverlay([canonicalUser, staleTool, staleDraft], nextState)

  assert.deepEqual(
    nextMessages.map((message) => message.client_id),
    ['user-1', 'tool-new', 'draft-new'],
  )
  assert.equal(nextMessages[1]?.metadata?.turn_id, 'turn-new')
  assert.equal(nextMessages[2]?.content, 'working...')
  assert.equal(nextMessages[2]?.created_at, '2026-04-21T10:05:01.000Z')
  assert.equal(nextMessages[2]?.metadata?.started_at, '2026-04-21T10:05:01.000Z')
})

test('applyAgentStateOverlay builds pending ask_user_questions rows from agent state', () => {
  const nextState = buildAgentState({
    active: true,
    turn_id: 'turn-question',
    phase: 'waiting_for_user',
    pending_tool: {
      client_id: 'question-client',
      call_id: 'call-question',
      name: 'ask_user_questions',
      started_at: '2026-05-19T12:00:00.000Z',
      args: {
        schema: 'ask_user_questions_request_v1',
        request_id: 'qr_test',
        title: 'Deploy',
        questions: [
          {
            question_id: 'env',
            kind: 'single_choice',
            label: 'Environment?',
            skippable: true,
            choices: [{ choice_id: 'staging', label: 'Staging' }],
          },
        ],
      },
    },
  })

  const [message] = applyAgentStateOverlay([], nextState)

  assert.equal(message?.client_id, 'question-client')
  assert.equal(message?.created_at, '2026-05-19T12:00:00.000Z')
  assert.equal(message?.metadata?.tool, 'ask_user_questions')
  assert.equal(message?.metadata?.request_id, 'qr_test')
})

test('applyAgentStateOverlay builds draft reasoning rows from agent state', () => {
  const nextState = buildAgentState({
    active: true,
    turn_id: 'turn-reasoning',
    phase: 'thinking',
    draft_reasoning: [
      {
        client_id: 'reasoning-client',
        text: 'I should inspect the terminal first.',
        llm_call_id: 'llm-call-1',
        index: 0,
        provider: 'ds4',
        provider_model: 'deepseek-v4-flash',
        started_at: '2026-06-05T12:00:00.000Z',
        updated_at: '2026-06-05T12:00:01.000Z',
      },
    ],
  })

  const [message] = applyAgentStateOverlay([], nextState)

  assert.equal(message?.client_id, 'reasoning-client')
  assert.equal(message?.role, 'reasoning')
  assert.equal(message?.display_role, 'Reasoning')
  assert.equal(message?.content, 'I should inspect the terminal first.')
  assert.equal(message?.created_at, '2026-06-05T12:00:00.000Z')
  assert.equal(message?.metadata?.draft, true)
  assert.equal(message?.metadata?.model_visible, false)
  assert.equal(message?.metadata?.llm_call_id, 'llm-call-1')
})

test('buildPendingToolMessageFromToolCall builds pending ask_user_questions rows from live stream events', () => {
  const message = buildPendingToolMessageFromToolCall({
    turnId: 'turn-live-question',
    clientId: 'question-client-live',
    callId: 'call-live-question',
    name: 'ask_user_questions',
    startedAt: '2026-05-19T12:01:00.000Z',
    args: {
      schema: 'ask_user_questions_request_v1',
      request_id: 'qr_live',
      title: 'Release',
      questions: [
        {
          question_id: 'ship',
          kind: 'boolean',
          label: 'Ship it?',
          skippable: true,
        },
      ],
    },
  })

  assert.equal(message.client_id, 'question-client-live')
  assert.equal(message.created_at, '2026-05-19T12:01:00.000Z')
  assert.equal(message.metadata?.tool, 'ask_user_questions')
  assert.equal(message.metadata?.request_id, 'qr_live')
  assert.equal(JSON.parse(message.content).request_id, 'qr_live')
})

test('mergeLatestBootstrapState preserves one pending ask_user_questions row after refresh', () => {
  const existingQuestion = buildMessage({
    client_id: 'question-client',
    message_id: 'question-client',
    role: 'tool',
    display_role: 'ask_user_questions',
    content: '{}',
    created_at: '2026-05-19T12:00:00.000Z',
    metadata: {
      pending: true,
      turn_id: 'turn-question',
      tool: 'ask_user_questions',
      request_id: 'qr_test',
    },
  })
  const canonicalUser = buildMessage({
    client_id: 'user-1',
    message_id: 'user-1',
    content: 'deploy',
    created_at: '2026-05-19T11:59:00.000Z',
  })
  const nextPage: ApiMessagePage = {
    messages: [canonicalUser],
    page: {
      limit: 100,
      returned: 1,
      has_more_before: false,
      has_more_after: false,
      before_cursor: null,
      after_cursor: null,
    },
  }

  const merged = mergeLatestBootstrapState(
    [canonicalUser, existingQuestion],
    {
      limit: 100,
      returned: 2,
      has_more_before: false,
      has_more_after: false,
      before_cursor: null,
      after_cursor: null,
    },
    nextPage,
    buildAgentState({
      active: true,
      turn_id: 'turn-question',
      phase: 'waiting_for_user',
      pending_tool: {
        client_id: 'question-client',
        call_id: 'call-question',
        name: 'ask_user_questions',
        started_at: '2026-05-19T12:00:00.000Z',
        args: {
          schema: 'ask_user_questions_request_v1',
          request_id: 'qr_test',
          questions: [],
        },
      },
    }),
  )

  assert.deepEqual(
    merged.messages.map((message) => message.client_id),
    ['user-1', 'question-client'],
  )
  assert.equal(merged.messages.filter((message) => message.metadata?.request_id === 'qr_test').length, 1)
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

test('reasoning draft rows reconcile to persisted messages and clear on final', () => {
  const draftReasoning = buildMessage({
    client_id: 'reasoning-client',
    message_id: 'reasoning-client',
    role: 'reasoning',
    display_role: 'Reasoning',
    content: 'thinking...',
    created_at: '2026-06-05T12:00:00.000Z',
    metadata: {
      draft: true,
      turn_id: 'turn-1',
      artifact_kind: 'reasoning',
      model_visible: false,
    },
  })
  const persistedReasoning = buildMessage({
    client_id: 'reasoning-client',
    message_id: 'reasoning-message',
    role: 'reasoning',
    display_role: 'Reasoning',
    content: 'I should inspect the terminal first.',
    created_at: '2026-06-05T12:00:01.000Z',
    metadata: {
      artifact_kind: 'reasoning',
      model_visible: false,
      turn_id: 'turn-1',
    },
  })

  const reconciled = upsertMessage(
    removeDraftReasoningMessage([draftReasoning], 'reasoning-client'),
    persistedReasoning,
  )
  assert.deepEqual(reconciled.map((message) => message.client_id), ['reasoning-client'])
  assert.equal(reconciled[0]?.message_id, 'reasoning-message')
  assert.equal(reconciled[0]?.metadata?.draft, undefined)

  const liveDraft = upsertDraftReasoningMessage([], 'reasoning-live', () => ({
    ...draftReasoning,
    client_id: 'reasoning-live',
    message_id: 'reasoning-live',
  }))
  assert.deepEqual(finalizeTurnMessages(liveDraft, 'turn-1', 'succeeded'), [])
})

test('persisted commentary assistant rows survive draft cleanup and turn finalization', () => {
  const draftAssistant = buildMessage({
    client_id: 'assistant-commentary-client',
    message_id: 'assistant-commentary-client',
    role: 'assistant',
    display_role: 'Bud Agent',
    content: 'I will inspect the terminal first.',
    created_at: '2026-05-22T20:00:01.000Z',
    metadata: {
      draft: true,
      turn_id: 'turn-1',
    },
  })
  const commentaryAssistant = buildMessage({
    client_id: 'assistant-commentary-client',
    message_id: 'assistant-commentary-message',
    role: 'assistant',
    display_role: 'Bud Agent',
    content: 'I will inspect the terminal first.',
    created_at: '2026-05-22T20:00:02.000Z',
    metadata: {
      status: 'succeeded',
      turn_id: 'turn-1',
      segment_kind: 'intermediate',
      assistant_phase: 'commentary',
      followed_by_tool_call: true,
    },
  })
  const pendingTool = buildMessage({
    client_id: 'tool-1',
    role: 'tool',
    display_role: 'terminal.observe',
    content: '{}',
    created_at: '2026-05-22T20:00:03.000Z',
    metadata: { pending: true, turn_id: 'turn-1' },
  })
  const finalAssistant = buildMessage({
    client_id: 'assistant-final-client',
    message_id: 'assistant-final-message',
    role: 'assistant',
    display_role: 'Bud Agent',
    content: 'Done.',
    created_at: '2026-05-22T20:00:04.000Z',
    metadata: {
      status: 'succeeded',
      turn_id: 'turn-1',
      segment_kind: 'final',
      assistant_phase: 'final_answer',
    },
  })

  const withPersistedCommentary = upsertMessage(
    removeDraftAssistantMessageForTurn([draftAssistant], 'turn-1'),
    commentaryAssistant,
  )
  const finalized = finalizeTurnMessages(
    [...withPersistedCommentary, pendingTool, finalAssistant],
    'turn-1',
    'succeeded',
  )

  assert.deepEqual(
    finalized.map((message) => message.client_id),
    ['assistant-commentary-client', 'assistant-final-client'],
  )
  assert.equal(finalized[0]?.content, 'I will inspect the terminal first.')
  assert.equal(finalized[0]?.metadata?.assistant_phase, 'commentary')
  assert.equal(finalized[0]?.metadata?.segment_kind, 'intermediate')
  assert.equal(finalized[1]?.metadata?.assistant_phase, 'final_answer')
})
