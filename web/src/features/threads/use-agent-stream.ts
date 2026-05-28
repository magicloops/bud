import { useCallback, useEffect, useRef } from 'react'
import { createAuthEventSource } from '@/lib/transport'
import { isAuthRedirectPending } from '@/lib/auth-redirect'
import type {
  ApiAgentCompactionDoneEvent,
  ApiAgentCompactionFailedEvent,
  ApiAgentCompactionStartEvent,
  ApiAgentState,
  ApiMessage,
} from '@/lib/api-types'
import {
  getThreadStreamHeartbeatConfig,
  getThreadStreamReconnectDelay,
  hasMissedThreadStreamHeartbeat,
} from '@/features/threads/thread-stream-timing'
import { getAgentStreamErrorRecoveryAction } from './agent-stream-recovery'

type AgentToolCallEvent = {
  turn_id: string
  client_id: string
  call_id: string
  name: string
  args?: Record<string, unknown>
  started_at?: string
}

type AgentToolResultEvent = {
  turn_id: string
  client_id: string
  call_id: string
  message_id?: string
  name: string
  started_at?: string
  finished_at?: string
  duration_ms?: number
  message?: ApiMessage
}

type AgentMessageStartEvent = {
  turn_id: string
  client_id: string
}

type AgentMessageDeltaEvent = {
  turn_id: string
  client_id: string
  delta: string
}

type AgentMessageDoneEvent = {
  turn_id: string
  client_id: string
  text: string
}

type AgentMessageEvent = {
  turn_id: string
  client_id: string
  message_id: string
  text: string
  message?: ApiMessage
}

type AgentFinalEvent = {
  turn_id: string
  status: 'succeeded' | 'failed' | 'canceled'
  message_id?: string
  text?: string
  error?: string
}

type AgentResyncRequiredEvent = {
  error: 'resync_required'
  provided_cursor?: string
}

type ThreadTitleEvent = {
  thread_id: string
  title: string
  source: 'generated_first_user_message'
  updated_at: string
}

type UseAgentStreamArgs = {
  threadId: string | null
  initialStreamCursor: string | null
  onStatusChange: (status: 'idle' | 'streaming' | 'waiting_for_user') => void
  onError: (message: string | null) => void
  onToolCall: (event: {
    turnId: string
    clientId: string
    callId: string
    name: string
    args?: Record<string, unknown>
    startedAt?: string
  }) => void
  onToolResultMessage: (message: ApiMessage) => void
  onAssistantMessageStart: (event: { turnId: string; clientId: string }) => void
  onAssistantMessageDelta: (event: { turnId: string; clientId: string; delta: string }) => void
  onAssistantMessageDone: (event: { turnId: string; clientId: string; text: string }) => void
  onAssistantMessageEvent: (event: {
    turnId: string
    clientId: string
    messageId: string
    text: string
    message?: ApiMessage
  }) => void
  onCompactionStart?: (event: ApiAgentCompactionStartEvent) => void
  onCompactionDone?: (event: ApiAgentCompactionDoneEvent) => void
  onCompactionFailed?: (event: ApiAgentCompactionFailedEvent) => void
  onThreadTitle: (title: string) => void
  onFinalizeTurn: (turnId: string, status: 'succeeded' | 'failed' | 'canceled') => void
  refreshBootstrap: (threadId: string) => Promise<ApiAgentState>
}

export function useAgentStream({
  threadId,
  initialStreamCursor,
  onStatusChange,
  onError,
  onToolCall,
  onToolResultMessage,
  onAssistantMessageStart,
  onAssistantMessageDelta,
  onAssistantMessageDone,
  onAssistantMessageEvent,
  onCompactionStart,
  onCompactionDone,
  onCompactionFailed,
  onThreadTitle,
  onFinalizeTurn,
  refreshBootstrap,
}: UseAgentStreamArgs) {
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recoveryInFlightRef = useRef(false)
  const recoveryEpochRef = useRef(0)
  const reconnectAttemptRef = useRef(0)
  const lastEventTimeRef = useRef<number>(Date.now())
  const cursorRef = useRef<string | null>(initialStreamCursor)
  const threadIdRef = useRef<string | null>(null)
  const callbacksRef = useRef({
    onStatusChange,
    onError,
    onToolCall,
    onToolResultMessage,
    onAssistantMessageStart,
    onAssistantMessageDelta,
    onAssistantMessageDone,
    onAssistantMessageEvent,
    onCompactionStart,
    onCompactionDone,
    onCompactionFailed,
    onThreadTitle,
    onFinalizeTurn,
    refreshBootstrap,
  })

  useEffect(() => {
    callbacksRef.current = {
      onStatusChange,
      onError,
      onToolCall,
      onToolResultMessage,
      onAssistantMessageStart,
      onAssistantMessageDelta,
      onAssistantMessageDone,
      onAssistantMessageEvent,
      onCompactionStart,
      onCompactionDone,
      onCompactionFailed,
      onThreadTitle,
      onFinalizeTurn,
      refreshBootstrap,
    }
  }, [
    onAssistantMessageDelta,
    onAssistantMessageDone,
    onAssistantMessageEvent,
    onAssistantMessageStart,
    onCompactionDone,
    onCompactionFailed,
    onCompactionStart,
    onError,
    onFinalizeTurn,
    onStatusChange,
    onThreadTitle,
    onToolCall,
    onToolResultMessage,
    refreshBootstrap,
  ])

  useEffect(() => {
    cursorRef.current = initialStreamCursor
  }, [initialStreamCursor])

  const connectAgentStream = useCallback((agentThreadId: string) => {
    threadIdRef.current = agentThreadId
    const resumeSuffix = cursorRef.current ? `?after=${encodeURIComponent(cursorRef.current)}` : ''

    const agentStream = createAuthEventSource(`/api/threads/${agentThreadId}/agent/stream${resumeSuffix}`)
    const source = agentStream.source
    eventSourceRef.current = source

    let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null
    let suppressErrorReconnect = false

    const cleanupAgent = () => {
      if (heartbeatCheckInterval) {
        clearInterval(heartbeatCheckInterval)
        heartbeatCheckInterval = null
      }
      source.close()
      if (eventSourceRef.current === source) {
        eventSourceRef.current = null
      }
    }

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }

    const clearRecoveryTimer = () => {
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = null
      }
    }

    const recoverBootstrap = (reason: string, providedCursor?: string | null) => {
      if (isAuthRedirectPending()) {
        cleanupAgent()
        return
      }
      if (recoveryInFlightRef.current) {
        return
      }

      clearReconnectTimer()
      clearRecoveryTimer()
      cleanupAgent()

      const staleCursor = providedCursor ?? cursorRef.current
      cursorRef.current = null
      recoveryInFlightRef.current = true
      const recoveryEpoch = recoveryEpochRef.current + 1
      recoveryEpochRef.current = recoveryEpoch
      console.warn('[agent-sse] bootstrap recovery started', {
        threadId: agentThreadId,
        reason,
        staleCursor,
      })

      void callbacksRef.current.refreshBootstrap(agentThreadId)
        .then((nextAgentState) => {
          if (recoveryEpochRef.current !== recoveryEpoch) {
            return
          }
          recoveryInFlightRef.current = false
          cursorRef.current = nextAgentState.stream_cursor
          reconnectAttemptRef.current = 0
          callbacksRef.current.onError(null)
          console.warn('[agent-sse] bootstrap recovery succeeded', {
            threadId: agentThreadId,
            reason,
            nextCursor: nextAgentState.stream_cursor,
          })
          if (threadIdRef.current === agentThreadId && !isAuthRedirectPending()) {
            connectAgentStream(agentThreadId)
          }
        })
        .catch((error) => {
          if (recoveryEpochRef.current !== recoveryEpoch) {
            return
          }
          recoveryInFlightRef.current = false
          if (isAuthRedirectPending() || threadIdRef.current !== agentThreadId) {
            return
          }

          console.error('[agent-sse] bootstrap recovery failed', {
            threadId: agentThreadId,
            reason,
            error,
          })
          callbacksRef.current.onError(error instanceof Error ? error.message : 'Failed to resync thread')

          const nextAttempt = reconnectAttemptRef.current + 1
          reconnectAttemptRef.current = nextAttempt
          const delay = getThreadStreamReconnectDelay(nextAttempt)
          recoveryTimerRef.current = setTimeout(() => {
            recoveryTimerRef.current = null
            if (threadIdRef.current === agentThreadId && !isAuthRedirectPending()) {
              recoverBootstrap(`${reason}_retry`)
            }
          }, delay)
        })
    }

    const scheduleReconnect = (reason: string) => {
      if (isAuthRedirectPending()) {
        cleanupAgent()
        return
      }
      if (reconnectTimerRef.current) {
        return
      }

      clearRecoveryTimer()
      cleanupAgent()
      const nextAttempt = reconnectAttemptRef.current + 1
      reconnectAttemptRef.current = nextAttempt
      const delay = getThreadStreamReconnectDelay(nextAttempt)
      console.warn('[agent-sse] reconnecting', { threadId: agentThreadId, reason, attempt: nextAttempt, delay })
      clearReconnectTimer()
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        if (threadIdRef.current && !isAuthRedirectPending()) {
          connectAgentStream(threadIdRef.current)
        }
      }, delay)
    }

    source.addEventListener('open', () => {
      if (heartbeatCheckInterval) {
        clearInterval(heartbeatCheckInterval)
        heartbeatCheckInterval = null
      }
      if (reconnectTimerRef.current) {
        clearReconnectTimer()
      }

      reconnectAttemptRef.current = 0
      lastEventTimeRef.current = Date.now()

      const { heartbeatTimeoutMs, checkIntervalMs } = getThreadStreamHeartbeatConfig(import.meta.env.DEV)
      heartbeatCheckInterval = setInterval(() => {
        if (source.readyState !== EventSource.OPEN) {
          return
        }

        if (hasMissedThreadStreamHeartbeat(lastEventTimeRef.current, Date.now(), heartbeatTimeoutMs)) {
          console.warn(`[agent-sse] no heartbeat for ${heartbeatTimeoutMs / 1000}s, connection stale`)
          scheduleReconnect('heartbeat_timeout')
        }
      }, checkIntervalMs)
    })

    source.addEventListener('heartbeat', () => {
      lastEventTimeRef.current = Date.now()
    })

    source.addEventListener('agent.tool_call', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      try {
        const data = JSON.parse(evt.data) as AgentToolCallEvent
        callbacksRef.current.onStatusChange(
          data.name === 'ask_user_questions' ? 'waiting_for_user' : 'streaming',
        )
        callbacksRef.current.onToolCall({
          turnId: data.turn_id,
          clientId: data.client_id,
          callId: data.call_id,
          name: data.name,
          args: data.args,
          startedAt: data.started_at,
        })
      } catch (error) {
        console.warn('[agent-sse] failed to parse tool_call', error)
      }
    })

    source.addEventListener('agent.tool_result', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      try {
        const data = JSON.parse(evt.data) as AgentToolResultEvent
        if (data.message) {
          callbacksRef.current.onToolResultMessage(data.message)
        }
      } catch (error) {
        console.warn('[agent-sse] failed to parse agent.tool_result', error)
      }
    })

    source.addEventListener('agent.message_start', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      callbacksRef.current.onStatusChange('streaming')
      try {
        const data = JSON.parse(evt.data) as AgentMessageStartEvent
        callbacksRef.current.onAssistantMessageStart({ turnId: data.turn_id, clientId: data.client_id })
      } catch (error) {
        console.warn('[agent-sse] failed to parse agent.message_start', error)
      }
    })

    source.addEventListener('agent.message_delta', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      callbacksRef.current.onStatusChange('streaming')
      try {
        const data = JSON.parse(evt.data) as AgentMessageDeltaEvent
        callbacksRef.current.onAssistantMessageDelta({
          turnId: data.turn_id,
          clientId: data.client_id,
          delta: data.delta,
        })
      } catch (error) {
        console.warn('[agent-sse] failed to parse agent.message_delta', error)
      }
    })

    source.addEventListener('agent.message_done', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      try {
        const data = JSON.parse(evt.data) as AgentMessageDoneEvent
        callbacksRef.current.onAssistantMessageDone({
          turnId: data.turn_id,
          clientId: data.client_id,
          text: data.text,
        })
      } catch (error) {
        console.warn('[agent-sse] failed to parse agent.message_done', error)
      }
    })

    source.addEventListener('agent.message', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      try {
        const data = JSON.parse(evt.data) as AgentMessageEvent
        callbacksRef.current.onAssistantMessageEvent({
          turnId: data.turn_id,
          clientId: data.client_id,
          messageId: data.message_id,
          text: data.text,
          message: data.message,
        })
      } catch (error) {
        console.warn('[agent-sse] failed to parse agent.message', error)
      }
    })

    source.addEventListener('agent.compaction_start', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      callbacksRef.current.onStatusChange('streaming')
      try {
        const data = JSON.parse(evt.data) as ApiAgentCompactionStartEvent
        callbacksRef.current.onCompactionStart?.(data)
      } catch (error) {
        console.warn('[agent-sse] failed to parse agent.compaction_start', error)
      }
    })

    source.addEventListener('agent.compaction_done', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      callbacksRef.current.onStatusChange('streaming')
      try {
        const data = JSON.parse(evt.data) as ApiAgentCompactionDoneEvent
        callbacksRef.current.onCompactionDone?.(data)
      } catch (error) {
        console.warn('[agent-sse] failed to parse agent.compaction_done', error)
      }
    })

    source.addEventListener('agent.compaction_failed', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      callbacksRef.current.onStatusChange('streaming')
      try {
        const data = JSON.parse(evt.data) as ApiAgentCompactionFailedEvent
        callbacksRef.current.onCompactionFailed?.(data)
      } catch (error) {
        console.warn('[agent-sse] failed to parse agent.compaction_failed', error)
      }
    })

    source.addEventListener('thread.title', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      try {
        const data = JSON.parse(evt.data) as ThreadTitleEvent
        callbacksRef.current.onThreadTitle(data.title)
      } catch (error) {
        console.warn('[agent-sse] failed to parse thread.title', error)
      }
    })

    source.addEventListener('agent.resync_required', (evt) => {
      if (threadIdRef.current !== agentThreadId || eventSourceRef.current !== source) {
        return
      }

      lastEventTimeRef.current = Date.now()
      suppressErrorReconnect = true

      let payload: AgentResyncRequiredEvent | null = null
      try {
        payload = JSON.parse(evt.data) as AgentResyncRequiredEvent
      } catch (error) {
        console.warn('[agent-sse] failed to parse resync event', error)
      }

      console.warn('[agent-sse] explicit resync required', {
        threadId: agentThreadId,
        payload,
      })

      recoverBootstrap('explicit_resync', payload?.provided_cursor)
    })

    source.addEventListener('final', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      let finalEvent: AgentFinalEvent | null = null
      try {
        finalEvent = JSON.parse(evt.data) as AgentFinalEvent
      } catch (error) {
        console.warn('[agent-sse] failed to parse final event', error)
      }
      if (reconnectTimerRef.current) {
        clearReconnectTimer()
      }
      callbacksRef.current.onStatusChange('idle')
      if (finalEvent?.turn_id) {
        callbacksRef.current.onFinalizeTurn(finalEvent.turn_id, finalEvent.status)
      }
      if (finalEvent?.status === 'failed') {
        callbacksRef.current.onError(finalEvent.error ?? 'Agent turn failed')
      } else {
        callbacksRef.current.onError(null)
      }
    })

    source.addEventListener('error', (evt) => {
      void agentStream.checkUnauthorized().then((unauthorized) => {
        console.warn('[agent-sse] error', { readyState: source.readyState, evt })
        const recoveryAction = getAgentStreamErrorRecoveryAction({
          unauthorized,
          authRedirectPending: isAuthRedirectPending(),
          suppressErrorReconnect,
          hasCurrentThread: threadIdRef.current === agentThreadId && eventSourceRef.current === source,
          hasCursor: cursorRef.current !== null,
          readyState: source.readyState,
          connectingState: EventSource.CONNECTING,
          closedState: EventSource.CLOSED,
        })

        if (recoveryAction === 'auth_stop') {
          cleanupAgent()
          return
        }
        if (recoveryAction === 'bootstrap_recover') {
          recoverBootstrap('native_connecting_error')
          return
        }
        if (recoveryAction === 'manual_reconnect') {
          scheduleReconnect('connection_error')
        }
      })
    })

    return cleanupAgent
  }, [])

  useEffect(() => {
    if (!threadId) {
      threadIdRef.current = null
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = null
      }
      recoveryInFlightRef.current = false
      recoveryEpochRef.current += 1
      reconnectAttemptRef.current = 0
      return
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current)
      recoveryTimerRef.current = null
    }
    recoveryInFlightRef.current = false
    recoveryEpochRef.current += 1
    reconnectAttemptRef.current = 0

    const cleanup = connectAgentStream(threadId)

    return () => {
      cleanup()
      threadIdRef.current = null
    }
  }, [threadId, connectAgentStream])

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close()
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current)
      }
      recoveryInFlightRef.current = false
      recoveryEpochRef.current += 1
    }
  }, [])

  const ensureConnected = useCallback(() => {
    if (!threadIdRef.current) {
      return
    }

    const source = eventSourceRef.current
    if (source && source.readyState !== EventSource.CLOSED) {
      return
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current)
      recoveryTimerRef.current = null
    }
    recoveryInFlightRef.current = false
    recoveryEpochRef.current += 1
    reconnectAttemptRef.current = 0
    connectAgentStream(threadIdRef.current)
  }, [connectAgentStream])

  const setStreamCursor = useCallback((cursor: string | null) => {
    cursorRef.current = cursor
  }, [])

  return {
    ensureConnected,
    setStreamCursor,
  }
}
