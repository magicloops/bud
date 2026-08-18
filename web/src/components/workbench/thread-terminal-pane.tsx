import { useMemo, useState, type ReactNode, type RefObject } from 'react'
import { MoreVertical, Square } from 'lucide-react'
import type { WorkbenchStatus } from '@/components/workbench/workspace-top-bar'
import { TERMINAL_RENDERER_STORAGE_KEY } from '@/features/threads/terminal-renderer'

type ThreadTerminalPaneProps = {
  error: string | null
  status: WorkbenchStatus
  terminalCommand:
    | { status: 'running'; commandId: string | null }
    | { status: 'finished'; commandId: string | null; exitCode: number | null }
    | null
  terminalConnection: 'connected' | 'reconnecting' | 'offline' | 'disconnected'
  terminalHasOutput: boolean
  terminalInputQueued: boolean
  terminalOutputTruncated: boolean
  terminalPaneRef: RefObject<HTMLDivElement | null>
  terminalFacts: {
    mode: 'shell' | 'tui' | 'repl' | 'unknown'
    integration: 'osc133' | 'sentinel' | 'none'
  } | null
  terminalScrolledToTop: boolean
  terminalState: string
  /** Active renderer: `bytes` = xterm over the raw stream, `grid` = grid sync. */
  terminalRenderer?: 'bytes' | 'grid'
  /** Rendered instead of the xterm container when `terminalRenderer` is `grid`. */
  gridPane?: ReactNode
  viewMode: 'terminal' | 'web'
  webViewPane?: ReactNode
  showDisconnectOverlay: boolean
  onCancelAgentTurn: () => void
  onFocusTerminal: () => void
  onInterruptTerminal: () => void
}

export function ThreadTerminalPane({
  error,
  status,
  terminalCommand,
  terminalConnection,
  terminalHasOutput,
  terminalInputQueued,
  terminalOutputTruncated,
  terminalPaneRef,
  terminalFacts,
  terminalScrolledToTop,
  terminalState,
  terminalRenderer = 'bytes',
  gridPane = null,
  viewMode,
  webViewPane = null,
  showDisconnectOverlay,
  onCancelAgentTurn,
  onFocusTerminal,
  onInterruptTerminal,
}: ThreadTerminalPaneProps) {
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false)

  const terminalOverlayMessage = useMemo(() => {
    if (terminalHasOutput) {
      return null
    }
    if (terminalState === 'creating') {
      return 'Creating terminal…'
    }
    if (terminalState === 'ready' || terminalState === 'active') {
      return 'Terminal ready — start typing.'
    }
    return 'Terminal awaiting activity…'
  }, [terminalHasOutput, terminalState])

  const terminalConnectionLabel = useMemo(() => {
    if (terminalConnection === 'reconnecting') {
      return 'Reconnecting…'
    }
    if (terminalConnection === 'disconnected') {
      return 'Disconnected'
    }
    return null
  }, [terminalConnection])

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-black">
      {webViewPane && (
        <div
          aria-hidden={viewMode !== 'web'}
          className={`absolute inset-0 flex flex-col bg-background transition-opacity duration-150 ${
            viewMode === 'web'
              ? 'visible z-10 opacity-100'
              : 'pointer-events-none invisible z-0 opacity-0'
          }`}
        >
          {webViewPane}
        </div>
      )}
      {viewMode === 'terminal' && (
        <div className="flex h-8 items-center justify-between border-b border-border/50 bg-muted/20 px-3 text-xs">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  terminalConnection === 'connected'
                    ? 'bg-green-500'
                    : terminalConnection === 'reconnecting'
                      ? 'animate-pulse bg-yellow-500'
                      : 'bg-red-500'
                }`}
              />
              <span className="font-mono font-semibold uppercase tracking-wide">
                {terminalConnectionLabel ?? `Terminal: ${terminalState}`}
              </span>
              {terminalInputQueued && (
                <span
                  className="rounded border border-yellow-600/50 bg-yellow-900/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-yellow-400"
                  title="Typed input is queued and will be sent when the terminal reconnects"
                >
                  input queued
                </span>
              )}
            </div>
            {terminalFacts && terminalConnection === 'connected' && (
              <div className="flex items-center gap-2 border-l border-border/50 pl-3">
                <span
                  className={`h-2 w-2 rounded-full ${
                    terminalFacts.mode === 'shell'
                      ? 'bg-green-400'
                      : terminalFacts.mode === 'tui'
                        ? 'bg-blue-400'
                        : terminalFacts.mode === 'repl'
                          ? 'bg-cyan-400'
                          : 'bg-zinc-400'
                  }`}
                  title={
                    terminalFacts.integration === 'osc133'
                      ? 'Shell integration active (exact command results)'
                      : terminalFacts.integration === 'sentinel'
                        ? 'Sentinel integration (wrapped commands)'
                        : 'No shell integration'
                  }
                />
                <span className="font-mono uppercase tracking-wide text-muted-foreground">
                  {terminalFacts.mode}
                </span>
              </div>
            )}
            {terminalCommand && terminalConnection === 'connected' && (
              <div className="flex items-center gap-2 border-l border-border/50 pl-3">
                {terminalCommand.status === 'running' ? (
                  <>
                    <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-400" />
                    <span className="font-mono uppercase tracking-wide text-muted-foreground">
                      running
                    </span>
                  </>
                ) : (
                  <>
                    <span
                      className={`h-2 w-2 rounded-full ${
                        terminalCommand.exitCode === null
                          ? 'bg-zinc-400'
                          : terminalCommand.exitCode === 0
                            ? 'bg-green-500'
                            : 'bg-red-500'
                      }`}
                    />
                    <span
                      className={`font-mono uppercase tracking-wide ${
                        terminalCommand.exitCode === null
                          ? 'text-muted-foreground'
                          : terminalCommand.exitCode === 0
                            ? 'text-green-400'
                            : 'text-red-400'
                      }`}
                    >
                      {terminalCommand.exitCode === null
                        ? 'done'
                        : `exit ${terminalCommand.exitCode}`}
                    </span>
                  </>
                )}
              </div>
            )}
            {error && <span className="text-destructive">{error}</span>}
          </div>
          <div className="flex items-center gap-2">
            {(status === 'streaming' || status === 'dispatching') && (
              <button
                type="button"
                onClick={onCancelAgentTurn}
                className="relative flex h-8 w-8 items-center justify-center rounded-full bg-destructive text-destructive-foreground transition hover:bg-destructive/80"
                title="Stop agent"
              >
                <svg className="absolute h-8 w-8 animate-spin" viewBox="0 0 32 32" fill="none">
                  <circle
                    cx="16"
                    cy="16"
                    r="14"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray="60 28"
                    strokeLinecap="round"
                    className="opacity-50"
                  />
                </svg>
                <Square className="h-3 w-3 fill-current" />
              </button>
            )}
            <div className="relative">
              <button
                type="button"
                onClick={() => setTerminalMenuOpen((open) => !open)}
                className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
                title="Terminal options"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
              {terminalMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setTerminalMenuOpen(false)} />
                  <div className="absolute right-0 top-full z-20 mt-1 min-w-[160px] rounded-lg border border-border bg-popover py-1 shadow-lg">
                    <button
                      type="button"
                      onClick={() => {
                        onInterruptTerminal()
                        setTerminalMenuOpen(false)
                      }}
                      disabled={terminalConnection !== 'connected'}
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="font-mono text-xs text-muted-foreground">Ctrl+C</span>
                      <span>Interrupt</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        try {
                          window.localStorage.setItem(
                            TERMINAL_RENDERER_STORAGE_KEY,
                            terminalRenderer === 'grid' ? 'bytes' : 'grid',
                          )
                        } catch {
                          // Storage unavailable — the toggle just won't stick.
                        }
                        // Renderer choice is resolved once per mount; a reload
                        // reconnects the terminal under the new renderer.
                        window.location.reload()
                      }}
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition hover:bg-muted"
                      title="Switch the live terminal renderer (reloads the page)"
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {terminalRenderer === 'grid' ? 'grid' : 'bytes'}
                      </span>
                      <span>
                        {terminalRenderer === 'grid'
                          ? 'Use classic renderer'
                          : 'Use grid renderer (beta)'}
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      <div className={`relative min-h-0 flex-1 overflow-hidden ${viewMode === 'web' ? 'invisible' : ''}`}>
        {terminalRenderer === 'grid' ? (
          <div
            className={`h-full w-full transition-opacity duration-300 ${showDisconnectOverlay ? 'opacity-40' : 'opacity-100'}`}
            style={{ pointerEvents: terminalConnection === 'connected' && viewMode === 'terminal' ? 'auto' : 'none' }}
          >
            {gridPane}
          </div>
        ) : (
          <div
            ref={terminalPaneRef}
            className={`flex h-full w-full flex-col justify-end overflow-hidden font-mono text-sm transition-opacity duration-300 [&>.xterm]:w-full [&>.xterm]:shrink-0 ${showDisconnectOverlay ? 'opacity-40' : 'opacity-100'}`}
            style={{ pointerEvents: terminalConnection === 'connected' && viewMode === 'terminal' ? 'auto' : 'none' }}
            onClick={onFocusTerminal}
          />
        )}
        {showDisconnectOverlay && viewMode === 'terminal' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {terminalState === 'bud_offline' ? (
              <div className="flex items-center gap-2 rounded-lg border-2 border-orange-500/50 bg-orange-500/20 px-4 py-2 text-orange-200">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <span className="font-mono text-sm">Bud offline</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-lg border-2 border-yellow-500/50 bg-yellow-500/20 px-4 py-2 text-yellow-200">
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span className="font-mono text-sm">Reconnecting to terminal…</span>
              </div>
            )}
          </div>
        )}
        {terminalOutputTruncated &&
          terminalScrolledToTop &&
          !showDisconnectOverlay &&
          viewMode === 'terminal' && (
            <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2">
              <div className="flex items-center gap-2 rounded border border-yellow-600/50 bg-yellow-900/80 px-3 py-1 text-xs text-yellow-400 shadow-lg backdrop-blur-sm">
                <span>⚠️</span>
                <span>Earlier output truncated</span>
              </div>
            </div>
          )}
      </div>
      {terminalOverlayMessage && !showDisconnectOverlay && viewMode === 'terminal' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">
          {terminalOverlayMessage}
        </div>
      )}
    </div>
  )
}
