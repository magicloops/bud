/**
 * Pure helpers for offset-based terminal stream resume.
 *
 * The service assigns every `terminal.output` SSE event an `id:` equal to the
 * END offset of the chunk in the durable output stream
 * (`byte_offset + decoded byte length`). The browser tracks the highest end
 * offset it has applied to the xterm buffer and resumes with
 * `?from_offset=<appliedOffset>` — the server replays the missed range and
 * live output on one ordered stream, so routine reconnects never need a
 * `term.reset()` or a snapshot.
 *
 * A full snapshot (emulator scrollback + visible screen) is only required on:
 * - initial mount (no applied offset yet)
 * - an `output_gap` terminal.event (durable data loss)
 * - a bud offline→online transition
 */

export type TerminalConnectPlan =
  | { mode: 'snapshot' }
  | { mode: 'resume'; fromOffset: number }

export const planTerminalConnect = (input: {
  snapshotRequired: boolean
  appliedOffset: number | null
}): TerminalConnectPlan => {
  if (input.snapshotRequired || input.appliedOffset === null) {
    return { mode: 'snapshot' }
  }
  return { mode: 'resume', fromOffset: input.appliedOffset }
}

const parseOffset = (raw: string | null | undefined): number | null => {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    return null
  }
  return value
}

/**
 * End offset of a `terminal.output` event: prefer the SSE event id (the
 * server-stamped end offset), fall back to `byte_offset + decodedByteLength`
 * when the id is absent or non-numeric.
 */
export const resolveOutputEndOffset = (input: {
  lastEventId?: string | null
  byteOffset?: number | null
  decodedByteLength: number
}): number | null => {
  const fromEventId = parseOffset(input.lastEventId)
  if (fromEventId !== null) {
    return fromEventId
  }

  if (
    typeof input.byteOffset === 'number' &&
    Number.isInteger(input.byteOffset) &&
    input.byteOffset >= 0
  ) {
    return input.byteOffset + input.decodedByteLength
  }

  return null
}

/** Applied offsets only move forward; replayed/duplicate events never regress the cursor. */
export const advanceAppliedOffset = (
  current: number | null,
  eventEndOffset: number | null,
): number | null => {
  if (eventEndOffset === null) {
    return current
  }
  if (current === null) {
    return eventEndOffset
  }
  return Math.max(current, eventEndOffset)
}

export const buildTerminalStreamPath = (
  threadId: string,
  fromOffset: number | null,
): string => {
  const base = `/api/threads/${threadId}/terminal/stream`
  return fromOffset === null ? base : `${base}?from_offset=${fromOffset}`
}

/**
 * Compose snapshot text for the xterm buffer: emulator scrollback lines
 * (oldest→newest, "\n"-joined) above the visible screen grid. `convertEol`
 * in the terminal handles "\n" → CRLF.
 */
export const buildTerminalSnapshotText = (
  historyText: string,
  screenText: string,
  screenAnsi?: string,
): string => {
  // Prefer the ANSI-serialized screen when the daemon provides it: it carries
  // SGR colors/styles and a final cursor-position sequence, so reloading into
  // a colorful TUI (codex, vim) reproduces presentation, not just content.
  // It already uses explicit CRLF row separators and must be appended after
  // a newline so it starts at column 0 of a fresh row.
  const screen = screenAnsi || screenText
  if (!historyText) {
    return screen
  }
  if (!screen) {
    return historyText
  }
  return `${historyText}\n${screen}`
}
