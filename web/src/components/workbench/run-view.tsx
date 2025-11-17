type ViewMode = 'terminal' | 'web'

type RunViewProps = {
  logs: string[]
  view: ViewMode
  runId: string | null
  status: 'idle' | 'dispatching' | 'streaming'
}

export function RunView({ logs, view, status }: RunViewProps) {
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
    <div
      className="flex flex-1 overflow-y-auto px-6 py-4 font-mono text-sm leading-relaxed"
      style={{ backgroundColor: 'var(--terminal-bg)', color: 'var(--terminal-text)' }}
    >
      {logs.length === 0 ? (
        <p className="text-muted-foreground">No stdout/stderr yet.</p>
      ) : (
        <div className="space-y-1">
          {logs.map((line, idx) => (
            <div key={idx}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}
