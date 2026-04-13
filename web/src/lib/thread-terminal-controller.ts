import type { Terminal } from 'xterm'
import {
  type ApiTerminalBootstrap,
  decodeTerminalChunk,
  type ApiTerminalSendRequest,
  type ApiTerminalState,
  type BrowserTerminalInputSource,
} from './api'
import { attachClassifiedTerminalInput } from './terminal-xterm-input'

type Disposable = {
  dispose: () => void
}

type TerminalConnectionState = 'connected' | 'reconnecting' | 'offline' | 'disconnected'

type StructuredHumanInputAction =
  | { kind: 'text'; text: string }
  | { kind: 'send'; request: Pick<ApiTerminalSendRequest, 'text' | 'submit' | 'keys'> }
  | { kind: 'interrupt' }
  | { kind: 'raw'; input: string }

type TerminalTransport = {
  send: (request: ApiTerminalSendRequest) => Promise<void>
  sendRaw: (input: string, source: BrowserTerminalInputSource) => Promise<void>
  interrupt: () => Promise<void>
}

type ThreadTerminalControllerOptions = {
  transport: TerminalTransport
  debug?: boolean
  onTransportError?: (error: unknown) => void
}

const ESCAPE_SEQUENCE_TO_KEY = new Map<string, string>([
  ['\u001b[A', 'Up'],
  ['\u001bOA', 'Up'],
  ['\u001b[B', 'Down'],
  ['\u001bOB', 'Down'],
  ['\u001b[C', 'Right'],
  ['\u001bOC', 'Right'],
  ['\u001b[D', 'Left'],
  ['\u001bOD', 'Left'],
  ['\u001b[F', 'End'],
  ['\u001bOF', 'End'],
  ['\u001b[H', 'Home'],
  ['\u001bOH', 'Home'],
  ['\u001b[3~', 'Delete'],
  ['\u001b[5~', 'PageUp'],
  ['\u001b[6~', 'PageDown'],
])

const UNSUPPORTED_CONTROL_CHARACTER_PATTERN = /[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/

function truncateDebugText(value: string, maxLength = 160) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, maxLength - 3)}...`
}

function summarizeTerminalTextForDebug(text: string) {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.length === 0 ? [] : normalized.split('\n')
  let trailingBlankLines = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? '').trim().length === 0) {
      trailingBlankLines += 1
      continue
    }
    break
  }

  let lastNonEmptyLine = ''
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if ((lines[index] ?? '').trim().length > 0) {
      lastNonEmptyLine = lines[index] ?? ''
      break
    }
  }

  const lastLine = lines.length > 0 ? (lines[lines.length - 1] ?? '') : ''

  return {
    lineCount: lines.length,
    trailingBlankLines,
    endsWithNewline: normalized.endsWith('\n'),
    lastLineLength: lastLine.length,
    lastLine: truncateDebugText(lastLine),
    lastNonEmptyLine: truncateDebugText(lastNonEmptyLine),
  }
}

function trimTrailingBlankSnapshotLines(text: string) {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.length === 0 ? [] : normalized.split('\n')
  let endIndex = lines.length
  while (endIndex > 0 && (lines[endIndex - 1] ?? '').trim().length === 0) {
    endIndex -= 1
  }

  return {
    text: lines.slice(0, endIndex).join('\n'),
    trimmedTrailingBlankLines: lines.length - endIndex,
  }
}

function gridBootstrapToText(bootstrap: Extract<ApiTerminalBootstrap, { kind: 'grid' }>) {
  return bootstrap.screen.lines.join('\n')
}

function buildGridBootstrapRenderSequence(
  bootstrap: Extract<ApiTerminalBootstrap, { kind: 'grid' }>
) {
  const parts = ['\u001b[2J', '\u001b[H']
  const rowCount = bootstrap.screen.lines.length

  for (let row = 0; row < rowCount; row += 1) {
    const line = bootstrap.screen.lines[row] ?? ''
    parts.push(`\u001b[${row + 1};1H`)
    if (line.length > 0) {
      parts.push(line)
    }
  }

  const finalRow = Math.max(0, Math.min(bootstrap.cursor.row, Math.max(bootstrap.pane.rows - 1, 0)))
  const finalCol = Math.max(0, Math.min(bootstrap.cursor.col, Math.max(bootstrap.pane.cols - 1, 0)))
  parts.push(`\u001b[${finalRow + 1};${finalCol + 1}H`)

  switch (bootstrap.cursor.shape) {
    case 'block':
      parts.push('\u001b[2 q')
      break
    case 'underline':
      parts.push('\u001b[4 q')
      break
    case 'bar':
      parts.push('\u001b[6 q')
      break
    default:
      break
  }

  parts.push(bootstrap.cursor.visible ? '\u001b[?25h' : '\u001b[?25l')
  return parts.join('')
}

function summarizeTerminalBootstrapForDebug(bootstrap: ApiTerminalBootstrap) {
  if (bootstrap.kind === 'grid') {
    return {
      kind: bootstrap.kind,
      source: bootstrap.source,
      captureScope: bootstrap.capture_scope,
      pane: bootstrap.pane,
      cursor: bootstrap.cursor,
      paneMode: bootstrap.pane_mode ?? null,
      screen: summarizeTerminalTextForDebug(gridBootstrapToText(bootstrap)),
      trailingSpacesPreserved: bootstrap.screen.trailing_spaces_preserved,
      wraps: bootstrap.screen.wraps ?? null,
    }
  }

  if (bootstrap.kind === 'text') {
    return {
      kind: bootstrap.kind,
      source: bootstrap.source,
      pane: bootstrap.pane,
      degradedReason: bootstrap.degraded_reason,
      captureScope: bootstrap.capture_scope ?? null,
      text: summarizeTerminalTextForDebug(bootstrap.text),
    }
  }

  return {
    kind: bootstrap.kind,
    reason: bootstrap.reason,
  }
}

function readTerminalBufferMetrics(terminal: Terminal | null) {
  if (!terminal) {
    return null
  }

  const activeBuffer = terminal.buffer.active
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    cursorX: activeBuffer.cursorX,
    cursorY: activeBuffer.cursorY,
    viewportY: activeBuffer.viewportY,
    baseY: activeBuffer.baseY,
    bufferLength: activeBuffer.length,
    cursorAtViewportBottom: activeBuffer.cursorY >= terminal.rows - 1,
  }
}

export class ThreadTerminalController {
  private readonly transport: TerminalTransport
  private readonly debugEnabled: boolean
  private readonly onTransportError?: (error: unknown) => void

  private terminal: Terminal | null = null
  private inputSubscription: Disposable | null = null
  private connectionState: TerminalConnectionState = 'disconnected'
  private writeMode: 'idle' | 'bootstrap' | 'live' = 'idle'
  private pendingText = ''
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private sendQueue: Promise<void> = Promise.resolve()
  private lastRenderedByteOffset = 0
  private sessionId: string | null = null

  constructor(options: ThreadTerminalControllerOptions) {
    this.transport = options.transport
    this.debugEnabled = options.debug ?? import.meta.env.DEV
    this.onTransportError = options.onTransportError
  }

  attachTerminal(terminal: Terminal) {
    this.inputSubscription?.dispose()
    this.terminal = terminal
    this.debug('attached xterm instance to terminal controller', {
      terminal: readTerminalBufferMetrics(terminal),
    })
    this.inputSubscription = attachClassifiedTerminalInput(terminal, {
      onData: (event) => {
        this.handleClassifiedInput(event.data, event.source)
      },
    })
  }

  dispose() {
    this.inputSubscription?.dispose()
    this.inputSubscription = null
    this.terminal = null
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pendingText = ''
  }

  setConnectionState(state: TerminalConnectionState) {
    this.connectionState = state
  }

  getLastRenderedByteOffset() {
    return this.lastRenderedByteOffset
  }

  getSessionId() {
    return this.sessionId
  }

  async applyStateSnapshot(state: ApiTerminalState) {
    this.sessionId = state.session_id
    this.lastRenderedByteOffset = Math.max(state.latest_byte_offset, 0)

    const terminal = this.terminal
    if (!terminal) {
      return
    }

    this.writeMode = 'bootstrap'
    const bootstrapSummary = summarizeTerminalBootstrapForDebug(state.bootstrap)
    const terminalBefore = readTerminalBufferMetrics(terminal)
    this.debug('applying terminal state snapshot', {
      sessionId: state.session_id,
      latestByteOffset: this.lastRenderedByteOffset,
      bootstrap: bootstrapSummary,
      terminalBefore,
    })
    terminal.reset()

    if (state.bootstrap.kind === 'unavailable') {
      this.writeMode = 'idle'
      this.debug('applied unavailable terminal bootstrap', {
        sessionId: state.session_id,
        bootstrap: bootstrapSummary,
        terminalAfter: readTerminalBufferMetrics(terminal),
      })
      return
    }

    if (state.bootstrap.kind === 'grid') {
      const geometryMismatch =
        terminal.cols > 0 &&
        terminal.rows > 0 &&
        (terminal.cols !== state.bootstrap.pane.cols || terminal.rows !== state.bootstrap.pane.rows)

      if (!geometryMismatch) {
        const renderSequence = buildGridBootstrapRenderSequence(state.bootstrap)
        await new Promise<void>((resolve) => {
          terminal.write(renderSequence, () => resolve())
        })
        this.writeMode = 'idle'
        this.debug('applied grid terminal bootstrap', {
          sessionId: state.session_id,
          latestByteOffset: this.lastRenderedByteOffset,
          bootstrap: bootstrapSummary,
          terminalAfter: readTerminalBufferMetrics(terminal),
        })
        return
      }

      this.debug('degrading grid terminal bootstrap to text fallback', {
        sessionId: state.session_id,
        latestByteOffset: this.lastRenderedByteOffset,
        bootstrap: bootstrapSummary,
        terminalGeometry: {
          cols: terminal.cols,
          rows: terminal.rows,
        },
      })

      const degradedText = trimTrailingBlankSnapshotLines(gridBootstrapToText(state.bootstrap))
      const degradedSummary = summarizeTerminalTextForDebug(degradedText.text)
      if (!degradedText.text) {
        this.writeMode = 'idle'
        this.debug('applied empty degraded text bootstrap', {
          sessionId: state.session_id,
          bootstrap: bootstrapSummary,
          trimmedTrailingBlankLines: degradedText.trimmedTrailingBlankLines,
          terminalAfter: readTerminalBufferMetrics(terminal),
        })
        return
      }

      await new Promise<void>((resolve) => {
        terminal.write(degradedText.text, () => resolve())
      })
      this.writeMode = 'idle'
      this.debug('applied degraded text bootstrap from grid capture', {
        sessionId: state.session_id,
        latestByteOffset: this.lastRenderedByteOffset,
        bootstrap: bootstrapSummary,
        degradedText: degradedSummary,
        trimmedTrailingBlankLines: degradedText.trimmedTrailingBlankLines,
        terminalAfter: readTerminalBufferMetrics(terminal),
      })
      return
    }

    const trimmedSnapshot = trimTrailingBlankSnapshotLines(state.bootstrap.text)
    const trimmedSnapshotSummary = summarizeTerminalTextForDebug(trimmedSnapshot.text)
    const snapshotText = trimmedSnapshot.text
    if (!snapshotText) {
      this.writeMode = 'idle'
      this.debug('applied empty text terminal bootstrap', {
        sessionId: state.session_id,
        bootstrap: bootstrapSummary,
        trimmedTrailingBlankLines: trimmedSnapshot.trimmedTrailingBlankLines,
        terminalAfter: readTerminalBufferMetrics(terminal),
      })
      return
    }

    await new Promise<void>((resolve) => {
      terminal.write(snapshotText, () => resolve())
    })
    this.writeMode = 'idle'
    this.debug('applied text terminal bootstrap', {
      sessionId: state.session_id,
      latestByteOffset: this.lastRenderedByteOffset,
      bootstrap: bootstrapSummary,
      trimmedSnapshot: trimmedSnapshotSummary,
      trimmedTrailingBlankLines: trimmedSnapshot.trimmedTrailingBlankLines,
      terminalAfter: readTerminalBufferMetrics(terminal),
    })
  }

  writeOutput(data: string, byteOffset: number) {
    const terminal = this.terminal
    if (!terminal) {
      return
    }

    const fullChunk = decodeTerminalChunk(data)
    const endOffset = byteOffset + fullChunk.byteLength
    if (endOffset <= this.lastRenderedByteOffset) {
      this.debug('dropping already-rendered terminal output chunk', {
        sessionId: this.sessionId,
        byteOffset,
        endOffset,
        lastRenderedByteOffset: this.lastRenderedByteOffset,
      })
      return
    }

    const skipBytes = Math.max(this.lastRenderedByteOffset - byteOffset, 0)
    if (skipBytes > 0) {
      this.debug('trimming overlapping terminal output chunk', {
        sessionId: this.sessionId,
        byteOffset,
        endOffset,
        lastRenderedByteOffset: this.lastRenderedByteOffset,
        skipBytes,
      })
    }
    const nextChunk = skipBytes > 0 ? decodeTerminalChunk(data, skipBytes) : fullChunk
    if (!nextChunk.text) {
      this.lastRenderedByteOffset = endOffset
      return
    }

    this.writeMode = 'live'
    terminal.write(nextChunk.text)
    this.lastRenderedByteOffset = endOffset
    this.writeMode = 'idle'
  }

  private handleClassifiedInput(data: string, source: BrowserTerminalInputSource) {
    if (this.connectionState !== 'connected') {
      this.debug('dropping terminal input while disconnected', {
        source,
        bytes: data.length,
        connectionState: this.connectionState,
      })
      return
    }

    if (source === 'emulator_protocol') {
      void this.flushPendingText()
      this.enqueue(async () => {
        await this.transport.sendRaw(data, source)
      }, { source, mode: this.writeMode, path: 'raw_protocol' })
      return
    }

    const action = parseHumanTerminalInput(data)
    if (action.kind === 'text') {
      this.pendingText += action.text
      this.scheduleTextFlush()
      return
    }

    void this.flushPendingText()

    if (action.kind === 'interrupt') {
      this.enqueue(async () => {
        await this.transport.interrupt()
      }, { source, mode: this.writeMode, path: 'interrupt' })
      return
    }

    if (action.kind === 'send') {
      this.enqueue(async () => {
        await this.transport.send({
          ...action.request,
          observe: null,
          source,
          raw_input: data,
        })
      }, { source, mode: this.writeMode, path: 'structured_send' })
      return
    }

    this.enqueue(async () => {
      await this.transport.sendRaw(action.input, source)
    }, { source, mode: this.writeMode, path: 'raw_human' })
  }

  private scheduleTextFlush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushPendingText()
    }, 20)
  }

  private flushPendingText() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    const text = this.pendingText
    if (!text) {
      return this.sendQueue
    }

    this.pendingText = ''
    return this.enqueue(async () => {
      await this.transport.send({
        text,
        observe: null,
        source: 'human',
        raw_input: text,
      })
    }, { source: 'human', mode: this.writeMode, path: 'structured_text' })
  }

  private enqueue(operation: () => Promise<void>, details: Record<string, unknown>) {
    const run = async () => {
      this.debug('dispatching terminal outbound event', details)
      try {
        await operation()
      } catch (error) {
        this.onTransportError?.(error)
        throw error
      }
    }

    this.sendQueue = this.sendQueue.catch(() => undefined).then(run)
    return this.sendQueue
  }

  private debug(message: string, details?: Record<string, unknown>) {
    if (!this.debugEnabled) {
      return
    }

    console.debug(`[terminal-controller] ${message}`, details ?? {})
  }
}

export function createThreadTerminalController(options: ThreadTerminalControllerOptions) {
  return new ThreadTerminalController(options)
}

function parseHumanTerminalInput(data: string): StructuredHumanInputAction {
  if (data === '\u0003') {
    return { kind: 'interrupt' }
  }
  if (data === '\r' || data === '\n') {
    return { kind: 'send', request: { submit: true } }
  }

  if (data === '\t') {
    return { kind: 'send', request: { keys: ['Tab'] } }
  }

  if (data === '\u007f') {
    return { kind: 'send', request: { keys: ['Backspace'] } }
  }

  if (data === '\u001b') {
    return { kind: 'send', request: { keys: ['Escape'] } }
  }
  const mappedKey = ESCAPE_SEQUENCE_TO_KEY.get(data)
  if (mappedKey) {
    return { kind: 'send', request: { keys: [mappedKey] } }
  }

  if (!data.includes('\u001b') && !UNSUPPORTED_CONTROL_CHARACTER_PATTERN.test(data)) {
    return { kind: 'text', text: data }
  }

  return { kind: 'raw', input: data }
}
