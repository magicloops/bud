import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import {
  applyAppCursorKeys,
  encodeTerminalMouseEvent,
  encodeWheelFallbackArrows,
  wheelDeltaToLines,
  type TerminalMouseButton,
} from '@/features/threads/terminal-mouse'

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
  /**
   * Geometry ownership (design/responsive-web-layout.md §3.4): when false
   * the pane is an OBSERVER — it never resizes the shared PTY and renders
   * whatever size frames arrive at inside a pannable container, with
   * keep-cursor-in-view on local activity. Small viewports must not
   * silently reshape the terminal for every other viewer.
   */
  assertGeometry?: boolean
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
    // Inline boxes only paint their font box, leaving the line-height
    // leading unpainted — with app background colors (vim themes) that
    // showed as dark gaps between lines. Cell-height inline-blocks paint
    // the full cell rect, like a real terminal.
    display: 'inline-block',
    height: LINE_HEIGHT_PX,
    lineHeight: `${LINE_HEIGHT_PX}px`,
    verticalAlign: 'top',
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

// Memoized on the runs array identity: delta frames replace only dirty rows'
// arrays, so unchanged rows skip re-rendering entirely (matters at the ~60fps
// full-frame cadence of TUI scrolling).
const GridRow = memo(function GridRow({ runs }: { runs: GridRun[] }) {
  return (
    <div style={{ height: LINE_HEIGHT_PX, whiteSpace: 'pre' }}>
      {runs.map((run, index) => (
        <span key={index} style={runStyle(run)}>
          {run.t}
        </span>
      ))}
    </div>
  )
})

export function ThreadTerminalGridPane({
  state,
  connected,
  predictionGhost = '',
  onInput,
  onResize,
  assertGeometry = true,
}: ThreadTerminalGridPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const gridBlockRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLSpanElement | null>(null)
  // Latest props for native listeners (wheel must be non-passive; window
  // mouseup outlives renders).
  const stateRef = useRef(state)
  const connectedRef = useRef(connected)
  const onInputRef = useRef(onInput)
  stateRef.current = state
  connectedRef.current = connected
  onInputRef.current = onInput
  const pressedButtonRef = useRef<TerminalMouseButton | null>(null)
  const lastMoveCellRef = useRef<{ col: number; row: number } | null>(null)
  const imeRef = useRef<HTMLTextAreaElement | null>(null)
  const composingRef = useRef(false)
  const focusIme = useCallback(() => {
    imeRef.current?.focus({ preventScroll: true })
  }, [])
  // Click-to-focus, selection-aware: completing a drag-selection fires a
  // click on the container, and focusing the IME textarea would move the
  // document selection into it — collapsing the highlight the user just
  // made (the "can't copy from the terminal" bug). With a live selection
  // anchored in the pane, focus the container instead: it never owns a
  // text selection, keydown translation lives on it (typing still works),
  // and the platform copy shortcut targets the intact document selection.
  const handleClick = useCallback(() => {
    const selection = window.getSelection()
    const hasPaneSelection =
      !!selection &&
      !selection.isCollapsed &&
      !!containerRef.current?.contains(selection.anchorNode)
    if (hasPaneSelection) {
      containerRef.current?.focus({ preventScroll: true })
      return
    }
    focusIme()
  }, [focusIme])
  // Terminal convention: filled blinking cursor only while the pane owns
  // keyboard focus; hollow outline otherwise (matches xterm on the bytes
  // path, and disambiguates terminal focus vs. the message composer).
  const [paneFocused, setPaneFocused] = useState(false)
  const handleFocusIn = useCallback(() => setPaneFocused(true), [])
  const handleFocusOut = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    // Focus moving between children (container ↔ IME helper) is not a blur.
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setPaneFocused(false)
    }
  }, [])
  const platformRef = useRef(detectTerminalInputPlatform())
  const lastSentDimsRef = useRef<{ cols: number; rows: number } | null>(null)
  const pinnedToBottomRef = useRef(true)

  // Geometry ownership: the renderer measures its own cell box and asks the
  // server for exactly that many cells; frames then arrive at that size (or
  // are rejected by the reducer until the resize's full frame lands).
  const assertGeometryRef = useRef(assertGeometry)
  assertGeometryRef.current = assertGeometry
  const measureAndResize = useCallback(() => {
    if (!assertGeometryRef.current) {
      return // observer mode: never resize the shared PTY
    }
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
    if (!geometryConvergedRef.current && assertGeometryRef.current) {
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

  /** 0-based cell under a pointer position, in live-grid coordinates. */
  const cellFromPoint = useCallback((clientX: number, clientY: number) => {
    const block = gridBlockRef.current
    const measure = measureRef.current
    const st = stateRef.current
    if (!block || !measure || st.cols === 0 || st.rows === 0) {
      return null
    }
    const cellWidth = measure.getBoundingClientRect().width / 10
    if (cellWidth <= 0) {
      return null
    }
    const rect = block.getBoundingClientRect()
    const col = Math.min(st.cols - 1, Math.max(0, Math.floor((clientX - rect.left) / cellWidth)))
    const row = Math.min(
      st.rows - 1,
      Math.max(0, Math.floor((clientY - rect.top) / LINE_HEIGHT_PX)),
    )
    return { col, row }
  }, [])

  const sendMouse = useCallback(
    (bytes: string | null, flushImmediately = true) => {
      if (bytes) {
        onInputRef.current(bytes, { flushImmediately })
      }
    },
    [],
  )

  // Mouse reporting (§6.8.4): events are encoded only while the app asked
  // for them; Shift bypasses to native browser selection (terminal
  // convention). Wheel in the alt screen without mouse reporting falls back
  // to arrow keys (alternate-scroll); wheel on the primary screen scrolls
  // local scrollback natively.
  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const st = stateRef.current
      if (!connectedRef.current || st.mouse.report === 'none' || event.shiftKey) {
        return
      }
      const button: TerminalMouseButton | null =
        event.button === 0 ? 'left' : event.button === 1 ? 'middle' : event.button === 2 ? 'right' : null
      const cell = cellFromPoint(event.clientX, event.clientY)
      if (!button || !cell) {
        return
      }
      // preventDefault suppresses native selection AND focus — refocus.
      event.preventDefault()
      focusIme()
      pressedButtonRef.current = button
      lastMoveCellRef.current = cell
      sendMouse(
        encodeTerminalMouseEvent({
          kind: 'press',
          button,
          col: cell.col,
          row: cell.row,
          shift: false,
          alt: event.altKey,
          ctrl: event.ctrlKey,
          sgr: st.mouse.sgr,
        }),
      )
    },
    [cellFromPoint, focusIme, sendMouse],
  )

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const st = stateRef.current
      if (!connectedRef.current) {
        return
      }
      const pressed = pressedButtonRef.current
      const wantsMove =
        st.mouse.report === 'motion' || (st.mouse.report === 'drag' && pressed !== null)
      if (!wantsMove) {
        return
      }
      const cell = cellFromPoint(event.clientX, event.clientY)
      if (!cell) {
        return
      }
      const last = lastMoveCellRef.current
      if (last && last.col === cell.col && last.row === cell.row) {
        return
      }
      lastMoveCellRef.current = cell
      sendMouse(
        encodeTerminalMouseEvent({
          kind: 'move',
          button: pressed ?? 'none',
          col: cell.col,
          row: cell.row,
          alt: event.altKey,
          ctrl: event.ctrlKey,
          sgr: st.mouse.sgr,
        }),
        false,
      )
    },
    [cellFromPoint, sendMouse],
  )

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (connectedRef.current && stateRef.current.mouse.report !== 'none' && !event.shiftKey) {
      event.preventDefault()
    }
  }, [])

  // Release can happen outside the pane — listen on the window.
  useEffect(() => {
    const handleMouseUp = (event: MouseEvent) => {
      const pressed = pressedButtonRef.current
      if (!pressed) {
        return
      }
      pressedButtonRef.current = null
      const st = stateRef.current
      if (st.mouse.report === 'none') {
        return
      }
      const cell = cellFromPoint(event.clientX, event.clientY) ?? lastMoveCellRef.current
      if (!cell) {
        return
      }
      const bytes = encodeTerminalMouseEvent({
        kind: 'release',
        button: pressed,
        col: cell.col,
        row: cell.row,
        sgr: st.mouse.sgr,
      })
      if (bytes) {
        onInputRef.current(bytes, { flushImmediately: true })
      }
    }
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [cellFromPoint])

  // Wheel needs a non-passive native listener (React wheel handlers cannot
  // reliably preventDefault).
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) {
      return
    }
    const handleWheel = (event: WheelEvent) => {
      const st = stateRef.current
      if (!connectedRef.current) {
        return
      }
      const lines =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? Math.round(event.deltaY) || (event.deltaY > 0 ? 1 : -1)
          : wheelDeltaToLines(event.deltaY, LINE_HEIGHT_PX)
      if (lines === 0) {
        return
      }
      if (st.mouse.report !== 'none' && !event.shiftKey) {
        event.preventDefault()
        const cell = cellFromPoint(event.clientX, event.clientY)
        if (!cell) {
          return
        }
        const kind = lines > 0 ? 'wheel-down' : 'wheel-up'
        const count = Math.min(8, Math.abs(lines))
        let out = ''
        for (let i = 0; i < count; i += 1) {
          out +=
            encodeTerminalMouseEvent({
              kind,
              button: 'none',
              col: cell.col,
              row: cell.row,
              sgr: st.mouse.sgr,
            }) ?? ''
        }
        if (out) {
          onInputRef.current(out, { flushImmediately: true })
        }
        return
      }
      if (st.altScreen && st.mouse.altScroll) {
        // No local scrollback in the alt screen: wheel becomes arrow keys.
        event.preventDefault()
        const arrows = encodeWheelFallbackArrows(lines, st.appCursor)
        if (arrows) {
          onInputRef.current(arrows, { flushImmediately: true })
        }
      }
      // Primary screen: native scrollback scrolling.
    }
    scroller.addEventListener('wheel', handleWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', handleWheel)
  }, [cellFromPoint])

  // IME composition: the hidden textarea is the real focus target. Regular
  // keydowns are translated and preventDefault'd (so nothing accumulates);
  // composed input (CJK IMEs, dead keys) and non-keyboard insertions (the
  // macOS emoji picker) arrive via compositionend/input and are sent as
  // ordinary text.
  const drainIme = useCallback((value: string) => {
    const ime = imeRef.current
    if (ime) {
      ime.value = ''
    }
    if (value.length > 0) {
      onInputRef.current(value)
    }
  }, [])
  const handleCompositionStart = useCallback(() => {
    composingRef.current = true
  }, [])
  const handleCompositionEnd = useCallback(
    (event: React.CompositionEvent<HTMLTextAreaElement>) => {
      composingRef.current = false
      drainIme(event.data ?? event.currentTarget.value)
    },
    [drainIme],
  )
  const handleImeInput = useCallback(
    (event: React.FormEvent<HTMLTextAreaElement>) => {
      if (composingRef.current) {
        return
      }
      drainIme(event.currentTarget.value)
    },
    [drainIme],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Mid-composition keydowns (keyCode 229) belong to the IME.
      if (event.nativeEvent.isComposing || event.keyCode === 229) {
        return
      }
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
        const text =
          intent.kind === 'bytes'
            ? applyAppCursorKeys(intent.text, stateRef.current.appCursor)
            : intent.text
        onInput(text, {
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
  // DECSCUSR: vim's insert-mode beam, underline shells, etc. Older daemons
  // omit the facts — render a blinking block like the bytes path.
  const cursorElRef = useRef<HTMLDivElement | null>(null)
  // Observer mode keep-cursor-in-view (decision record #3): the PTY may be
  // wider than the phone, so pan the grid to the cursor (and ghost tail)
  // whenever it moves while this pane owns focus — typing stays visible.
  useEffect(() => {
    if (assertGeometry || !paneFocused) {
      return
    }
    cursorElRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [assertGeometry, paneFocused, state.cursor.row, state.cursor.col, predictionGhost])

  const cursorShape = state.cursor.shape ?? 'block'
  const cursorBlink = state.cursor.blink ?? true
  const cursorStyle = useMemo<React.CSSProperties>(() => {
    if (!paneFocused) {
      // Unfocused: a hollow full-cell outline, never blinking — shows where
      // input WOULD go without claiming the keyboard is here.
      return {
        position: 'absolute',
        left: `calc(${state.cursor.col}ch + ${ghostCells}ch)`,
        top: state.cursor.row * LINE_HEIGHT_PX,
        width: '1ch',
        height: LINE_HEIGHT_PX,
        boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.65)',
        pointerEvents: 'none',
      }
    }
    return {
      position: 'absolute',
      left: `calc(${state.cursor.col}ch + ${ghostCells}ch)`,
      top:
        state.cursor.row * LINE_HEIGHT_PX +
        (cursorShape === 'underline' ? LINE_HEIGHT_PX - 2 : 0),
      width: cursorShape === 'beam' ? 2 : '1ch',
      height: cursorShape === 'underline' ? 2 : LINE_HEIGHT_PX,
      backgroundColor: '#ffffff',
      opacity: 0.65,
      pointerEvents: 'none',
      ...(cursorBlink ? { animation: 'bud-grid-cursor-blink 1.06s step-end infinite' } : {}),
    }
  }, [state.cursor.col, state.cursor.row, ghostCells, cursorShape, cursorBlink, paneFocused])
  // The IME helper sits AT the cursor so candidate windows anchor correctly.
  const imeStyle = useMemo<React.CSSProperties>(
    () => ({
      position: 'absolute',
      left: `${state.cursor.col}ch`,
      top: state.cursor.row * LINE_HEIGHT_PX,
      width: '1ch',
      height: LINE_HEIGHT_PX,
      opacity: 0,
      border: 'none',
      padding: 0,
      margin: 0,
      resize: 'none',
      overflow: 'hidden',
      background: 'transparent',
      caretColor: 'transparent',
      outline: 'none',
      // Focus is always programmatic; the helper must never eat clicks or
      // create a 1ch selection dead zone at the cursor.
      pointerEvents: 'none',
      whiteSpace: 'pre',
    }),
    [state.cursor.col, state.cursor.row],
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
      tabIndex={-1}
      onClick={handleClick}
      onFocus={handleFocusIn}
      onBlur={handleFocusOut}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onContextMenu={handleContextMenu}
      className="h-full w-full overflow-hidden outline-none"
      style={{
        fontFamily: FONT_STACK,
        fontSize: FONT_SIZE_PX,
        lineHeight: `${LINE_HEIGHT_PX}px`,
        backgroundColor: GRID_DEFAULT_BG,
        color: GRID_DEFAULT_FG,
        touchAction: 'manipulation',
      }}
      data-testid="terminal-grid-pane"
    >
      <style>{'@keyframes bud-grid-cursor-blink { 50% { opacity: 0 } }'}</style>
      {/* Cell measurement probe: 10 monospace cells. */}
      <span
        ref={measureRef}
        aria-hidden
        style={{ position: 'absolute', visibility: 'hidden', whiteSpace: 'pre' }}
      >
        {'W'.repeat(10)}
      </span>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`h-full w-full ${assertGeometry ? 'overflow-y-auto' : 'overflow-auto'}`}
      >
        <div
          className={`flex min-h-full flex-col justify-end ${assertGeometry ? '' : 'w-max min-w-full'}`}
        >
          {!state.altScreen &&
            state.scrollback.map((runs, index) => (
              // Absolute-index keys: cap trims shift the array but not the
              // identity of surviving rows, so appends/trims never remount
              // them (native selection in scrollback survives streaming).
              <GridRow key={`sb-${state.scrollbackStart + index}`} runs={runs} />
            ))}
          <div ref={gridBlockRef} style={{ position: 'relative' }}>
            {state.grid.map((runs, index) => (
              <GridRow key={`row-${index}`} runs={runs} />
            ))}
            {ghost.length > 0 && (
              <span data-testid="terminal-prediction" style={ghostStyle}>
                {ghost}
              </span>
            )}
            {cursorVisible && (
              <div ref={cursorElRef} data-testid="terminal-cursor" style={cursorStyle} />
            )}
            <textarea
              ref={imeRef}
              style={imeStyle}
              tabIndex={0}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              aria-label="Terminal input"
              data-testid="terminal-ime"
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onInput={handleImeInput}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
