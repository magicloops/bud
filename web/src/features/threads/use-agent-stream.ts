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
}

type AgentToolResultEvent = {
  turn_id: string
  client_id: string
  call_id: string
  message_id?: string
  name: string
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
  onStatusChange: (status: 'idle' | 'streaming') => void
  onError: (message: string | null) => void
  onToolCall: (event: {
    turnId: string
    clientId: string
    callId: string
    name: string
    args?: Record<string, unknown>
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
      cleanupAgent()
      const nextAttempt = reconnectAttemptRef.current + 1
      reconnectAttemptRef.current = nextAttempt
      const delay = getThreadStreamReconnectDelay(nextAttempt)
      console.warn('[agent-sse] reconnecting', { threadId: agentThreadId, reason, attempt: nextAttempt, delay })
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
      reconnectTimerRef.current = setTimeout(() => {
        if (threadIdRef.current && !isAuthRedirectPending()) {
          connectAgentStream(threadIdRef.current)
        }
      }, delay)
    }

    source.addEventListener('open', () => {
      reconnectAttemptRef.current = 0
      lastEventTimeRef.current = Date.now()
      console.log('[agent-sse] connected', { threadId: agentThreadId, after: cursorRef.current })

      const { heartbeatTimeoutMs, checkIntervalMs } = getThreadStreamHeartbeatConfig(import.meta.env.DEV)
      heartbeatCheckInterval = setInterval(() => {
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
      onStatusChange('streaming')
      try {
        const data = JSON.parse(evt.data) as AgentToolCallEvent
        console.log('[agent-sse] tool_call', data.name, data.args)
        onToolCall({
          turnId: data.turn_id,
          clientId: data.client_id,
          callId: data.call_id,
          name: data.name,
          args: data.args,
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
          onToolResultMessage(data.message)
        }
      } catch (error) {
        console.warn('[agent-sse] failed to parse agent.tool_result', error)
      }
    })

    source.addEventListener('agent.message_start', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      onStatusChange('streaming')
      try {
        const data = JSON.parse(evt.data) as AgentMessageStartEvent
        onAssistantMessageStart({ turnId: data.turn_id, clientId: data.client_id })
      } catch (error) {
        console.warn('[agent-sse] failed to parse agent.message_start', error)
      }
    })

    source.addEventListener('agent.message_delta', (evt) => {
      lastEventTimeRef.current = Date.now()
      cursorRef.current = evt.lastEventId || cursorRef.current
      onStatusChange('streaming')
      try {
        const data = JSON.parse(evt.data) as AgentMessageDeltaEvent
        onAssistantMessageDelta({
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
        onAssistantMessageDone({
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
        onAssistantMessageEvent({
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
        onThreadTitle(data.title)
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
      void refreshBootstrap(agentThreadId)
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
          onError(error instanceof Error ? error.message : 'Failed to resync thread')
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
      onStatusChange('idle')
      if (finalEvent?.turn_id) {
        onFinalizeTurn(finalEvent.turn_id, finalEvent.status)
      }
      if (finalEvent?.status === 'failed') {
        onError(finalEvent.error ?? 'Agent turn failed')
      } else {
        onError(null)
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
