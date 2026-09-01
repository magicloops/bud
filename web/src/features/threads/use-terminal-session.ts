import { useCallback, useEffect, useRef, useState } from 'react'
import { createAuthEventSource, apiFetch } from '@/lib/transport'
import { isAuthRedirectPending } from '@/lib/auth-redirect'
import {
  createTerminalStreamDecoder,
  decodeTerminalData,
} from '@/lib/terminal-data'
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
} from '@/features/threads/thread-stream-timing'
import {
  advanceAppliedOffset,
  buildTerminalSnapshotText,
  buildTerminalStreamPath,
  planTerminalConnect,
  resolveOutputEndOffset,
} from '@/features/threads/terminal-resume'
import {
  emptyTerminalInputQueue,
  enqueueTerminalInput,
  hasQueuedTerminalInput,
  takeQueuedTerminalInput,
  type TerminalInputQueueState,
} from '@/features/threads/terminal-input-queue'
import {
  reduceTerminalCommandChip,
  type TerminalCommandChip,
} from '@/features/threads/terminal-command-state'
import {
  applyGridFrame,
  emptyGridState,
  seedGridScrollback,
  type TerminalGridFrame,
  type TerminalGridState,
} from '@/features/threads/terminal-grid-state'
import {
  resolveTerminalRendererMode,
  type TerminalRendererMode,
} from '@/features/threads/terminal-renderer'
import {
  ackApplied,
  assignFlushSeq,
  emptyPredictionState,
  predictKeystroke,
  predictionGhostText,
  type TerminalPredictionState,
} from '@/features/threads/terminal-prediction'
import type { Terminal } from 'xterm'
import type { FitAddon } from 'xterm-addon-fit'

export type TerminalConnectionState =
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'disconnected'

export type TerminalMode = 'shell' | 'tui' | 'repl' | 'unknown'
export type TerminalIntegration = 'osc133' | 'sentinel' | 'none'

/** Typed session facts from proto 0.3 `terminal.event` (replaces readiness). */
export type TerminalSessionFacts = {
  mode: TerminalMode
  integration: TerminalIntegration
}

export type { TerminalCommandChip }

type TerminalViewMode = 'chat' | 'terminal' | 'web' | 'file' | 'none'

type QueueTerminalInput = (text: string, options?: { flushImmediately?: boolean }) => void

const TERMINAL_SNAPSHOT_LINES = 1000

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
  // Resolved once per mount; switching renderers reconnects the terminal.
  const [terminalRenderer] = useState<TerminalRendererMode>(() =>
    resolveTerminalRendererMode(
      typeof window !== 'undefined' ? window.location.search : '',
      typeof window !== 'undefined' ? window.localStorage : null,
    ),
  )
  const [terminalState, setTerminalState] = useState<string>('idle')
  const [terminalHasOutput, setTerminalHasOutput] = useState(false)
  const [terminalGridState, setTerminalGridState] = useState<TerminalGridState>(emptyGridState)
  const terminalGridStateRef = useRef<TerminalGridState>(terminalGridState)
  // Predictive echo (grid mode, §6.8.3): ghost tail of locally-typed input,
  // retired by frames whose applied_input_seq covers each flush.
  const [terminalPredictionGhost, setTerminalPredictionGhost] = useState('')
  const predictionRef = useRef<TerminalPredictionState>(emptyPredictionState)
  const inputSeqCounterRef = useRef(0)
  // Input POSTs must be strictly ordered: concurrent fetches ride parallel
  // HTTP connections and can ARRIVE out of order, reordering typed bytes at
  // the PTY (found live once leading-edge flushing made per-keystroke POSTs
  // common). Every flush enqueues onto this chain instead of racing.
  const inputPostChainRef = useRef<Promise<void>>(Promise.resolve())
  const [terminalConnection, setTerminalConnection] =
    useState<TerminalConnectionState>('disconnected')
  const [terminalFacts, setTerminalFacts] =
    useState<TerminalSessionFacts | null>(null)
  const [terminalCommand, setTerminalCommand] =
    useState<TerminalCommandChip | null>(null)
  const [terminalOutputTruncated, setTerminalOutputTruncated] = useState(false)
  const [terminalInputQueued, setTerminalInputQueued] = useState(false)
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
  // One dimension re-assert per SSE connection (on first ready/active status):
  // re-asserting on EVERY status event caused a SIGWINCH storm that made zsh
  // reprint its prompt with visible PROMPT_SP `%` artifacts.
  const dimensionsAssertedRef = useRef(false)
  // Highest applied end-offset in the durable output stream. `terminal.output`
  // SSE events carry `id:` = end offset; reconnects resume from here via
  // `?from_offset=` so routine reconnects never reset the buffer.
  const appliedOffsetRef = useRef<number | null>(null)
  // Snapshot is required on initial mount, after an `output_gap` (durable
  // data loss), and across a bud offline→online transition.
  const snapshotRequiredRef = useRef(true)
  const streamDecoderRef = useRef(createTerminalStreamDecoder())
  const inputQueueRef = useRef<TerminalInputQueueState>(emptyTerminalInputQueue)
  const inputQueueWarnedRef = useRef(false)
  const requestReconnectRef = useRef<((reason: string) => void) | null>(null)

  const setConnectionState = useCallback((nextState: TerminalConnectionState) => {
    terminalConnectionRef.current = nextState
    setTerminalConnection(nextState)
  }, [])

  useEffect(() => {
    viewModeRef.current = viewMode
  }, [viewMode])

  const setPrediction = useCallback((next: TerminalPredictionState) => {
    predictionRef.current = next
    setTerminalPredictionGhost(predictionGhostText(next))
  }, [])

  const applyGridFrameToState = useCallback(
    (frame: TerminalGridFrame): boolean => {
      const { state, discontinuity } = applyGridFrame(terminalGridStateRef.current, frame)
      if (discontinuity) {
        return false
      }
      terminalGridStateRef.current = state
      setTerminalGridState(state)
      // Prediction reconciliation: acked chunks retire (their echo is
      // authoritative now); a closed gate drops every ghost.
      if (!state.predictOk) {
        if (predictionRef.current !== emptyPredictionState) {
          setPrediction(emptyPredictionState)
        }
      } else if (state.appliedInputSeq !== null) {
        const next = ackApplied(predictionRef.current, state.appliedInputSeq)
        if (next !== predictionRef.current) {
          setPrediction(next)
        }
      }
      return true
    },
    [setPrediction],
  )

  const resetGridState = useCallback(() => {
    terminalGridStateRef.current = emptyGridState()
    setTerminalGridState(terminalGridStateRef.current)
    setPrediction(emptyPredictionState)
  }, [setPrediction])

  const fitTerminal = useCallback(() => {
    if (terminalRenderer === 'grid') {
      // The grid pane owns geometry: it measures its cell box and calls
      // sendTerminalResize directly (§6.8 — frames always match a size the
      // server rendered, so xterm-style fitting has no equivalent here).
      return
    }
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
  }, [terminalRenderer])

  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus()
  }, [])

  const resetTerminal = useCallback(() => {
    const term = terminalRef.current
    if (term && term.element) {
      term.reset()
    }
    streamDecoderRef.current.reset()
    resetGridState()

    setTerminalHasOutput(false)
    setTerminalScrolledToTop(false)

    const current = term
    requestAnimationFrame(() => {
      if (!current || terminalRef.current !== current || !current.element) {
        return
      }
      // No focus grab on reset either — the user may be typing a message.
      fitTerminal()
    })
  }, [fitTerminal, resetGridState])

  useEffect(() => {
    if (terminalRenderer === 'grid') {
      // Grid mode renders through ThreadTerminalGridPane; xterm is never
      // instantiated (input capture and resize live in the grid pane).
      return
    }
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
    let resizeObserver: ResizeObserver | null = null
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
          // No focus grab on mount: the composer owns keyboard focus until
          // the user clicks into the terminal (matches the grid renderer).
          fitTerminal()
        } else if (fitAttempts < 10) {
          requestAnimationFrame(tryFit)
        }
      }
      requestAnimationFrame(tryFit)

      handleResize = () => fitTerminal()
      window.addEventListener('resize', handleResize)

      // Window-resize alone misses pane-level layout changes (side panels,
      // scrollbars, zoom), letting xterm's grid drift from the PTY size —
      // live output rendered during that mismatch paints permanent artifacts
      // (e.g. zsh PROMPT_SP `%` marks). Observe the container itself so both
      // ends continuously converge; fitTerminal dedupes no-op dimensions.
      let resizeRaf: number | null = null
      resizeObserver = new ResizeObserver(() => {
        if (resizeRaf !== null) return
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = null
          fitTerminal()
        })
      })
      resizeObserver.observe(container)

      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') {
          return true
        }

        // Input is captured even while disconnected: the send path queues it
        // (bounded, drop-oldest) and flushes in order once the connection is
        // back, instead of silently discarding keystrokes.
        if (viewModeRef.current !== 'terminal') {
          return true
        }

        const intent = translateTerminalKeydown(event, {
          hasSelection: term?.hasSelection() ?? false,
          platform: terminalPlatformRef.current,
        })

        if (intent.kind === 'text' || intent.kind === 'bytes') {
          // Returning false only stops xterm's own handling — the browser's
          // default action still runs unless prevented (Tab would move focus
          // out of the terminal to the next focusable element).
          event.preventDefault()
          event.stopPropagation()
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
        if (viewModeRef.current !== 'terminal') {
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
      resizeObserver?.disconnect()
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
  }, [fitTerminal, terminalRenderer])

  useEffect(() => {
    fitTerminal()
  }, [fitTerminal, threadPanelOpen])

  const flushTerminalInput = useCallback(async () => {
    if (terminalInputFlushTimerRef.current) {
      clearTimeout(terminalInputFlushTimerRef.current)
      terminalInputFlushTimerRef.current = null
    }

    const pending = terminalInputBufferRef.current
    terminalInputBufferRef.current = ''

    if (!threadId) {
      return
    }

    if (terminalConnectionRef.current !== 'connected') {
      // Queued input has no live grid to reconcile against — drop ghosts.
      setPrediction(emptyPredictionState)
      if (pending) {
        const { state, droppedBytes } = enqueueTerminalInput(
          inputQueueRef.current,
          pending,
        )
        inputQueueRef.current = state
        if (droppedBytes > 0 && !inputQueueWarnedRef.current) {
          inputQueueWarnedRef.current = true
          console.warn('[terminal] input queue overflow — dropping oldest queued input', {
            threadId,
            droppedBytes,
          })
        }
        setTerminalInputQueued(hasQueuedTerminalInput(state))
      }
      return
    }

    const { state: drainedQueue, text: queuedText } = takeQueuedTerminalInput(
      inputQueueRef.current,
    )
    inputQueueRef.current = drainedQueue
    inputQueueWarnedRef.current = false
    setTerminalInputQueued(false)

    const input = queuedText + pending
    if (!input) {
      return
    }

    // Grid mode: every flush carries a seq; pending ghost text becomes a
    // seq-tracked chunk that a frame's applied_input_seq retires (§6.8.3).
    let seq: number | null = null
    if (terminalRenderer === 'grid') {
      inputSeqCounterRef.current += 1
      seq = inputSeqCounterRef.current
      setPrediction(assignFlushSeq(predictionRef.current, seq))
    }

    const postInput = async () => {
      try {
        const resp = await apiFetch(`/api/threads/${threadId}/terminal/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input, ...(seq !== null ? { seq } : {}) }),
        })
        if (shouldAbortForUnauthorized(resp)) {
          return
        }
        if (!resp.ok) {
          console.warn('[terminal] input request failed', { status: resp.status })
          // The flush never reached the PTY: its ghosts would linger unacked.
          setPrediction(emptyPredictionState)
          if (resp.status >= 500 || resp.status === 0) {
            setConnectionState('reconnecting')
          }
        }
      } catch (err) {
        if (isAuthRedirectPending()) {
          return
        }
        console.error('Failed to send terminal input', err)
        setPrediction(emptyPredictionState)
        setConnectionState('reconnecting')
        onError(err instanceof Error ? err.message : 'Failed to send input')
      }
    }
    // Strict ordering: enqueue behind every earlier in-flight input POST.
    const chained = inputPostChainRef.current.then(postInput)
    inputPostChainRef.current = chained.catch(() => undefined)
    await chained
  }, [onError, setConnectionState, setPrediction, shouldAbortForUnauthorized, terminalRenderer, threadId])

  const sendTerminalInput = useCallback<QueueTerminalInput>(
    (text, options = {}) => {
      if (!threadId || text.length === 0) {
        return
      }

      // Predictive echo: printables ghost immediately at the cursor while
      // the gate is open; anything unpredictable conservatively clears.
      if (terminalRenderer === 'grid') {
        if (
          terminalGridStateRef.current.predictOk &&
          terminalConnectionRef.current === 'connected'
        ) {
          setPrediction(predictKeystroke(predictionRef.current, text).state)
        } else if (predictionRef.current !== emptyPredictionState) {
          setPrediction(emptyPredictionState)
        }
      }

      const bufferWasEmpty = terminalInputBufferRef.current.length === 0
      terminalInputBufferRef.current += text
      if (terminalInputFlushTimerRef.current) {
        clearTimeout(terminalInputFlushTimerRef.current)
        terminalInputFlushTimerRef.current = null
      }

      if (options.flushImmediately) {
        void flushTerminalInput()
        return
      }

      // Grid mode flushes leading-edge: the first keystroke after an idle
      // buffer posts on the next task instead of waiting out the 20ms batch
      // window — that window was a visible chunk of vim's keypress latency.
      // Same-tick bursts (paste expansion, key translation) still batch.
      const delay = terminalRenderer === 'grid' && bufferWasEmpty ? 0 : 20
      terminalInputFlushTimerRef.current = setTimeout(() => {
        terminalInputFlushTimerRef.current = null
        void flushTerminalInput()
      }, delay)
    },
    [flushTerminalInput, setPrediction, terminalRenderer, threadId],
  )

  useEffect(() => {
    sendTerminalInputRef.current = sendTerminalInput
  }, [sendTerminalInput])

  // Flush queued input in order as soon as the terminal reconnects.
  useEffect(() => {
    if (terminalConnection !== 'connected') {
      return
    }
    if (
      !hasQueuedTerminalInput(inputQueueRef.current) &&
      !terminalInputBufferRef.current
    ) {
      return
    }
    void flushTerminalInput()
  }, [flushTerminalInput, terminalConnection])

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

  const refreshTerminalStateRecord = useCallback(
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
    },
    [shouldAbortForUnauthorized],
  )

  /**
   * Primary connect/render path: line-oriented emulator scrollback plus the
   * visible screen from `GET /terminal/snapshot`. Returns false when the
   * snapshot is unavailable (no session yet, bud offline, observe failure) so
   * the caller can fall back to the byte-tail history replay.
   */
  const applyTerminalSnapshot = useCallback(
    async (targetThreadId: string): Promise<boolean> => {
      let resp: Response
      try {
        resp = await apiFetch(
          `/api/threads/${targetThreadId}/terminal/snapshot?lines=${TERMINAL_SNAPSHOT_LINES}`,
        )
      } catch (err) {
        if (isAuthRedirectPending()) {
          return false
        }
        console.warn('[terminal] snapshot request failed', err)
        return false
      }

      if (shouldAbortForUnauthorized(resp)) {
        return false
      }
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { error?: string }
        console.warn('[terminal] snapshot unavailable', {
          threadId: targetThreadId,
          status: resp.status,
          error: body.error,
        })
        return false
      }

      const body = (await resp.json().catch(() => null)) as {
        session_id?: string
        mode?: TerminalMode
        integration?: TerminalIntegration
        alt_screen?: boolean
        history_text?: string
        screen_text?: string
        screen_ansi?: string
        cols?: number
        rows?: number
        ring_next_offset?: number
      } | null

      if (!body || typeof body.ring_next_offset !== 'number') {
        console.warn('[terminal] snapshot response missing ring_next_offset', {
          threadId: targetThreadId,
        })
        return false
      }

      if (terminalRenderer === 'grid') {
        // Grid mode: the snapshot seeds scrollback only — the live viewport
        // arrives as the watch re-arm's `full` grid frame, and byte offsets
        // play no rendering role.
        terminalGridStateRef.current = seedGridScrollback(
          terminalGridStateRef.current,
          body.history_text ?? '',
        )
        setTerminalGridState(terminalGridStateRef.current)
        snapshotRequiredRef.current = false
        setTerminalOutputTruncated(false)
        if (body.mode) {
          setTerminalFacts({ mode: body.mode, integration: body.integration ?? 'none' })
        }
        return true
      }

      const term = terminalRef.current
      if (!term) {
        return false
      }

      term.reset()
      streamDecoderRef.current.reset()

      const text = buildTerminalSnapshotText(
        body.history_text ?? '',
        body.screen_text ?? '',
        body.screen_ansi,
      )
      if (text) {
        term.write(text)
        setTerminalHasOutput(true)
        fitTerminal()
        const buffer = term.buffer.active
        setTerminalScrolledToTop(buffer.viewportY === 0)
      } else {
        setTerminalHasOutput(false)
        setTerminalScrolledToTop(false)
      }

      appliedOffsetRef.current = body.ring_next_offset
      snapshotRequiredRef.current = false
      // Emulator scrollback is the honest full view — no truncation banner.
      setTerminalOutputTruncated(false)

      if (body.mode) {
        setTerminalFacts({ mode: body.mode, integration: body.integration ?? 'none' })
      }

      return true
    },
    [fitTerminal, shouldAbortForUnauthorized, terminalRenderer],
  )

  /**
   * Fallback render path when the snapshot endpoint is unavailable: raw
   * byte-tail replay with its truncation banner. Leaves `snapshotRequired`
   * set so the next (re)connect attempts a real snapshot again.
   */
  const applyHistoryFallback = useCallback(
    async (targetThreadId: string) => {
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
      streamDecoderRef.current.reset()
      // The byte-tail replay carries no durable-stream offset; live output
      // events re-establish the cursor via their SSE ids.
      appliedOffsetRef.current = null

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

  /**
   * Ensure the daemon-side PTY exists (idempotent). Rendering is handled by
   * the connect cycle's snapshot/resume plan — this no longer replays history.
   */
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
    [budId, setConnectionState, shouldAbortForUnauthorized, threadId, updateBudStatus],
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
      appliedOffsetRef.current = null
      snapshotRequiredRef.current = true
      inputQueueRef.current = emptyTerminalInputQueue
      inputQueueWarnedRef.current = false
      setTerminalInputQueued(false)
      setTerminalOutputTruncated(false)
      setTerminalFacts(null)
      setTerminalCommand(null)
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
    let activeSourceCleanup: (() => void) | null = null

    const scheduleReconnect = (reason: string) => {
      const cleanup = activeSourceCleanup
      activeSourceCleanup = null
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

    requestReconnectRef.current = scheduleReconnect

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

      // Decide how to (re)establish the view: full snapshot only on initial
      // mount, after an output gap, or across a bud offline→online
      // transition. Otherwise resume from the applied offset — the server
      // replays the missed range on one ordered stream, no reset needed.
      const plan = planTerminalConnect({
        snapshotRequired: snapshotRequiredRef.current,
        appliedOffset: appliedOffsetRef.current,
      })

      let ensuredBeforeStream = false
      if (plan.mode === 'snapshot') {
        ensuredBeforeStream = true
        await recoverTerminalSession('pre_snapshot')
        if (cancelled) {
          return
        }

        try {
          await refreshTerminalStateRecord(threadId)
        } catch (err) {
          console.warn('[terminal] Failed to refresh terminal state record', err)
        }
        if (cancelled) {
          return
        }

        const snapshotApplied = await applyTerminalSnapshot(threadId)
        if (cancelled) {
          return
        }
        if (!snapshotApplied) {
          try {
            await applyHistoryFallback(threadId)
          } catch (err) {
            console.error('[terminal] History fallback failed', { threadId, err })
          }
          if (cancelled) {
            return
          }
        }
      }

      const terminalStream = createAuthEventSource(
        buildTerminalStreamPath(
          threadId,
          // Grid mode never resumes by byte offset — recovery is a fresh
          // full frame from the watch re-arm, not an output replay.
          terminalRenderer === 'grid' ? null : appliedOffsetRef.current,
          { grid: terminalRenderer === 'grid' },
        ),
      )
      const source = terminalStream.source
      terminalEventSourceRef.current = source
      dimensionsAssertedRef.current = false
      // Fresh decoder per SSE connection: chunk decode state never leaks
      // across connections. (Snapshot/reset paths also reset it.)
      streamDecoderRef.current.reset()

      let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null

      const handleOutput = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          if (terminalRenderer === 'grid') {
            // Rendering comes from grid frames; output frames only count as
            // stream liveness here.
            return
          }
          const raw = event.data ?? ''
          const payload = JSON.parse(raw) as { data?: string; byte_offset?: number }
          if (!payload.data) {
            return
          }

          const { text, byteLength } = streamDecoderRef.current.decode(payload.data)
          appliedOffsetRef.current = advanceAppliedOffset(
            appliedOffsetRef.current,
            resolveOutputEndOffset({
              lastEventId: event.lastEventId,
              byteOffset: payload.byte_offset,
              decodedByteLength: byteLength,
            }),
          )

          if (text && terminalRef.current) {
            terminalRef.current.write(text)
            setTerminalHasOutput(true)
          }
        } catch (err) {
          console.error('Failed to parse terminal.output SSE', err)
        }
      }

      const handleStatus = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as { state?: string }
          if (payload.state) {
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

            if (
              (payload.state === 'ready' || payload.state === 'active') &&
              !dimensionsAssertedRef.current
            ) {
              // The daemon may have (re)ensured the PTY with stale stored
              // dimensions, and any resize sent before the session existed was
              // dropped — re-assert the browser's current dimensions so
              // full-screen programs draw at the size we actually render.
              // Once per connection: repeating it on every status event floods
              // the shell with SIGWINCH prompt reprints.
              dimensionsAssertedRef.current = true
              lastSentDimensionsRef.current = null
              fitTerminal()
            }
          }
        } catch (err) {
          console.error('Failed to parse terminal.status SSE', err)
        }
      }

      const handleHeartbeat = () => {
        lastSseEventTimeRef.current = Date.now()
      }

      const handleGridFrame = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as TerminalGridFrame
          if (typeof payload.generation !== 'number' || !Array.isArray(payload.dirty_rows)) {
            return
          }
          if (!applyGridFrameToState(payload)) {
            // Generation gap or size mismatch: this grid is untrustworthy.
            // Reconnecting re-registers the viewer; the watch re-arm ships a
            // fresh full frame (§6.8.2 recovery rule).
            console.warn('[terminal] grid discontinuity — reconnecting', {
              threadId,
              generation: payload.generation,
            })
            snapshotRequiredRef.current = true
            scheduleReconnect('grid_discontinuity')
            return
          }
          if (payload.dirty_rows.length > 0 || payload.scrollback_push.length > 0) {
            setTerminalHasOutput(true)
          }
        } catch (err) {
          console.error('Failed to parse terminal.grid SSE', err)
        }
      }

      const handleTerminalEvent = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as {
            event?: string
            data?: Record<string, unknown>
          }

          if (payload.event === 'mode_changed' && payload.data) {
            const { mode, integration } = payload.data as {
              mode?: TerminalMode
              integration?: TerminalIntegration
            }
            if (mode) {
              setTerminalFacts({ mode, integration: integration ?? 'none' })
            }
          }

          if (payload.event === 'output_gap') {
            // Durable output was lost between what we applied and what the
            // server still has — an offset resume would render a hole. A full
            // re-snapshot is the honest recovery.
            console.warn('[terminal] output gap reported — re-snapshotting', {
              threadId,
              data: payload.data,
            })
            snapshotRequiredRef.current = true
            scheduleReconnect('output_gap')
            return
          }

          setTerminalCommand((current) => reduceTerminalCommandChip(current, payload))
        } catch (err) {
          console.error('Failed to parse terminal.event SSE', err)
        }
      }

      const handleBudOffline = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as { bud_id?: string; reason?: string }
          console.warn('[terminal] Bud went offline', payload)
          // The daemon-side ring may restart while offline; re-snapshot on the
          // way back instead of trusting the applied offset.
          snapshotRequiredRef.current = true
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

          // Offline→online transition: full reconnect cycle with a fresh
          // snapshot (ensure → snapshot → stream from the new ring offset).
          snapshotRequiredRef.current = true
          scheduleReconnect('bud_online')
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
        source.removeEventListener('terminal.grid', handleGridFrame)
        source.removeEventListener('terminal.status', handleStatus)
        source.removeEventListener('terminal.event', handleTerminalEvent)
        source.removeEventListener('terminal.bud_offline', handleBudOffline)
        source.removeEventListener('terminal.bud_online', handleBudOnline)
        source.close()
        if (terminalEventSourceRef.current === source) {
          terminalEventSourceRef.current = null
        }
      }

      activeSourceCleanup = cleanupSource

      source.addEventListener('open', () => {
        const wasReconnect = terminalReconnectAttemptRef.current > 0
        terminalReconnectAttemptRef.current = 0
        lastSseEventTimeRef.current = Date.now()

        console.log('[terminal] SSE connected', {
          threadId,
          sessionId: currentSessionIdRef.current,
          wasReconnect,
          fromOffset: appliedOffsetRef.current,
        })

        if (!ensuredBeforeStream) {
          void recoverTerminalSession(wasReconnect ? 'sse_reconnect' : 'sse_open')
        }

        const { heartbeatTimeoutMs, checkIntervalMs } = getThreadStreamHeartbeatConfig(import.meta.env.DEV)
        heartbeatCheckInterval = setInterval(() => {
          if (hasMissedThreadStreamHeartbeat(lastSseEventTimeRef.current, Date.now(), heartbeatTimeoutMs)) {
            console.warn(
              `[terminal] no heartbeat received for ${heartbeatTimeoutMs / 1000}s, connection is stale`,
            )
            scheduleReconnect('heartbeat_timeout')
          }
        }, checkIntervalMs)
      })

      source.addEventListener('heartbeat', handleHeartbeat)
      source.addEventListener('terminal.output', handleOutput)
      source.addEventListener('terminal.grid', handleGridFrame)
      source.addEventListener('terminal.status', handleStatus)
      source.addEventListener('terminal.event', handleTerminalEvent)
      source.addEventListener('terminal.bud_offline', handleBudOffline)
      source.addEventListener('terminal.bud_online', handleBudOnline)
      source.onerror = (err: Event) => {
        void terminalStream.checkUnauthorized().then((unauthorized: boolean) => {
          if (unauthorized) {
            return
          }

          console.warn('[terminal] SSE error', { err, readyState: source.readyState })
          scheduleReconnect(`error ${JSON.stringify(err)}`)
        })
      }
    }

    void connect()

    return () => {
      cancelled = true
      requestReconnectRef.current = null
      cleanupTimers()
      const cleanup = activeSourceCleanup
      activeSourceCleanup = null
      cleanup?.()
      closeSource()
    }
  }, [
    applyGridFrameToState,
    applyHistoryFallback,
    applyTerminalSnapshot,
    budId,
    fitTerminal,
    recoverTerminalSession,
    refreshTerminalStateRecord,
    resetTerminal,
    setConnectionState,
    shouldAbortForUnauthorized,
    terminalRenderer,
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
          if (snapshotRequiredRef.current) {
            // Recovery happened without a bud_online event on this stream —
            // still run the full reconnect cycle so the buffer re-snapshots.
            requestReconnectRef.current?.('recovered_snapshot_required')
          }
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
    sendTerminalInput,
    sendTerminalResize,
    showDisconnectOverlay,
    terminalCommand,
    terminalConnection,
    terminalGridState,
    terminalPredictionGhost,
    terminalHasOutput,
    terminalInputQueued,
    terminalOutputTruncated,
    terminalPaneRef,
    terminalFacts,
    terminalRenderer,
    terminalScrolledToTop,
    terminalState,
  }
}
