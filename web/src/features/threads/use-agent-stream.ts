import { useCallback, useEffect, useRef } from 'react'
import { createAuthEventSource } from '@/lib/transport'
import { isAuthRedirectPending } from '@/lib/auth-redirect'
import type { ApiAgentState, ApiMessage } from '@/lib/api-types'
import {
  getThreadStreamHeartbeatConfig,
  getThreadStreamReconnectDelay,
  hasMissedThreadStreamHeartbeat,
} from '@/features/threads/thread-stream-timing'

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
  onThreadTitle,
  onFinalizeTurn,
  refreshBootstrap,
}: UseAgentStreamArgs) {
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
      onThreadTitle,
      onFinalizeTurn,
      refreshBootstrap,
    }
  }, [
    onAssistantMessageDelta,
    onAssistantMessageDone,
    onAssistantMessageEvent,
    onAssistantMessageStart,
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

    const scheduleReconnect = (reason: string) => {
      if (isAuthRedirectPending()) {
        cleanupAgent()
        return
      }
      if (reconnectTimerRef.current) {
        return
      }

      cleanupAgent()
      const nextAttempt = reconnectAttemptRef.current + 1
      reconnectAttemptRef.current = nextAttempt
      const delay = getThreadStreamReconnectDelay(nextAttempt)
      console.warn('[agent-sse] reconnecting', { threadId: agentThreadId, reason, attempt: nextAttempt, delay })
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
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
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }

      reconnectAttemptRef.current = 0
      lastEventTimeRef.current = Date.now()
      console.log('[agent-sse] connected', { threadId: agentThreadId, after: cursorRef.current })

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
        console.log('[agent-sse] tool_call', data.name, data.args)
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

      cleanupAgent()
      void callbacksRef.current.refreshBootstrap(agentThreadId)
        .then((nextAgentState) => {
          cursorRef.current = nextAgentState.stream_cursor
          if (threadIdRef.current === agentThreadId && !isAuthRedirectPending()) {
            connectAgentStream(agentThreadId)
          }
        })
        .catch((error) => {
          if (isAuthRedirectPending()) {
            return
          }
          console.error('[agent-sse] failed to refresh bootstrap after resync', error)
          callbacksRef.current.onError(error instanceof Error ? error.message : 'Failed to resync thread')
          scheduleReconnect('resync_refresh_failed')
        })
    })

    source.addEventListener('final', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      console.log('[agent-sse] final event received')
      let finalEvent: AgentFinalEvent | null = null
      try {
        finalEvent = JSON.parse(evt.data) as AgentFinalEvent
      } catch (error) {
        console.warn('[agent-sse] failed to parse final event', error)
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
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
        if (unauthorized || suppressErrorReconnect) {
          return
        }

        console.warn('[agent-sse] error', { readyState: source.readyState, evt })
        if (threadIdRef.current && source.readyState !== EventSource.CLOSED) {
          return
        }
        if (threadIdRef.current) {
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
