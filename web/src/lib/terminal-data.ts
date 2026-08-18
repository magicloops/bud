const base64ToBytes = (data: string): Uint8Array | null => {
  if (typeof atob !== 'function') {
    return null
  }

  try {
    const binary = atob(data)
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

export type DecodedTerminalChunk = {
  /** Decoded text; may be shorter than the byte payload when a UTF-8 code point is still incomplete. */
  text: string
  /** Raw decoded byte length of the chunk (before UTF-8 interpretation). */
  byteLength: number
}

export type TerminalStreamDecoder = {
  decode: (base64: string) => DecodedTerminalChunk
  reset: () => void
}

/**
 * Stateful UTF-8 decoder for terminal output chunks arriving over one SSE
 * connection. The service chunks output at byte boundaries (≤16 KiB), so a
 * multi-byte code point can be split across two `terminal.output` events —
 * a stateless `TextDecoder` per chunk corrupts those boundaries. This wrapper
 * keeps one `TextDecoder` in streaming mode; callers must `reset()` whenever
 * the xterm buffer is reset or a new SSE connection opens.
 */
export const createTerminalStreamDecoder = (): TerminalStreamDecoder => {
  let decoder = new TextDecoder()

  return {
    decode: (base64: string): DecodedTerminalChunk => {
      const bytes = base64ToBytes(base64)
      if (!bytes) {
        return { text: '', byteLength: 0 }
      }
      return {
        text: decoder.decode(bytes, { stream: true }),
        byteLength: bytes.byteLength,
      }
    },
    reset: () => {
      decoder = new TextDecoder()
    },
  }
}

/**
 * One-shot decode for self-contained payloads (e.g. the byte-tail history
 * fallback). Never use this for streamed `terminal.output` chunks — chunk
 * boundaries can split UTF-8 code points; use `createTerminalStreamDecoder`.
 */
export const decodeTerminalData = (data: string) => {
  const bytes = base64ToBytes(data)
  if (!bytes) {
    return ''
  }

  try {
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}
