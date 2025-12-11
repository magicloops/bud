import { useState, useEffect, useCallback } from 'react'
import { X, Terminal, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api'

type SessionInfo = {
  session_id: string
  state: string
  thread_id: string | null
  thread_title: string | null
  thread_deleted: boolean
  created_at: string | null
  started_at: string | null
  last_activity_at: string | null
  output_bytes: number
  total_output_bytes: number
}

type BudSessionsModalProps = {
  budId: string
  budName: string
  isOpen: boolean
  onClose: () => void
  onNavigateToThread?: (threadId: string) => void
}

function getSessionStateColor(state: string): string {
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

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never'
  const date = new Date(iso)
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return date.toLocaleDateString()
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function truncateSessionId(sessionId: string): string {
  if (sessionId.length <= 16) return sessionId
  return `${sessionId.slice(0, 12)}...${sessionId.slice(-4)}`
}

export function BudSessionsModal({
  budId,
  budName,
  isOpen,
  onClose,
  onNavigateToThread
}: BudSessionsModalProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [budOnline, setBudOnline] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<SessionInfo | null>(null)

  const fetchSessions = useCallback(async () => {
    if (!budId) return
    try {
      setLoading(true)
      setError(null)
      const resp = await apiFetch(`/api/buds/${budId}/sessions`)
      if (!resp.ok) {
        const data = await resp.json()
        throw new Error(data.error || 'Failed to fetch sessions')
      }
      const data = await resp.json()
      setSessions(data.sessions)
      setBudOnline(data.bud_online)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [budId])

  useEffect(() => {
    if (isOpen) {
      fetchSessions()
    }
  }, [isOpen, fetchSessions])

  const handleDeleteSession = async (session: SessionInfo) => {
    setDeletingSessionId(session.session_id)
    try {
      const resp = await apiFetch(`/api/buds/${budId}/sessions/${session.session_id}`, {
        method: 'DELETE'
      })
      if (!resp.ok) {
        const data = await resp.json()
        throw new Error(data.error || 'Failed to close session')
      }
      // Remove from list
      setSessions(prev => prev.filter(s => s.session_id !== session.session_id))
      setConfirmDelete(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setDeletingSessionId(null)
    }
  }

  const handleThreadClick = (threadId: string | null) => {
    if (!threadId) return
    onNavigateToThread?.(threadId)
    onClose()
  }

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/40"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
        <div
          className="pointer-events-auto w-full max-w-lg max-h-[80vh] flex flex-col rounded-xl border-4 border-black bg-background shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between border-b-4 border-black px-4 py-3 shrink-0"
            style={{ backgroundColor: 'var(--chat-bg)' }}
          >
            <div>
              <h2 className="font-mono text-sm font-bold uppercase tracking-wide">
                Terminal Sessions
              </h2>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                {budName}
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    budOnline ? 'bg-green-500' : 'bg-orange-500'
                  )}
                />
                <span>{budOnline ? 'Online' : 'Offline'}</span>
              </p>
            </div>
            <button
              onClick={onClose}
              className="rounded-md border-2 border-black p-1.5 transition-transform hover:-translate-y-0.5"
              style={{ boxShadow: '2px 2px 0px rgba(0,0,0,1)' }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <p className="font-mono text-sm text-muted-foreground">Loading...</p>
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <p className="font-mono text-sm text-destructive">{error}</p>
                <button
                  onClick={fetchSessions}
                  className="mt-4 rounded-md border-2 border-black px-3 py-1.5 font-mono text-[11px] font-bold uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-0.5"
                >
                  Retry
                </button>
              </div>
            ) : sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Terminal className="h-12 w-12 text-muted-foreground/50" />
                <p className="mt-4 font-mono text-sm font-semibold uppercase">
                  No active sessions
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Sessions are created when you visit a thread.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="font-mono text-xs text-muted-foreground">
                  {sessions.length} active session{sessions.length !== 1 ? 's' : ''}
                </p>

                {sessions.map(session => (
                  <div
                    key={session.session_id}
                    className="rounded-xl border-3 border-black bg-card px-3 py-2 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]"
                  >
                    {/* State and ID */}
                    <div className="flex items-center gap-2">
                      <span
                        className={cn('h-2 w-2 rounded-full', getSessionStateColor(session.state))}
                      />
                      <span className="font-mono text-[10px] font-bold uppercase">
                        {session.state}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {truncateSessionId(session.session_id)}
                      </span>
                    </div>

                    {/* Thread title */}
                    <div className="mt-1 flex items-center gap-1">
                      {session.thread_id && !session.thread_deleted ? (
                        <button
                          onClick={() => handleThreadClick(session.thread_id)}
                          className="flex items-center gap-1 text-sm font-semibold text-accent hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" />
                          <span className="line-clamp-1">
                            {session.thread_title ?? 'Untitled thread'}
                          </span>
                        </button>
                      ) : session.thread_deleted ? (
                        <span className="flex items-center gap-1 text-sm text-muted-foreground">
                          <span className="text-yellow-500">!</span>
                          <span className="italic">(deleted thread)</span>
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground italic">No thread</span>
                      )}
                    </div>

                    {/* Timestamps and actions */}
                    <div className="mt-1 flex items-center justify-between">
                      <span className="font-mono text-[11px] text-muted-foreground uppercase">
                        {relativeTime(session.created_at)} • Active{' '}
                        {relativeTime(session.last_activity_at)} •{' '}
                        {formatBytes(session.output_bytes)}
                      </span>
                      <button
                        onClick={() => setConfirmDelete(session)}
                        disabled={!budOnline || deletingSessionId === session.session_id}
                        className={cn(
                          'rounded-md border-2 border-black bg-destructive px-2 py-1 font-mono text-[10px] font-bold uppercase text-destructive-foreground shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-0.5',
                          'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0'
                        )}
                        title={!budOnline ? 'Cannot close while Bud offline' : 'Close session'}
                      >
                        {deletingSessionId === session.session_id ? '...' : 'Close'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-black/20 px-4 py-2 shrink-0">
            <p className="text-xs text-muted-foreground">
              Sessions auto-cleanup after 24h idle.
            </p>
          </div>
        </div>
      </div>

      {/* Confirmation Dialog */}
      {confirmDelete && (
        <>
          <div
            className="fixed inset-0 z-[60] bg-black/50"
            onClick={() => setConfirmDelete(null)}
          />
          <div className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none">
            <div
              className="pointer-events-auto w-full max-w-sm rounded-xl border-4 border-black bg-background p-4 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="font-mono text-sm font-bold uppercase">Close Session?</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                This will close the tmux session on the Bud.
              </p>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                <li>
                  • Thread "{confirmDelete.thread_title ?? 'Untitled'}" remains intact
                </li>
                <li>• Session output preserved in history</li>
                <li>• New session created when you return</li>
              </ul>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="rounded-md border-2 border-black px-3 py-1.5 font-mono text-[11px] font-bold uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-0.5"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDeleteSession(confirmDelete)}
                  disabled={deletingSessionId !== null}
                  className="rounded-md border-2 border-black bg-destructive px-3 py-1.5 font-mono text-[11px] font-bold uppercase text-destructive-foreground shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-0.5 disabled:opacity-50"
                >
                  {deletingSessionId ? 'Closing...' : 'Close Session'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
