import { useMemo, useState, type MouseEvent } from 'react'
import { Trash2, Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getMutedColor, resolveCssVar } from '@/lib/theme-colors'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/transport'

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
  // Session info (from JOIN)
  has_terminal_session?: boolean
  session_state?: string | null
  session_id?: string | null
}

type ThreadPanelProps = {
  threads: ThreadSummary[]
  activeThreadId: string | null
  onSelectThread: (threadId: string | null) => void
  onThreadDeleted?: (threadId: string) => void
  onOpenSessions?: () => void
  accentColor: string
  budLabel: string
  budId?: string
  onError?: (message: string | null) => void
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

function getSessionStateColor(state: string | null | undefined): string {
  switch (state) {
    case 'active':
      return 'bg-green-500'
    case 'ready':
    case 'idle':
      return 'bg-blue-400'
    case 'creating':
    case 'pending':
      return 'bg-yellow-500 animate-pulse'
    case 'closed':
      return 'bg-gray-400'
    default:
      return 'bg-gray-300'
  }
}

function getSessionStateLabel(state: string | null | undefined): string {
  switch (state) {
    case 'active':
      return 'Running'
    case 'ready':
    case 'idle':
      return 'Ready'
    case 'creating':
    case 'pending':
      return 'Starting'
    case 'closed':
      return 'Closed'
    default:
      return ''
  }
}

export function ThreadPanel({
  threads,
  activeThreadId,
  onSelectThread,
  onThreadDeleted,
  onOpenSessions,
  accentColor,
  budLabel,
  budId,
  onError,
}: ThreadPanelProps) {
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ThreadSummary | null>(null)

  const accentBorder = useMemo(() => {
    const resolved = resolveCssVar(accentColor ?? 'var(--accent)')
    return getMutedColor(resolved, 0.35)
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

  const handleDeleteClick = (e: MouseEvent, thread: ThreadSummary) => {
    e.stopPropagation()
    if (!budId || deletingThreadId) return
    setConfirmDelete(thread)
  }

  const handleConfirmDelete = async () => {
    if (!confirmDelete || deletingThreadId) return
    const threadId = confirmDelete.thread_id

    setDeletingThreadId(threadId)
    try {
      const resp = await apiFetch(`/api/threads/${threadId}`, { method: 'DELETE' })
      if (resp.ok) {
        setConfirmDelete(null)
        onError?.(null)
        onThreadDeleted?.(threadId)
      } else {
        const text = await resp.text().catch(() => '')
        onError?.(text || 'Failed to delete thread')
      }
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Failed to delete thread')
    } finally {
      setDeletingThreadId(null)
    }
  }

  return (
    <div className="flex w-72 min-w-60 flex-col border-r-4 border-black bg-secondary/40">
      <div
        className="flex h-16 items-center justify-between border-b-4 border-black px-4"
        style={{ backgroundColor: 'var(--chat-bg)' }}
      >
        <div className="flex flex-col">
          <p className="line-clamp-1 font-mono text-[15px] font-semibold uppercase tracking-wide">
            {budLabel}
          </p>
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
            onClick={onOpenSessions}
            className="h-10 w-10 rounded-lg border-3 border-black text-foreground transition-all hover:-translate-y-0.5"
            style={{ boxShadow: '3px 3px 0px rgba(0,0,0,1)' }}
            title="Terminal Sessions"
          >
            <Terminal className="h-5 w-5" />
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
          const hasSession = thread.has_terminal_session
          const sessionState = thread.session_state
          const stateLabel = getSessionStateLabel(sessionState)
          const isDeleting = deletingThreadId === thread.thread_id

          return (
            <div
              key={thread.thread_id}
              className={cn(
                'group relative w-full rounded-xl border-3 border-black px-3 py-2 text-left transition-all shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 cursor-pointer',
                isActive && 'border-[color:var(--bud-accent-vibrant)]'
              )}
              style={{
                backgroundColor: 'var(--card)',
                borderColor: isActive ? accentBorder : 'var(--border)',
                boxShadow: isActive ? `3px 3px 0 ${accentBorder}` : undefined
              }}
              onClick={() => onSelectThread(thread.thread_id)}
            >
              {/* Delete button - shown on hover */}
              <button
                type="button"
                onClick={(e) => handleDeleteClick(e, thread)}
                disabled={isDeleting}
                className={cn(
                  'absolute -right-2 -top-2 z-10 h-6 w-6 rounded-full border-2 border-black bg-destructive text-destructive-foreground opacity-0 transition-opacity hover:bg-destructive/80 group-hover:opacity-100',
                  isDeleting && 'opacity-50 cursor-not-allowed'
                )}
                title="Delete thread"
              >
                <Trash2 className="h-3 w-3 mx-auto" />
              </button>

              <div className="flex items-center justify-between gap-2">
                <p className="line-clamp-1 text-sm font-semibold">{thread.title ?? 'Untitled thread'}</p>
                <div className="flex items-center gap-1.5">
                  {hasSession && (
                    <span
                      className="flex items-center gap-1 rounded-full border border-black/20 bg-muted/50 px-1.5 py-px text-[9px] font-mono"
                      title={stateLabel ? `Session: ${stateLabel}` : 'Has terminal session'}
                    >
                      <Terminal className="h-2.5 w-2.5" />
                      <span className={cn('h-1.5 w-1.5 rounded-full', getSessionStateColor(sessionState))} />
                    </span>
                  )}
                  {thread.message_count != null && (
                    <span className="rounded-full border border-black px-2 py-px text-[10px] font-mono">
                      {thread.message_count}
                    </span>
                  )}
                </div>
              </div>
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {thread.last_message_preview ?? '—'}
              </p>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {relativeTime(activityTs)}
              </p>
            </div>
          )
        })}
      </div>

      {/* Delete Confirmation Dialog */}
      {confirmDelete && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/40"
            onClick={() => setConfirmDelete(null)}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div
              className="pointer-events-auto w-full max-w-sm rounded-xl border-4 border-black bg-background p-4 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="font-mono text-sm font-bold uppercase">Delete Thread?</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                This will permanently delete the thread and all messages.
              </p>
              <p className="mt-2 text-sm font-medium line-clamp-2">
                "{confirmDelete.title ?? 'Untitled thread'}"
              </p>
              {confirmDelete.has_terminal_session && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Note: The associated terminal session will also be closed.
                </p>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="rounded-md border-2 border-black px-3 py-1.5 font-mono text-[11px] font-bold uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-0.5"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmDelete}
                  disabled={deletingThreadId !== null}
                  className="rounded-md border-2 border-black bg-destructive px-3 py-1.5 font-mono text-[11px] font-bold uppercase text-destructive-foreground shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-0.5 disabled:opacity-50"
                >
                  {deletingThreadId ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
