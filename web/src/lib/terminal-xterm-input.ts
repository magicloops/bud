import type { Terminal } from 'xterm'
import type { BrowserTerminalInputSource } from './api'

type ClassifiedTerminalData = {
  data: string
  source: BrowserTerminalInputSource
}

type Disposable = {
  dispose: () => void
}

type InternalCoreService = {
  onData?: (listener: (data: string) => void) => Disposable
  onUserInput?: (listener: () => void) => Disposable
}

type InternalTerminal = Terminal & {
  _core?: {
    coreService?: InternalCoreService
  }
}

type AttachOptions = {
  onData: (event: ClassifiedTerminalData) => void
}

export function attachClassifiedTerminalInput(
  terminal: Terminal,
  options: AttachOptions,
): Disposable {
  const coreService = (terminal as InternalTerminal)._core?.coreService

  if (!coreService?.onData || !coreService.onUserInput) {
    console.warn(
      '[terminal-controller] xterm internal core service unavailable; falling back to public onData classification',
    )
    return terminal.onData((data) => {
      options.onData({ data, source: 'human' })
    })
  }

  let pendingUserInputCount = 0

  const userInputListener = coreService.onUserInput(() => {
    pendingUserInputCount += 1
  })

  const dataListener = coreService.onData((data) => {
    const source: BrowserTerminalInputSource =
      pendingUserInputCount > 0 ? 'human' : 'emulator_protocol'
    if (pendingUserInputCount > 0) {
      pendingUserInputCount -= 1
    }
    options.onData({ data, source })
  })

  return {
    dispose: () => {
      userInputListener.dispose()
      dataListener.dispose()
    },
  }
}
