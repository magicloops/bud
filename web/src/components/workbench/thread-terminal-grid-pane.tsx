import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  GRID_DEFAULT_BG,
  GRID_DEFAULT_FG,
  gridColorToCss,
  type GridRun,
  type TerminalGridState,
} from '@/features/threads/terminal-grid-state'
import {
  createTerminalPasteIntent,
  detectTerminalInputPlatform,
  logUnsupportedTerminalKeydown,
  translateTerminalKeydown,
} from '@/lib/terminal-input'

/**
 * Grid-sync renderer (plan/terminal-grid-sync phase 2): draws exactly the
 * cell state the server's emulator rendered — no VT parsing, no reflow, no
 * size guessing. DOM rows with per-run spans give native selection/copy for
 * free; dirty-row diffing happens upstream (React re-renders only rows whose
 * run arrays changed identity).
 */

type ThreadTerminalGridPaneProps = {
  state: TerminalGridState
  connected: boolean
  /** Predictive-echo ghost tail rendered after the authoritative cursor. */
  predictionGhost?: string
  onInput: (text: string, options?: { flushImmediately?: boolean }) => void
  onResize: (cols: number, rows: number) => void
}

const FONT_STACK = '"JetBrains Mono", SFMono-Regular, Menlo, monospace'
const FONT_SIZE_PX = 13
const LINE_HEIGHT_PX = 17

function runStyle(run: GridRun): React.CSSProperties {
  const attrs = run.a ?? 0
  const inverse = (attrs & 16) !== 0
  let fg = gridColorToCss(run.fg, GRID_DEFAULT_FG)
  let bg = run.bg === undefined && !inverse ? undefined : gridColorToCss(run.bg, GRID_DEFAULT_BG)
  if (inverse) {
    const swap = fg
    fg = bg ?? GRID_DEFAULT_BG
    bg = swap
  }
  return {
    color: fg,
    ...(bg !== undefined ? { backgroundColor: bg } : {}),
    ...((attrs & 1) !== 0 ? { fontWeight: 700 } : {}),
    ...((attrs & 2) !== 0 ? { opacity: 0.6 } : {}),
    ...((attrs & 4) !== 0 ? { fontStyle: 'italic' } : {}),
    ...((attrs & 8) !== 0 && (attrs & 32) !== 0
      ? { textDecoration: 'underline line-through' }
      : (attrs & 8) !== 0
        ? { textDecoration: 'underline' }
        : (attrs & 32) !== 0
          ? { textDecoration: 'line-through' }
          : {}),
  }
}

function GridRow({ runs }: { runs: GridRun[] }) {
  return (
    <div style={{ height: LINE_HEIGHT_PX, whiteSpace: 'pre' }}>
      {runs.map((run, index) => (
        <span key={index} style={runStyle(run)}>
          {run.t}
        </span>
      ))}
    </div>
  )
}

export function ThreadTerminalGridPane({
  state,
  connected,
  predictionGhost = '',
  onInput,
  onResize,
}: ThreadTerminalGridPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLSpanElement | null>(null)
  const platformRef = useRef(detectTerminalInputPlatform())
  const lastSentDimsRef = useRef<{ cols: number; rows: number } | null>(null)
  const pinnedToBottomRef = useRef(true)

  // Geometry ownership: the renderer measures its own cell box and asks the
  // server for exactly that many cells; frames then arrive at that size (or
  // are rejected by the reducer until the resize's full frame lands).
  const measureAndResize = useCallback(() => {
    const container = containerRef.current
    const measure = measureRef.current
    if (!container || !measure) {
      return
    }
    const rect = container.getBoundingClientRect()
    const cellWidth = measure.getBoundingClientRect().width / 10
    if (rect.width <= 0 || rect.height <= 0 || cellWidth <= 0) {
      return
    }
    const cols = Math.max(2, Math.floor(rect.width / cellWidth))
    const rows = Math.max(2, Math.floor(rect.height / LINE_HEIGHT_PX))
    const last = lastSentDimsRef.current
    if (!last || last.cols !== cols || last.rows !== rows) {
      lastSentDimsRef.current = { cols, rows }
      onResize(cols, rows)
    }
  }, [onResize])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      if (raf !== null) return
      raf = requestAnimationFrame(() => {
        raf = null
        measureAndResize()
      })
    })
    observer.observe(container)
    measureAndResize()
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [measureAndResize])

  // Frames arriving at a size other than the one we asked for mean our resize
  // never took (the mount-time request races session creation and 404s, and a
  // daemon ensure may respawn at the DB spawn-hint size). Re-assert the
  // measured geometry until the stream converges on it ONCE — then stop:
  // another viewer with a different pane size may legitimately own the
  // geometry now (last resize wins), and re-asserting forever would make two
  // viewers fight over the PTY size. A reconnect re-arms the assertion,
  // covering daemon respawns at the stale hint.
  const geometryConvergedRef = useRef(false)
  const prevConnectedRef = useRef(connected)
  useEffect(() => {
    if (connected && !prevConnectedRef.current) {
      geometryConvergedRef.current = false
    }
    prevConnectedRef.current = connected
  }, [connected])
  useEffect(() => {
    const last = lastSentDimsRef.current
    if (!last || !state.seeded) {
      return
    }
    if (state.cols === last.cols && state.rows === last.rows) {
      geometryConvergedRef.current = true
      return
    }
    if (!geometryConvergedRef.current) {
      onResize(last.cols, last.rows)
    }
  }, [state.seeded, state.cols, state.rows, onResize, connected])

  // Keep the view pinned to the live grid unless the user scrolled up.
  const handleScroll = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    pinnedToBottomRef.current =
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - LINE_HEIGHT_PX
  }, [])

  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller && pinnedToBottomRef.current) {
      scroller.scrollTop = scroller.scrollHeight
    }
  }, [state])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const selection = window.getSelection()
      const hasSelection =
        !!selection && !selection.isCollapsed && !!containerRef.current?.contains(selection.anchorNode)
      const intent = translateTerminalKeydown(event.nativeEvent, {
        hasSelection,
        platform: platformRef.current,
      })
      if (intent.kind === 'text' || intent.kind === 'bytes') {
        event.preventDefault()
        event.stopPropagation()
        onInput(intent.text, {
          flushImmediately: intent.kind === 'bytes' && intent.text === '\x03',
        })
        return
      }
      if (intent.kind === 'unsupported') {
        logUnsupportedTerminalKeydown(intent, event.nativeEvent)
      }
    },
    [onInput],
  )

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      const text = event.clipboardData?.getData('text/plain') ?? ''
      const intent = createTerminalPasteIntent(text)
      if (intent.kind !== 'paste') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      onInput(intent.text)
    },
    [onInput],
  )

  const cursorVisible = connected && state.seeded && state.cursor.visible
  // The ghost occupies cells after the cursor; the cursor block sits after
  // the ghost (that's where it will land once the echo is confirmed).
  const ghost = state.predictOk ? predictionGhost : ''
  const ghostCells = Array.from(ghost).length
  const cursorStyle = useMemo<React.CSSProperties>(
    () => ({
      position: 'absolute',
      left: `calc(${state.cursor.col}ch + ${ghostCells}ch)`,
      top: state.cursor.row * LINE_HEIGHT_PX,
      width: '1ch',
      height: LINE_HEIGHT_PX,
      backgroundColor: '#ffffff',
      opacity: 0.65,
      pointerEvents: 'none',
    }),
    [state.cursor.col, state.cursor.row, ghostCells],
  )
  const ghostStyle = useMemo<React.CSSProperties>(
    () => ({
      position: 'absolute',
      left: `${state.cursor.col}ch`,
      top: state.cursor.row * LINE_HEIGHT_PX,
      height: LINE_HEIGHT_PX,
      whiteSpace: 'pre',
      color: GRID_DEFAULT_FG,
      opacity: 0.55,
      textDecoration: 'underline dotted',
      pointerEvents: 'none',
    }),
    [state.cursor.col, state.cursor.row],
  )

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      className="h-full w-full overflow-hidden outline-none"
      style={{
        fontFamily: FONT_STACK,
        fontSize: FONT_SIZE_PX,
        lineHeight: `${LINE_HEIGHT_PX}px`,
        backgroundColor: GRID_DEFAULT_BG,
        color: GRID_DEFAULT_FG,
      }}
      data-testid="terminal-grid-pane"
    >
      {/* Cell measurement probe: 10 monospace cells. */}
      <span
        ref={measureRef}
        aria-hidden
        style={{ position: 'absolute', visibility: 'hidden', whiteSpace: 'pre' }}
      >
        {'W'.repeat(10)}
      </span>
      <div ref={scrollRef} onScroll={handleScroll} className="h-full w-full overflow-y-auto">
        <div className="flex min-h-full flex-col justify-end">
          {!state.altScreen &&
            state.scrollback.map((runs, index) => <GridRow key={`sb-${index}`} runs={runs} />)}
          <div style={{ position: 'relative' }}>
            {state.grid.map((runs, index) => (
              <GridRow key={`row-${index}`} runs={runs} />
            ))}
            {ghost.length > 0 && (
              <span data-testid="terminal-prediction" style={ghostStyle}>
                {ghost}
              </span>
            )}
            {cursorVisible && <div style={cursorStyle} />}
          </div>
        </div>
      </div>
    </div>
  )
}
