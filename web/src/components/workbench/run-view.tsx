import { memo, useEffect, useMemo, useRef } from 'react'

type ViewMode = 'terminal' | 'web'

export type ShellEntry = {
  runId: string | null
  id: string
  command: string
  cwd: string | null
  status: 'running' | 'succeeded' | 'failed'
  stdout: string[]
  stderr: string[]
  exitCode: number | null
  startedAt: number
  finishedAt?: number
}

type RunViewProps = {
  historyEntries: ShellEntry[]
  liveEntries: ShellEntry[]
  view: ViewMode
  status: 'idle' | 'dispatching' | 'streaming'
  hasMoreHistory: boolean
  historyLoading: boolean
  onLoadMoreHistory: () => void
}

const joinChunks = (chunks: string[]) => chunks.join('')

const RunViewComponent = ({
  historyEntries,
  liveEntries,
  view,
  status,
  hasMoreHistory,
  historyLoading,
  onLoadMoreHistory
}: RunViewProps) => {
  const combinedEntries = useMemo(() => [...historyEntries, ...liveEntries], [historyEntries, liveEntries])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const lastEntryRef = useRef<string | null>(null)
  const lastSignatureRef = useRef<string | null>(null)

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = node
      stickRef.current = scrollHeight - (scrollTop + clientHeight) < 48
    }
    node.addEventListener('scroll', handleScroll, { passive: true })
    return () => node.removeEventListener('scroll', handleScroll)
  }, [])

  const lastEntryId = combinedEntries.at(-1)?.runId ?? combinedEntries.at(-1)?.id ?? null
  const combinedLength = combinedEntries.length
  const lastEntrySignature = combinedEntries.length
    ? `${combinedEntries[combinedEntries.length - 1]?.id ?? 'n/a'}:${
        combinedEntries[combinedEntries.length - 1]?.stdout.length ?? 0
      }:${combinedEntries[combinedEntries.length - 1]?.stderr.length ?? 0}:${
        combinedEntries[combinedEntries.length - 1]?.status ?? 'unknown'
      }`
    : null

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const entryChanged = lastEntryRef.current !== lastEntryId
    const signatureChanged = lastSignatureRef.current !== lastEntrySignature
    const shouldStick = stickRef.current || entryChanged || view !== 'terminal'
    lastEntryRef.current = lastEntryId
    lastSignatureRef.current = lastEntrySignature
    if (!shouldStick && !signatureChanged) {
      return
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        node.scrollTop = node.scrollHeight
      })
    })
  }, [combinedLength, lastEntryId, lastEntrySignature, view])

  if (view === 'web') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-muted/30 p-8 text-center">
        <div className="rounded-2xl border-4 border-black bg-card px-10 py-8 shadow-[6px_6px_0px_rgba(0,0,0,1)]">
          <p className="text-lg font-mono font-semibold text-card-foreground">Web preview placeholder</p>
          <p className="text-sm text-muted-foreground">Screencasts or browser mirroring will live here.</p>
        </div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {status === 'streaming' ? 'Collecting output…' : 'No remote output yet'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden" style={{ backgroundColor: 'var(--terminal-bg)' }}>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 py-4 font-mono text-sm leading-relaxed"
        style={{ color: 'var(--terminal-text)' }}
      >
        {hasMoreHistory && (
          <div className="mb-4 flex justify-center">
            <button
              type="button"
              onClick={onLoadMoreHistory}
              disabled={historyLoading}
              className="rounded-md border-2 border-white/40 px-3 py-1 text-xs uppercase tracking-wide text-muted-foreground transition hover:border-white hover:text-white disabled:opacity-50"
            >
              {historyLoading ? 'Loading…' : 'Load older commands'}
            </button>
          </div>
        )}
        {combinedEntries.length === 0 ? (
          <p className="text-muted-foreground">
            {status === 'dispatching' || status === 'streaming' ? 'Preparing command…' : 'No Bud output yet.'}
          </p>
        ) : (
          <div className="space-y-6">
            {combinedEntries.map((entry) => (
              <article key={entry.id} className="space-y-2 border-b border-white/5 pb-4 last:border-none last:pb-0">
                <div className="flex flex-wrap items-baseline gap-2 text-xs tracking-wide text-muted-foreground">
                  <span className="uppercase" style={{ color: 'var(--bud-accent-vibrant)' }}>
                    bud
                  </span>
                  <span className="text-[length:0.75rem] text-muted-foreground">({entry.cwd ?? '~'})</span>
                  <span className="flex-1 min-w-0 text-[color:#a6ff4d] text-sm whitespace-pre-wrap break-words">
                    $ {entry.command}
                  </span>
                  {entry.status === 'running' && (
                    <span className="text-[color:var(--bud-accent-muted)] animate-pulse">running…</span>
                  )}
                </div>
                {entry.stdout.length > 0 && (
                  <pre className="whitespace-pre-wrap text-sm text-white/80">{joinChunks(entry.stdout)}</pre>
                )}
                {entry.stderr.length > 0 && (
                  <pre className="whitespace-pre-wrap text-sm text-destructive">{joinChunks(entry.stderr)}</pre>
                )}
                {entry.status !== 'running' && (
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    {entry.status === 'succeeded' ? 'done' : 'failed'}
                    {typeof entry.exitCode === 'number' ? ` (exit ${entry.exitCode})` : ''}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export const RunView = memo(RunViewComponent)
RunView.displayName = 'RunView'
