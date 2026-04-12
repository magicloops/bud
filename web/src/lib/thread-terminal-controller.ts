import type { Terminal } from 'xterm'
import {
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
    terminal.reset()

    const snapshotText = state.snapshot.text
    if (!snapshotText) {
      this.writeMode = 'idle'
      return
    }

    await new Promise<void>((resolve) => {
      terminal.write(snapshotText, () => resolve())
    })
    this.writeMode = 'idle'
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
