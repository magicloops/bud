/**
 * Grid-sync client state (plan/terminal-grid-sync phase 2).
 *
 * Pure reducer over `terminal.grid` SSE frames (proto §6.8.2). The server's
 * emulator is authoritative: this module never interprets VT sequences — it
 * applies row deltas, tracks the cursor, and accumulates scrollback pushes.
 * Rendering size mismatches are impossible by construction because the state
 * is only ever what a frame described.
 */

export type GridColor = number | [number, number, number]

export type GridRun = {
  t: string
  fg?: GridColor
  bg?: GridColor
  /** Attr bitfield: 1 bold, 2 dim, 4 italic, 8 underline, 16 inverse, 32 strikeout. */
  a?: number
}

export type GridCursorShape = 'block' | 'underline' | 'beam'

export type GridCursor = {
  row: number
  col: number
  visible: boolean
  /** DECSCUSR shape; absent on older daemons (render as block). */
  shape?: GridCursorShape
  /** DECSCUSR blink; absent on older daemons (render blinking). */
  blink?: boolean
}

export type GridMouseReport = 'none' | 'click' | 'drag' | 'motion'

export type GridMouseModes = {
  report: GridMouseReport
  /** SGR extended coordinate encoding (DECSET 1006). */
  sgr: boolean
  /** Alternate-scroll (DECSET 1007): wheel → arrows in the alt screen. */
  altScroll: boolean
}

export type TerminalGridFrame = {
  generation: number
  full: boolean
  cols: number
  rows: number
  alt_screen: boolean
  cursor: GridCursor
  dirty_rows: Array<{ row: number; runs: GridRun[] }>
  scrollback_push: GridRun[][]
  scrollback_dropped: number
  /** §6.8.3: predictive-echo gate (absent on pre-phase-3 daemons = off). */
  predict_ok?: boolean
  /** §6.8.3: highest client input_seq the daemon has written to the PTY. */
  applied_input_seq?: number
  /** §6.8.4: mouse-reporting facts (absent on older daemons). */
  mouse?: { report: GridMouseReport; sgr: boolean; alt_scroll: boolean }
  /** §6.8.4: DECCKM — arrows must be SS3 (`ESC O x`) when set. */
  app_cursor?: boolean
  /** §6.8.5: scroll hint — shift viewport content up by n rows (negative =
   * down) BEFORE applying dirty rows. Never on full frames. */
  row_shift?: number
}

export type TerminalGridState = {
  /** A full frame has been applied; deltas are only valid against a seed. */
  seeded: boolean
  generation: number
  cols: number
  rows: number
  altScreen: boolean
  cursor: GridCursor
  /** Live viewport rows (length === rows once seeded). */
  grid: GridRun[][]
  /** Accumulated scrolled-off lines, oldest first (capped). */
  scrollback: GridRun[][]
  /**
   * Absolute index of `scrollback[0]` since seeding (advanced when the cap
   * trims the front). Lets renderers key rows stably across trims/appends
   * so appending never remounts surviving rows (native selection survives).
   */
  scrollbackStart: number
  /** Cumulative count of known scrollback seams/losses. */
  scrollbackDropped: number
  /** Predictive-echo gate from the latest frame (§6.8.3). */
  predictOk: boolean
  /** Highest server-acked input_seq seen (survives frames that omit it). */
  appliedInputSeq: number | null
  /** Mouse-reporting facts from the latest frame (§6.8.4). */
  mouse: GridMouseModes
  /** DECCKM application cursor mode from the latest frame. */
  appCursor: boolean
}

export const GRID_SCROLLBACK_CAP = 5000

export function emptyGridState(): TerminalGridState {
  return {
    seeded: false,
    generation: 0,
    cols: 0,
    rows: 0,
    altScreen: false,
    cursor: { row: 0, col: 0, visible: true },
    grid: [],
    scrollback: [],
    scrollbackStart: 0,
    scrollbackDropped: 0,
    predictOk: false,
    appliedInputSeq: null,
    // altScroll defaults ON (real-terminal default): wheel → arrows in the
    // alt screen even against daemons that predate the mouse facts.
    mouse: { report: 'none', sgr: false, altScroll: true },
    appCursor: false,
  }
}

export type ApplyGridFrameResult = {
  state: TerminalGridState
  /**
   * The frame could not be applied against current state (generation gap on
   * a delta, size mismatch, unseeded delta). The caller must recover by
   * reconnecting the grid stream — the watch re-arm produces a fresh full.
   */
  discontinuity: boolean
}

function colorEqual(a: GridColor | undefined, b: GridColor | undefined): boolean {
  if (a === b) {
    return true
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
  }
  return false
}

/** Run-for-run content equality — cheap (rows are short) and exact. */
export function gridRowsEqual(a: GridRun[], b: GridRun[]): boolean {
  if (a === b) {
    return true
  }
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i += 1) {
    const ra = a[i]!
    const rb = b[i]!
    if (
      ra.t !== rb.t ||
      (ra.a ?? 0) !== (rb.a ?? 0) ||
      !colorEqual(ra.fg, rb.fg) ||
      !colorEqual(ra.bg, rb.bg)
    ) {
      return false
    }
  }
  return true
}

export function applyGridFrame(
  state: TerminalGridState,
  frame: TerminalGridFrame,
): ApplyGridFrameResult {
  if (!frame.full) {
    const contiguous =
      state.seeded &&
      frame.generation === state.generation + 1 &&
      frame.cols === state.cols &&
      frame.rows === state.rows
    if (!contiguous) {
      return { state, discontinuity: true }
    }
  }

  let grid: GridRun[][]
  if (frame.full) {
    // Start from the existing rows where geometry matches: rows the frame
    // rewrites with identical content keep their array identity below, so
    // React leaves their DOM (and any native selection in it) untouched.
    const sameGeometry = state.rows === frame.rows && state.cols === frame.cols
    grid = Array.from({ length: frame.rows }, (_, i): GridRun[] =>
      sameGeometry ? (state.grid[i] ?? []) : [],
    )
  } else if (frame.row_shift) {
    // Scroll hint: splice the existing rows by the shift (preserving row
    // array identity for unmoved-content memoization), blank the holes —
    // the frame's dirty rows always cover every hole.
    const shift = frame.row_shift
    grid = Array.from({ length: frame.rows }, (_, i): GridRun[] => {
      const src = i + shift
      return src >= 0 && src < state.grid.length ? state.grid[src]! : []
    })
  } else {
    grid = state.grid.slice()
  }
  for (const dirty of frame.dirty_rows) {
    if (dirty.row >= 0 && dirty.row < frame.rows) {
      // Identity preservation: unchanged content keeps the previous array
      // so row memoization skips it and its DOM survives (full frames
      // stream at TUI cadence; without this every frame collapsed native
      // selection by replacing every row's text nodes).
      const prev = grid[dirty.row]
      grid[dirty.row] = prev && gridRowsEqual(prev, dirty.runs) ? prev : dirty.runs
    }
  }

  let scrollback = state.scrollback
  let scrollbackStart = state.scrollbackStart
  let scrollbackDropped = state.scrollbackDropped + (frame.scrollback_dropped ?? 0)
  if (frame.scrollback_push.length > 0) {
    scrollback = state.scrollback.concat(frame.scrollback_push)
    if (scrollback.length > GRID_SCROLLBACK_CAP) {
      scrollbackStart += scrollback.length - GRID_SCROLLBACK_CAP
      scrollback = scrollback.slice(scrollback.length - GRID_SCROLLBACK_CAP)
    }
  }
  // A full frame after missed generations means missed scrollback pushes too:
  // record the seam (the viewport itself is fully corrected by the frame).
  if (frame.full && state.seeded && frame.generation !== state.generation + 1) {
    scrollbackDropped += 1
  }

  return {
    state: {
      seeded: true,
      generation: frame.generation,
      cols: frame.cols,
      rows: frame.rows,
      altScreen: frame.alt_screen,
      cursor: frame.cursor,
      grid,
      scrollback,
      scrollbackStart,
      scrollbackDropped,
      predictOk: frame.predict_ok ?? false,
      appliedInputSeq:
        frame.applied_input_seq !== undefined
          ? Math.max(frame.applied_input_seq, state.appliedInputSeq ?? 0)
          : state.appliedInputSeq,
      mouse: frame.mouse
        ? { report: frame.mouse.report, sgr: frame.mouse.sgr, altScroll: frame.mouse.alt_scroll }
        : state.mouse,
      appCursor: frame.app_cursor ?? state.appCursor,
    },
    discontinuity: false,
  }
}

/**
 * Seed scrollback from the snapshot endpoint's line-oriented `history_text`
 * (plain text — presentation of historical lines is not preserved; live
 * pushes carry styled runs).
 */
export function seedGridScrollback(
  state: TerminalGridState,
  historyText: string,
): TerminalGridState {
  if (!historyText) {
    return { ...state, scrollback: [], scrollbackStart: 0 }
  }
  const lines = historyText.split('\n')
  const scrollback: GridRun[][] = lines.map((line) => (line.length > 0 ? [{ t: line }] : []))
  return {
    ...state,
    scrollback: scrollback.slice(Math.max(0, scrollback.length - GRID_SCROLLBACK_CAP)),
    scrollbackStart: 0,
  }
}

/** Plain text of one row (for tests/copy fallbacks). */
export function gridRowText(runs: GridRun[]): string {
  return runs.map((run) => run.t).join('')
}

// ---------------------------------------------------------------------------
// Color resolution (256-color palette + truecolor → CSS)
// ---------------------------------------------------------------------------

/** Matches the xterm.js theme the byte-stream renderer uses. */
export const GRID_DEFAULT_FG = '#d1ffe1'
export const GRID_DEFAULT_BG = '#000000'

const ANSI_16: string[] = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
]

export function gridColorToCss(color: GridColor | undefined, fallback: string): string {
  if (color === undefined) {
    return fallback
  }
  if (Array.isArray(color)) {
    return `rgb(${color[0]}, ${color[1]}, ${color[2]})`
  }
  if (color < 16) {
    return ANSI_16[color] ?? fallback
  }
  if (color < 232) {
    // 6×6×6 color cube.
    const index = color - 16
    const levels = [0, 95, 135, 175, 215, 255]
    const r = levels[Math.floor(index / 36) % 6]
    const g = levels[Math.floor(index / 6) % 6]
    const b = levels[index % 6]
    return `rgb(${r}, ${g}, ${b})`
  }
  if (color < 256) {
    const value = 8 + (color - 232) * 10
    return `rgb(${value}, ${value}, ${value})`
  }
  return fallback
}
