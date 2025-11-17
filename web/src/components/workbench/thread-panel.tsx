import { useEffect, useMemo, useState } from 'react'
import { Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getMutedColor, resolveCssVar } from '@/lib/theme-colors'
import { Button } from '@/components/ui/button'

export type ThreadSummary = {
  thread_id: string
  bud_id: string
  title: string | null
  created_at: string
  last_activity_at?: string | null
  last_message_preview?: string | null
  message_count?: number
  pinned?: boolean
  archived?: boolean
}

type ThreadPanelProps = {
  threads: ThreadSummary[]
  activeThreadId: string | null
  onSelectThread: (threadId: string | null) => void
  accentColor: string
  budLabel: string
}

function relativeTime(iso: string) {
  const created = new Date(iso)
  const seconds = Math.max(0, (Date.now() - created.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return created.toLocaleDateString()
}

export function ThreadPanel({ threads, activeThreadId, onSelectThread, accentColor, budLabel }: ThreadPanelProps) {
  const [mutedColor, setMutedColor] = useState(accentColor ?? 'var(--accent)')

  useEffect(() => {
    const resolved = resolveCssVar(accentColor ?? 'var(--accent)')
    setMutedColor(getMutedColor(resolved, 0.35))
  }, [accentColor])

  const orderedThreads = useMemo(
    () =>
      [...threads].sort((a, b) => {
        const aTs = new Date(a.last_activity_at ?? a.created_at).getTime()
        const bTs = new Date(b.last_activity_at ?? b.created_at).getTime()
        return bTs - aTs
      }),
    [threads]
  )

  return (
    <div className="flex w-72 min-w-60 flex-col border-r-4 border-black bg-secondary/40">
      <div
        className="flex h-16 items-center justify-between border-b-4 border-black px-4"
        style={{ backgroundColor: 'var(--chat-bg)' }}
      >
        <div className="flex flex-col">
          <p className="text-sm font-semibold leading-tight">{budLabel}</p>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Threads</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="rounded-md border-2 border-black px-3 py-1 font-mono text-[11px] font-semibold uppercase transition-transform hover:-translate-y-0.5"
            onClick={() => onSelectThread(null)}
            style={{
              backgroundColor: 'var(--bud-accent-muted)',
              boxShadow: '2px 2px 0px rgba(0,0,0,1)'
            }}
          >
            New
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-lg border-3 border-black text-foreground transition-all hover:-translate-y-0.5"
            style={{ boxShadow: '3px 3px 0px rgba(0,0,0,1)' }}
          >
            <Settings className="h-5 w-5" />
          </Button>
        </div>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {orderedThreads.length === 0 && (
          <p className="text-sm italic text-muted-foreground">No threads yet. Create one to start chatting.</p>
        )}
        {orderedThreads.map((thread) => {
          const isActive = thread.thread_id === activeThreadId
          const activityTs = thread.last_activity_at ?? thread.created_at
          return (
            <button
              key={thread.thread_id}
              onClick={() => onSelectThread(thread.thread_id)}
              className={cn(
                'w-full rounded-xl border-3 border-black px-3 py-2 text-left transition-all',
                isActive
                  ? 'shadow-none'
                  : 'shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:translate-y-0.5'
              )}
              style={{
                backgroundColor: isActive ? mutedColor : 'var(--card)',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="line-clamp-1 text-sm font-semibold">{thread.title ?? 'Untitled thread'}</p>
                {thread.message_count != null && (
                  <span className="rounded-full border border-black px-2 py-px text-[10px] font-mono">
                    {thread.message_count}
                  </span>
                )}
              </div>
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {thread.last_message_preview ?? '—'}
              </p>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {relativeTime(activityTs)}
              </p>
            </button>
          )
        })}
      </div>
    </div>
  )
}
