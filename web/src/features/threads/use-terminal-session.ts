import { useCallback, useEffect, useRef, useState } from 'react'
import { createAuthEventSource, apiFetch } from '@/lib/transport'
import { isAuthRedirectPending } from '@/lib/auth-redirect'
import { decodeTerminalData } from '@/lib/terminal-data'
import {
  createTerminalPasteIntent,
  detectTerminalInputPlatform,
  logUnsupportedTerminalComposition,
  logUnsupportedTerminalKeydown,
  translateTerminalKeydown,
} from '@/lib/terminal-input'
import {
  getThreadStreamHeartbeatConfig,
  getThreadStreamReconnectDelay,
  hasMissedThreadStreamHeartbeat,
  shouldTreatTerminalStatusAsStale,
} from '@/features/threads/thread-stream-timing'
import type { Terminal } from 'xterm'
import type { FitAddon } from 'xterm-addon-fit'

export type TerminalConnectionState =
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'disconnected'

export type TerminalReadinessAssessment = {
  ready: boolean
  confidence: number
  trigger: string
  hints: {
    looks_like_prompt?: boolean
    looks_like_confirmation?: boolean
    looks_like_password?: boolean
    looks_like_pager?: boolean
    looks_like_error?: boolean
    may_still_be_processing?: boolean
  }
}

type TerminalViewMode = 'terminal' | 'web'

type QueueTerminalInput = (text: string, options?: { flushImmediately?: boolean }) => void

type UseTerminalSessionArgs = {
  budId: string | null
  threadId: string | null
  viewMode: TerminalViewMode
  threadPanelOpen: boolean
  onError: (message: string) => void
  shouldAbortForUnauthorized: (response?: Response | null) => boolean
  updateBudStatus: (budId: string, status: 'online' | 'offline') => void
}

export function useTerminalSession({
  budId,
  threadId,
  viewMode,
  threadPanelOpen,
  onError,
  shouldAbortForUnauthorized,
  updateBudStatus,
}: UseTerminalSessionArgs) {
  const [terminalState, setTerminalState] = useState<string>('idle')
  const [terminalHasOutput, setTerminalHasOutput] = useState(false)
  const [terminalConnection, setTerminalConnection] =
    useState<TerminalConnectionState>('disconnected')
  const [terminalReadiness, setTerminalReadiness] =
    useState<TerminalReadinessAssessment | null>(null)
  const [terminalOutputTruncated, setTerminalOutputTruncated] = useState(false)
  const [terminalScrolledToTop, setTerminalScrolledToTop] = useState(false)
  const [showDisconnectOverlay, setShowDisconnectOverlay] = useState(false)
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)

  const terminalConnectionRef = useRef<TerminalConnectionState>('disconnected')
  const terminalEventSourceRef = useRef<EventSource | null>(null)
  const terminalPaneRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sendTerminalInputRef = useRef<QueueTerminalInput>(() => {})
  const sendTerminalResizeRef = useRef<(cols: number, rows: number) => void>(() => {})
  const terminalReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const terminalReconnectAttemptRef = useRef(0)
  const lastSseEventTimeRef = useRef<number>(Date.now())
  const lastConnectedThreadIdRef = useRef<string | null>(null)
  const currentSessionIdRef = useRef<string | null>(null)
  const terminalRecoveryInFlightRef = useRef(false)
  const terminalReadyRef = useRef(false)
  const terminalInputBufferRef = useRef<string>('')
  const terminalInputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewModeRef = useRef<TerminalViewMode>(viewMode)
  const terminalPlatformRef = useRef(detectTerminalInputPlatform())
  const lastSentDimensionsRef = useRef<{ cols: number; rows: number } | null>(null)

  const setConnectionState = useCallback((nextState: TerminalConnectionState) => {
    terminalConnectionRef.current = nextState
    setTerminalConnection(nextState)
  }, [])

  useEffect(() => {
    viewModeRef.current = viewMode
  }, [viewMode])

  const fitTerminal = useCallback(() => {
    if (!terminalReadyRef.current) {
      return
    }

    const addon = fitAddonRef.current
    const term = terminalRef.current
    const pane = terminalPaneRef.current
    if (!addon || !term || !pane || !pane.isConnected || !term.element) {
      return
    }

    try {
      addon.fit()
      const cols = term.cols
      const rows = term.rows
      const last = lastSentDimensionsRef.current
      if (cols > 0 && rows > 0 && (!last || last.cols !== cols || last.rows !== rows)) {
        lastSentDimensionsRef.current = { cols, rows }
        sendTerminalResizeRef.current(cols, rows)
      }
    } catch (err) {
      console.warn('Failed to fit terminal', err)
    }
  }, [])

  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus()
  }, [])

  const resetTerminal = useCallback(() => {
    const term = terminalRef.current
    if (term && term.element) {
      term.reset()
    }

    setTerminalHasOutput(false)
    setTerminalScrolledToTop(false)

    const current = term
    requestAnimationFrame(() => {
      if (!current || terminalRef.current !== current || !current.element) {
        return
      }
      current.focus()
      fitTerminal()
    })
  }, [fitTerminal])

  useEffect(() => {
    if (!terminalPaneRef.current || terminalRef.current) {
      return
    }

    const container = terminalPaneRef.current
    if (!container.isConnected) {
      return
    }

    let cancelled = false
    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let handleResize: (() => void) | null = null
    let scrollListener: { dispose: () => void } | null = null
    let pasteTarget: HTMLDivElement | HTMLTextAreaElement | null = null
    let handlePaste: EventListener | null = null
    let handleCompositionEvent: ((event: CompositionEvent) => void) | null = null

    const initTerminal = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('xterm'),
        import('xterm-addon-fit'),
      ])

      if (cancelled) {
        return
      }

      await new Promise<void>((resolve) => {
        const check = () => {
          if (cancelled) {
            resolve()
            return
          }

          const rect = container.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            resolve()
          } else {
            requestAnimationFrame(check)
          }
        }

        check()
      })

      if (cancelled) {
        return
      }

      term = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily: '"JetBrains Mono", SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        theme: {
          background: '#000000',
          foreground: '#d1ffe1',
          cursor: '#ffffff',
          selectionBackground: '#195b3f',
        },
      })
      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(container)

      if (cancelled) {
        fitAddon.dispose()
        term.dispose()
        return
      }

      terminalRef.current = term
      fitAddonRef.current = fitAddon

      let fitAttempts = 0
      const tryFit = () => {
        if (cancelled || terminalRef.current !== term || !term) {
          return
        }

        fitAttempts += 1
        // xterm does not expose a stable public signal for first render completion.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const renderService = (term as any)._core?._renderService
        if (renderService?.dimensions) {
          terminalReadyRef.current = true
          term.focus()
          fitTerminal()
        } else if (fitAttempts < 10) {
          requestAnimationFrame(tryFit)
        }
      }
      requestAnimationFrame(tryFit)

      handleResize = () => fitTerminal()
      window.addEventListener('resize', handleResize)

      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') {
          return true
        }

        if (
          viewModeRef.current !== 'terminal' ||
          terminalConnectionRef.current !== 'connected'
        ) {
          return true
        }

        const intent = translateTerminalKeydown(event, {
          hasSelection: term?.hasSelection() ?? false,
          platform: terminalPlatformRef.current,
        })

        if (intent.kind === 'text' || intent.kind === 'bytes') {
          sendTerminalInputRef.current(intent.text, {
            flushImmediately: intent.kind === 'bytes' && intent.text === '\x03',
          })
          return false
        }

        if (intent.kind === 'unsupported') {
          logUnsupportedTerminalKeydown(intent, event)
        }

        return true
      })

      pasteTarget = term.textarea ?? container
      handlePaste = (rawEvent) => {
        const event = rawEvent as ClipboardEvent
        if (
          viewModeRef.current !== 'terminal' ||
          terminalConnectionRef.current !== 'connected'
        ) {
          return
        }

        const text = event.clipboardData?.getData('text/plain') ?? ''
        const intent = createTerminalPasteIntent(text)
        if (intent.kind !== 'paste') {
          return
        }

        event.preventDefault()
        event.stopPropagation()
        sendTerminalInputRef.current(intent.text)
      }
      pasteTarget.addEventListener('paste', handlePaste)

      if (term.textarea) {
        handleCompositionEvent = (event) => {
          logUnsupportedTerminalComposition(event)
        }
        term.textarea.addEventListener('compositionstart', handleCompositionEvent)
        term.textarea.addEventListener('compositionupdate', handleCompositionEvent)
        term.textarea.addEventListener('compositionend', handleCompositionEvent)
      }

      scrollListener = term.onScroll((scrollPosition) => {
        setTerminalScrolledToTop(scrollPosition === 0)
      })
    }

    void initTerminal()

    return () => {
      cancelled = true
      terminalReadyRef.current = false
      if (handleResize) {
        window.removeEventListener('resize', handleResize)
      }
      scrollListener?.dispose()
      if (pasteTarget && handlePaste) {
        pasteTarget.removeEventListener('paste', handlePaste)
      }
      if (term?.textarea && handleCompositionEvent) {
        term.textarea.removeEventListener('compositionstart', handleCompositionEvent)
        term.textarea.removeEventListener('compositionupdate', handleCompositionEvent)
        term.textarea.removeEventListener('compositionend', handleCompositionEvent)
      }
      fitAddon?.dispose()
      term?.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [fitTerminal])

  useEffect(() => {
    fitTerminal()
  }, [fitTerminal, threadPanelOpen])

  const flushTerminalInput = useCallback(async () => {
    if (terminalInputFlushTimerRef.current) {
      clearTimeout(terminalInputFlushTimerRef.current)
      terminalInputFlushTimerRef.current = null
    }

    const input = terminalInputBufferRef.current
    if (!input || !threadId) {
      return
    }
    terminalInputBufferRef.current = ''

    if (terminalConnectionRef.current !== 'connected') {
      console.warn('[terminal] input blocked - not connected', {
        threadId,
        bytes: input.length,
        connection: terminalConnectionRef.current,
      })
      return
    }

    try {
      const resp = await apiFetch(`/api/threads/${threadId}/terminal/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
      if (shouldAbortForUnauthorized(resp)) {
        return
      }
      if (!resp.ok) {
        console.warn('[terminal] input request failed', { status: resp.status })
        if (resp.status >= 500 || resp.status === 0) {
          setConnectionState('reconnecting')
        }
      }
    } catch (err) {
      if (isAuthRedirectPending()) {
        return
      }
      console.error('Failed to send terminal input', err)
      setConnectionState('reconnecting')
      onError(err instanceof Error ? err.message : 'Failed to send input')
    }
  }, [onError, setConnectionState, shouldAbortForUnauthorized, threadId])

  const sendTerminalInput = useCallback<QueueTerminalInput>(
    (text, options = {}) => {
      if (!threadId || text.length === 0) {
        return
      }

      terminalInputBufferRef.current += text
      if (terminalInputFlushTimerRef.current) {
        clearTimeout(terminalInputFlushTimerRef.current)
        terminalInputFlushTimerRef.current = null
      }

      if (options.flushImmediately) {
        void flushTerminalInput()
        return
      }

      terminalInputFlushTimerRef.current = setTimeout(() => {
        terminalInputFlushTimerRef.current = null
        void flushTerminalInput()
      }, 20)
    },
    [flushTerminalInput, threadId],
  )

  useEffect(() => {
    sendTerminalInputRef.current = sendTerminalInput
  }, [sendTerminalInput])

  const sendTerminalResize = useCallback(
    async (cols: number, rows: number) => {
      if (!threadId) {
        return
      }

      try {
        const resp = await apiFetch(`/api/threads/${threadId}/terminal/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols, rows }),
        })
        if (shouldAbortForUnauthorized(resp)) {
          return
        }
        if (!resp.ok) {
          console.warn('[terminal] resize request failed', { status: resp.status })
        }
      } catch (err) {
        if (isAuthRedirectPending()) {
          return
        }
        console.error('Failed to send terminal resize', err)
      }
    },
    [shouldAbortForUnauthorized, threadId],
  )

  useEffect(() => {
    sendTerminalResizeRef.current = sendTerminalResize
  }, [sendTerminalResize])

  const sendTerminalCtrlC = useCallback(() => {
    sendTerminalInput('\x03', { flushImmediately: true })
    focusTerminal()
  }, [focusTerminal, sendTerminalInput])

  const refreshTerminalSnapshot = useCallback(
    async (targetThreadId: string) => {
      const statusResp = await apiFetch(`/api/threads/${targetThreadId}/terminal`)
      if (shouldAbortForUnauthorized(statusResp)) {
        return
      }
      if (statusResp.ok) {
        const body = (await statusResp.json()) as { state?: string }
        if (body.state) {
          setTerminalState(body.state)
        }
      }

      const historyResp = await apiFetch(
        `/api/threads/${targetThreadId}/terminal/history?bytes=131072`,
      )
      if (shouldAbortForUnauthorized(historyResp)) {
        return
      }
      if (!historyResp.ok) {
        return
      }

      const body = (await historyResp.json()) as {
        data_base64?: string
        bytes?: number
        total_bytes_available?: number
      }

      if (body.bytes !== undefined && body.total_bytes_available !== undefined) {
        setTerminalOutputTruncated(body.bytes < body.total_bytes_available)
      }

      const term = terminalRef.current
      if (!term) {
        return
      }

      term.reset()
      const decoded = body.data_base64 ? decodeTerminalData(body.data_base64) : ''
      if (decoded) {
        term.write(decoded)
        setTerminalHasOutput(true)
        fitTerminal()
        const buffer = term.buffer.active
        setTerminalScrolledToTop(buffer.viewportY === 0)
        return
      }

      setTerminalHasOutput(false)
      setTerminalScrolledToTop(false)
    },
    [fitTerminal, shouldAbortForUnauthorized],
  )

  const recoverTerminalSession = useCallback(
    async (reason: string): Promise<boolean> => {
      if (!threadId) {
        return false
      }
      if (terminalRecoveryInFlightRef.current) {
        return false
      }

      terminalRecoveryInFlightRef.current = true

      try {
        const resp = await apiFetch(`/api/threads/${threadId}/terminal/ensure`, {
          method: 'POST',
        })
        if (shouldAbortForUnauthorized(resp)) {
          return false
        }
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as { error?: string }
          console.warn('[terminal] Terminal recovery failed', {
            threadId,
            sessionId: currentSessionIdRef.current,
            reason,
            status: resp.status,
            error: body.error,
          })

          if (body.error === 'bud_offline') {
            setConnectionState('reconnecting')
            setTerminalState('bud_offline')
            if (budId) {
              updateBudStatus(budId, 'offline')
            }
          }

          return false
        }

        console.log('[terminal] Terminal recovery ensured', {
          threadId,
          sessionId: currentSessionIdRef.current,
          reason,
        })

        setConnectionState('connected')
        if (budId) {
          updateBudStatus(budId, 'online')
        }

        try {
          await refreshTerminalSnapshot(threadId)
        } catch (err) {
          console.error('[terminal] Failed to refresh terminal snapshot after recovery', {
            threadId,
            sessionId: currentSessionIdRef.current,
            reason,
            err,
          })
        }

        return true
      } catch (err) {
        if (isAuthRedirectPending()) {
          return false
        }
        console.error('[terminal] Terminal recovery request failed', {
          threadId,
          sessionId: currentSessionIdRef.current,
          reason,
          err,
        })
        return false
      } finally {
        terminalRecoveryInFlightRef.current = false
      }
    },
    [
      budId,
      refreshTerminalSnapshot,
      setConnectionState,
      shouldAbortForUnauthorized,
      threadId,
      updateBudStatus,
    ],
  )

  useEffect(() => {
    const cleanupTimers = () => {
      if (terminalReconnectTimerRef.current) {
        clearTimeout(terminalReconnectTimerRef.current)
        terminalReconnectTimerRef.current = null
      }
    }

    const closeSource = () => {
      terminalEventSourceRef.current?.close()
      terminalEventSourceRef.current = null
    }

    cleanupTimers()
    closeSource()

    if (threadId !== lastConnectedThreadIdRef.current) {
      resetTerminal()
      setTerminalOutputTruncated(false)
      setTerminalReadiness(null)
      currentSessionIdRef.current = null
      setCurrentSessionId(null)
      lastConnectedThreadIdRef.current = threadId
    }

    terminalReconnectAttemptRef.current = 0
    setConnectionState('disconnected')

    if (!threadId) {
      setTerminalState('idle')
      lastConnectedThreadIdRef.current = null
      currentSessionIdRef.current = null
      setCurrentSessionId(null)
      return
    }

    let cancelled = false

    const scheduleReconnect = (reason: string, cleanup?: () => void) => {
      cleanup?.()
      if (cancelled || isAuthRedirectPending()) {
        return
      }

      setConnectionState('reconnecting')

      const nextAttempt = terminalReconnectAttemptRef.current + 1
      terminalReconnectAttemptRef.current = nextAttempt
      const delay = getThreadStreamReconnectDelay(nextAttempt)

      console.warn('[terminal] reconnect scheduled', {
        threadId,
        reason,
        attempt: nextAttempt,
        delay,
      })

      cleanupTimers()
      terminalReconnectTimerRef.current = setTimeout(() => {
        if (!cancelled && !isAuthRedirectPending()) {
          void connect()
        }
      }, delay)
    }

    const connect = async () => {
      if (cancelled || isAuthRedirectPending()) {
        return
      }

      try {
        const sessionResp = await apiFetch(`/api/threads/${threadId}/terminal`, {
          method: 'POST',
        })

        if (shouldAbortForUnauthorized(sessionResp) || cancelled) {
          return
        }

        if (!sessionResp.ok) {
          if (!cancelled) {
            console.error('[terminal] Failed to create session record', {
              status: sessionResp.status,
            })
            if (sessionResp.status >= 500) {
              scheduleReconnect(`session_record_http_${sessionResp.status}`)
            } else {
              setConnectionState('disconnected')
            }
          }
          return
        }

        const { session_id, created } = (await sessionResp.json()) as {
          session_id: string
          created?: boolean
        }
        currentSessionIdRef.current = session_id
        setCurrentSessionId(session_id)

        if (created) {
          console.log('[terminal] Created new session record', { sessionId: session_id, threadId })
        } else {
          console.log('[terminal] Using existing session record', { sessionId: session_id, threadId })
        }
      } catch (err) {
        if (isAuthRedirectPending()) {
          return
        }
        if (!cancelled) {
          console.error('[terminal] Failed to create session record', err)
          scheduleReconnect('session_record_request_failed')
        }
        return
      }

      if (cancelled) {
        return
      }

      const terminalStream = createAuthEventSource(`/api/threads/${threadId}/terminal/stream`)
      const source = terminalStream.source
      terminalEventSourceRef.current = source

      let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null

      const handleOutput = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const raw = event.data ?? ''
          const payload = JSON.parse(raw) as { data?: string }
          if (payload.data) {
            const decoded = decodeTerminalData(payload.data)
            if (decoded && terminalRef.current) {
              terminalRef.current.write(decoded)
              setTerminalHasOutput(true)
            }
          }
        } catch (err) {
          console.error('Failed to parse terminal.output SSE', err)
        }
      }

      const handleStatus = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data ?? '{}') as { state?: string }
          if (payload.state) {
            const now = Date.now()
            if (shouldTreatTerminalStatusAsStale(lastSseEventTimeRef.current, now)) {
              lastSseEventTimeRef.current = now
              scheduleReconnect('service_restart_detected', cleanupSource)
              return
            }
            lastSseEventTimeRef.current = now

            if (
              terminalConnectionRef.current === 'reconnecting' ||
              terminalConnectionRef.current === 'offline'
            ) {
              console.log('[terminal] Ignoring status event while disconnected', {
                state: payload.state,
                connection: terminalConnectionRef.current,
              })
              return
            }

            setTerminalState(payload.state)
          }
        } catch (err) {
          console.error('Failed to parse terminal.status SSE', err)
        }
      }

      const handleHeartbeat = () => {
        lastSseEventTimeRef.current = Date.now()
      }

      const handleReady = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as {
            assessment?: TerminalReadinessAssessment
          }
          if (payload.assessment) {
            setTerminalReadiness(payload.assessment)
          }
        } catch (err) {
          console.error('Failed to parse terminal.ready SSE', err)
        }
      }

      const handleBudOffline = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as { bud_id?: string; reason?: string }
          console.warn('[terminal] Bud went offline', payload)
          setConnectionState('reconnecting')
          setTerminalState('bud_offline')
          if (budId) {
            updateBudStatus(budId, 'offline')
          }
        } catch (err) {
          console.error('Failed to parse terminal.bud_offline SSE', err)
        }
      }

      const handleBudOnline = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as { bud_id?: string }
          console.log('[terminal] Bud came online', payload)

          if (budId) {
            updateBudStatus(budId, 'online')
          }

          void recoverTerminalSession('bud_online')
        } catch (err) {
          console.error('Failed to parse terminal.bud_online SSE', err)
        }
      }

      const cleanupSource = () => {
        if (heartbeatCheckInterval) {
          clearInterval(heartbeatCheckInterval)
          heartbeatCheckInterval = null
        }
        source.removeEventListener('heartbeat', handleHeartbeat)
        source.removeEventListener('terminal.output', handleOutput)
        source.removeEventListener('terminal.status', handleStatus)
        source.removeEventListener('terminal.ready', handleReady)
        source.removeEventListener('terminal.bud_offline', handleBudOffline)
        source.removeEventListener('terminal.bud_online', handleBudOnline)
        source.close()
        if (terminalEventSourceRef.current === source) {
          terminalEventSourceRef.current = null
        }
      }

      source.addEventListener('open', () => {
        const wasReconnect = terminalReconnectAttemptRef.current > 0
        terminalReconnectAttemptRef.current = 0
        lastSseEventTimeRef.current = Date.now()

        console.log('[terminal] SSE connected', {
          threadId,
          sessionId: currentSessionIdRef.current,
          wasReconnect,
        })

        void recoverTerminalSession(wasReconnect ? 'sse_reconnect' : 'sse_open')

        const { heartbeatTimeoutMs, checkIntervalMs } = getThreadStreamHeartbeatConfig(import.meta.env.DEV)
        heartbeatCheckInterval = setInterval(() => {
          if (hasMissedThreadStreamHeartbeat(lastSseEventTimeRef.current, Date.now(), heartbeatTimeoutMs)) {
            console.warn(
              `[terminal] no heartbeat received for ${heartbeatTimeoutMs / 1000}s, connection is stale`,
            )
            scheduleReconnect('heartbeat_timeout', cleanupSource)
          }
        }, checkIntervalMs)
      })

      source.addEventListener('heartbeat', handleHeartbeat)
      source.addEventListener('terminal.output', handleOutput)
      source.addEventListener('terminal.status', handleStatus)
      source.addEventListener('terminal.ready', handleReady)
      source.addEventListener('terminal.bud_offline', handleBudOffline)
      source.addEventListener('terminal.bud_online', handleBudOnline)
      source.onerror = (err: Event) => {
        void terminalStream.checkUnauthorized().then((unauthorized: boolean) => {
          if (unauthorized) {
            return
          }

          console.warn('[terminal] SSE error', { err, readyState: source.readyState })
          scheduleReconnect(`error ${JSON.stringify(err)}`, cleanupSource)
        })
      }
    }

    void connect()

    return () => {
      cancelled = true
      cleanupTimers()
      closeSource()
    }
  }, [
    budId,
    recoverTerminalSession,
    resetTerminal,
    setConnectionState,
    shouldAbortForUnauthorized,
    threadId,
    updateBudStatus,
  ])

  useEffect(() => {
    if (
      (terminalConnection !== 'reconnecting' && terminalConnection !== 'offline') ||
      !threadId
    ) {
      return
    }

    const existingSource = terminalEventSourceRef.current
    if (!existingSource || existingSource.readyState === EventSource.CLOSED) {
      return
    }

    console.log('[terminal] SSE still connected, polling for terminal recovery')

    let cancelled = false
    const pollRecovery = async () => {
      while (
        !cancelled &&
        !isAuthRedirectPending() &&
        terminalConnectionRef.current !== 'connected'
      ) {
        const recovered = await recoverTerminalSession('connected_sse_poll')
        if (recovered) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }

    void pollRecovery()

    return () => {
      cancelled = true
    }
  }, [recoverTerminalSession, terminalConnection, threadId])

  useEffect(() => {
    if (terminalConnection === 'connected') {
      setShowDisconnectOverlay(false)
      return
    }

    const timer = setTimeout(() => {
      setShowDisconnectOverlay(true)
    }, 2000)
    return () => clearTimeout(timer)
  }, [terminalConnection])

  useEffect(() => {
    if (terminalConnection !== 'reconnecting') {
      return
    }

    const offlineTimer = setTimeout(() => {
      console.warn('[terminal] Bud has been offline for 30s, transitioning to offline state')
      setConnectionState('offline')
    }, 30000)

    return () => clearTimeout(offlineTimer)
  }, [setConnectionState, terminalConnection])

  useEffect(() => {
    return () => {
      terminalEventSourceRef.current?.close()
      if (terminalInputFlushTimerRef.current) {
        clearTimeout(terminalInputFlushTimerRef.current)
      }
    }
  }, [])

  return {
    currentSessionId,
    focusTerminal,
    sendTerminalCtrlC,
    showDisconnectOverlay,
    terminalConnection,
    terminalHasOutput,
    terminalOutputTruncated,
    terminalPaneRef,
    terminalReadiness,
    terminalScrolledToTop,
    terminalState,
  }
}
