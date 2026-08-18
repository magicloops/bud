/**
 * Mouse event encoding for the grid renderer (proto §6.8.4).
 *
 * Events are encoded only when the application enabled mouse reporting
 * (DECSET facts on grid frames). SGR (1006) is the primary encoding; the
 * legacy X10 byte encoding is supported for old apps with coordinates
 * clamped to its ASCII-safe range (the input channel is UTF-8 text, so the
 * high-byte legacy range cannot be carried faithfully — modern apps all use
 * SGR).
 */

const ESC = String.fromCharCode(27)
const CSI = `${ESC}[`

export type TerminalMouseKind = 'press' | 'release' | 'move' | 'wheel-up' | 'wheel-down'
export type TerminalMouseButton = 'left' | 'middle' | 'right' | 'none'

export type TerminalMouseEvent = {
  kind: TerminalMouseKind
  button: TerminalMouseButton
  /** 0-based cell coordinates. */
  col: number
  row: number
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
  /** SGR extended encoding enabled (DECSET 1006). */
  sgr: boolean
}

const BUTTON_CODES: Record<TerminalMouseButton, number> = {
  left: 0,
  middle: 1,
  right: 2,
  none: 3,
}

function buttonCode(event: TerminalMouseEvent): number {
  let code: number
  if (event.kind === 'wheel-up') {
    code = 64
  } else if (event.kind === 'wheel-down') {
    code = 65
  } else {
    code = BUTTON_CODES[event.button]
  }
  if (event.kind === 'move') {
    code += 32
  }
  if (event.shift) code += 4
  if (event.alt) code += 8
  if (event.ctrl) code += 16
  return code
}

/** Encode one mouse event, or null when it cannot be represented. */
export function encodeTerminalMouseEvent(event: TerminalMouseEvent): string | null {
  const col = Math.max(0, event.col) + 1
  const row = Math.max(0, event.row) + 1
  if (event.sgr) {
    const code = buttonCode(event)
    const suffix = event.kind === 'release' ? 'm' : 'M'
    return `${CSI}<${code};${col};${row}${suffix}`
  }
  // Legacy X10: CSI M then 32+code, 32+x, 32+y as single bytes. Release is
  // always button 3. Coordinates clamp to the 7-bit-safe range (94) because
  // the transport is UTF-8 text.
  const code = event.kind === 'release' ? BUTTON_CODES.none + (buttonCode(event) & 28) : buttonCode(event)
  const x = Math.min(col, 94)
  const y = Math.min(row, 94)
  return `${CSI}M${String.fromCharCode(32 + code)}${String.fromCharCode(32 + x)}${String.fromCharCode(32 + y)}`
}

/**
 * Wheel fallback when the app did NOT enable mouse reporting but the view is
 * the alternate screen: arrow keys, the alternate-scroll convention (DECSET
 * 1007, default-on in real terminals). Returns '' outside that case's inputs.
 */
export function encodeWheelFallbackArrows(deltaLines: number, appCursor = false): string {
  if (deltaLines === 0) {
    return ''
  }
  const count = Math.min(8, Math.max(1, Math.abs(deltaLines)))
  const prefix = appCursor ? `${ESC}O` : CSI
  const key = deltaLines > 0 ? `${prefix}B` : `${prefix}A`
  return key.repeat(count)
}

/**
 * DECCKM rewrite for key bytes: CSI cursor keys become SS3 when the app set
 * application cursor mode (pagers like `less` ignore CSI arrows in smkx).
 */
export function applyAppCursorKeys(text: string, appCursor: boolean): string {
  if (!appCursor) {
    return text
  }
  return text.replaceAll(new RegExp(`${ESC}\\[([ABCDHF])`, 'g'), `${ESC}O$1`)
}

/** Pixel wheel delta → whole lines (at the renderer's line height). */
export function wheelDeltaToLines(deltaY: number, lineHeightPx: number): number {
  if (deltaY === 0) {
    return 0
  }
  const lines = Math.round(deltaY / lineHeightPx)
  if (lines === 0) {
    return deltaY > 0 ? 1 : -1
  }
  return lines
}
