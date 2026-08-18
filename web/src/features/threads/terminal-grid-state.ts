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

export type GridCursor = { row: number; col: number; visible: boolean }

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
  /** Cumulative count of known scrollback seams/losses. */
  scrollbackDropped: number
  /** Predictive-echo gate from the latest frame (§6.8.3). */
  predictOk: boolean
  /** Highest server-acked input_seq seen (survives frames that omit it). */
  appliedInputSeq: number | null
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
    scrollbackDropped: 0,
    predictOk: false,
    appliedInputSeq: null,
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

  const grid = frame.full
    ? Array.from({ length: frame.rows }, (): GridRun[] => [])
    : state.grid.slice()
  for (const dirty of frame.dirty_rows) {
    if (dirty.row >= 0 && dirty.row < frame.rows) {
      grid[dirty.row] = dirty.runs
    }
  }

  let scrollback = state.scrollback
  let scrollbackDropped = state.scrollbackDropped + (frame.scrollback_dropped ?? 0)
  if (frame.scrollback_push.length > 0) {
    scrollback = state.scrollback.concat(frame.scrollback_push)
    if (scrollback.length > GRID_SCROLLBACK_CAP) {
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
      scrollbackDropped,
      predictOk: frame.predict_ok ?? false,
      appliedInputSeq:
        frame.applied_input_seq !== undefined
          ? Math.max(frame.applied_input_seq, state.appliedInputSeq ?? 0)
          : state.appliedInputSeq,
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
    return { ...state, scrollback: [] }
  }
  const lines = historyText.split('\n')
  const scrollback: GridRun[][] = lines.map((line) => (line.length > 0 ? [{ t: line }] : []))
  return {
    ...state,
    scrollback: scrollback.slice(Math.max(0, scrollback.length - GRID_SCROLLBACK_CAP)),
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
