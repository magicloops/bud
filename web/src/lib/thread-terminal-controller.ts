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

export class ThreadTerminalController {
  private readonly transport: TerminalTransport
  private readonly onTransportError?: (error: unknown) => void

  private terminal: Terminal | null = null
  private inputSubscription: Disposable | null = null
  private connectionState: TerminalConnectionState = 'disconnected'
  private pendingText = ''
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private sendQueue: Promise<void> = Promise.resolve()
  private lastRenderedByteOffset = 0
  private sessionId: string | null = null

  constructor(options: ThreadTerminalControllerOptions) {
    this.transport = options.transport
    this.onTransportError = options.onTransportError
  }

  attachTerminal(terminal: Terminal) {
    this.inputSubscription?.dispose()
    this.terminal = terminal
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

    terminal.reset()

    if (state.bootstrap.kind === 'unavailable') {
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
        return
      }

      const degradedText = trimTrailingBlankSnapshotLines(gridBootstrapToText(state.bootstrap))
      if (!degradedText.text) {
        return
      }

      await new Promise<void>((resolve) => {
        terminal.write(degradedText.text, () => resolve())
      })
      return
    }

    const trimmedSnapshot = trimTrailingBlankSnapshotLines(state.bootstrap.text)
    const snapshotText = trimmedSnapshot.text
    if (!snapshotText) {
      return
    }

    await new Promise<void>((resolve) => {
      terminal.write(snapshotText, () => resolve())
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
      return
    }

    const skipBytes = Math.max(this.lastRenderedByteOffset - byteOffset, 0)
    const nextChunk = skipBytes > 0 ? decodeTerminalChunk(data, skipBytes) : fullChunk
    if (!nextChunk.text) {
      this.lastRenderedByteOffset = endOffset
      return
    }

    terminal.write(nextChunk.text)
    this.lastRenderedByteOffset = endOffset
  }

  private handleClassifiedInput(data: string, source: BrowserTerminalInputSource) {
    if (this.connectionState !== 'connected') {
      return
    }

    if (source === 'emulator_protocol') {
      void this.flushPendingText()
      this.enqueue(async () => {
        await this.transport.sendRaw(data, source)
      })
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
      })
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
      })
      return
    }

    this.enqueue(async () => {
      await this.transport.sendRaw(action.input, source)
    })
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
    })
  }

  private enqueue(operation: () => Promise<void>) {
    const run = async () => {
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
