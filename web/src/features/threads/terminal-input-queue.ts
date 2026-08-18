/**
 * Pure queue policy for terminal input typed while the terminal is not
 * connected. Instead of silently discarding keystrokes, input queues (in
 * order) up to a byte cap and flushes as one payload once the connection is
 * back. Beyond the cap the oldest queued chunks are dropped first.
 */

export const TERMINAL_INPUT_QUEUE_MAX_BYTES = 8192

export type TerminalInputQueueState = {
  chunks: string[]
  totalBytes: number
}

export const emptyTerminalInputQueue: TerminalInputQueueState = {
  chunks: [],
  totalBytes: 0,
}

const utf8ByteLength = (text: string) => new TextEncoder().encode(text).byteLength

/** Keep only the trailing `maxBytes` of a chunk, on a UTF-8 code point boundary. */
const trimChunkToTailBytes = (chunk: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(chunk)
  if (bytes.byteLength <= maxBytes) {
    return chunk
  }
  let start = bytes.byteLength - maxBytes
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) {
    start += 1
  }
  return new TextDecoder().decode(bytes.subarray(start))
}

export const enqueueTerminalInput = (
  state: TerminalInputQueueState,
  text: string,
): { state: TerminalInputQueueState; droppedBytes: number } => {
  if (text.length === 0) {
    return { state, droppedBytes: 0 }
  }

  const chunks = [...state.chunks, text]
  let totalBytes = state.totalBytes + utf8ByteLength(text)
  let droppedBytes = 0

  while (totalBytes > TERMINAL_INPUT_QUEUE_MAX_BYTES && chunks.length > 1) {
    const removed = chunks.shift() as string
    const removedBytes = utf8ByteLength(removed)
    totalBytes -= removedBytes
    droppedBytes += removedBytes
  }

  if (totalBytes > TERMINAL_INPUT_QUEUE_MAX_BYTES) {
    const only = chunks[0]
    const trimmed = trimChunkToTailBytes(only, TERMINAL_INPUT_QUEUE_MAX_BYTES)
    const trimmedBytes = utf8ByteLength(trimmed)
    droppedBytes += totalBytes - trimmedBytes
    chunks[0] = trimmed
    totalBytes = trimmedBytes
  }

  return { state: { chunks, totalBytes }, droppedBytes }
}

export const takeQueuedTerminalInput = (
  state: TerminalInputQueueState,
): { state: TerminalInputQueueState; text: string } => ({
  state: emptyTerminalInputQueue,
  text: state.chunks.join(''),
})

export const hasQueuedTerminalInput = (state: TerminalInputQueueState) =>
  state.totalBytes > 0
