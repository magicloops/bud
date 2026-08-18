/**
 * Predictive local echo (plan/terminal-grid-sync phase 3, proto §6.8.3).
 *
 * mosh-lite "ghost tail" model: locally-typed printable input renders
 * immediately as tentative text at the cursor, tracked per input flush by a
 * client-minted sequence number. A grid frame whose `applied_input_seq`
 * covers a chunk retires it — by then the authoritative echo is (or is about
 * to be) in the grid. Anything unpredictable (control keys, Enter, gate
 * closure, disconnects) conservatively clears all predictions: wrong ghosts
 * are worse than a flash of latency.
 */

export type TerminalPredictionState = {
  /** Flushed input awaiting server ack, oldest first. */
  chunks: Array<{ seq: number; text: string }>
  /** Typed but not yet flushed (no seq assigned). */
  pendingText: string
}

export const emptyPredictionState: TerminalPredictionState = {
  chunks: [],
  pendingText: '',
}

const MAX_PREDICTED_BURST = 32

function isPredictablePrintable(text: string): boolean {
  if (text.length === 0 || text.length > MAX_PREDICTED_BURST) {
    return false
  }
  // Any C0 control or DEL makes the burst unpredictable (escape sequences,
  // newlines, tabs — their echo is not "these chars appear at the cursor").
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(text)
}

/**
 * Account for one keystroke/burst BEFORE it is flushed. Returns the next
 * state; `cleared: true` means the input was unpredictable and all ghosts
 * were dropped (the caller should still send the input normally).
 */
export function predictKeystroke(
  state: TerminalPredictionState,
  text: string,
): { state: TerminalPredictionState; cleared: boolean } {
  if (isPredictablePrintable(text)) {
    return {
      state: { ...state, pendingText: state.pendingText + text },
      cleared: false,
    }
  }
  // Backspace over our own unflushed tail is predictable; over anything
  // older (flushed or confirmed) we bail out entirely.
  if (text === '\u007f' && state.pendingText.length > 0) {
    const chars = Array.from(state.pendingText)
    chars.pop()
    return {
      state: { ...state, pendingText: chars.join('') },
      cleared: false,
    }
  }
  return { state: emptyPredictionState, cleared: true }
}

/** Move pending text into a seq-tracked chunk at flush time. */
export function assignFlushSeq(
  state: TerminalPredictionState,
  seq: number,
): TerminalPredictionState {
  if (state.pendingText.length === 0) {
    return state
  }
  return {
    chunks: [...state.chunks, { seq, text: state.pendingText }],
    pendingText: '',
  }
}

/** Retire chunks the server has applied (their echo is authoritative now). */
export function ackApplied(
  state: TerminalPredictionState,
  appliedSeq: number,
): TerminalPredictionState {
  if (!state.chunks.some((chunk) => chunk.seq <= appliedSeq)) {
    return state
  }
  return {
    ...state,
    chunks: state.chunks.filter((chunk) => chunk.seq > appliedSeq),
  }
}

export function clearPredictions(_state: TerminalPredictionState): TerminalPredictionState {
  return emptyPredictionState
}

/** The ghost text to render after the authoritative cursor. */
export function predictionGhostText(state: TerminalPredictionState): string {
  return state.chunks.map((chunk) => chunk.text).join('') + state.pendingText
}
