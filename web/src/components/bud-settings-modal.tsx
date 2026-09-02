import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { X, Terminal, ExternalLink, Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MutationStatus } from '@/components/ui/mutation-status'
import { apiFetch, apiFetchJson, readResponseErrorMessage } from '@/lib/transport'
import { BUD_ACCENT_PRESETS, DEFAULT_AVATAR_COLORS, accentColorForHue, getOklchHue } from '@/lib/theme-colors'
import type { ApiBud } from '@/lib/api-types'

export type BudSettingsTab = 'general' | 'sessions' | 'device'

type BudSettingsModalProps = {
  bud: ApiBud
  isOpen: boolean
  /** Tab shown when the modal opens (Layers → 'sessions', gear → 'general'). */
  initialTab: BudSettingsTab
  onClose: () => void
  onNavigateToThread?: (threadId: string) => void
  /** Fired with the server's updated row after a successful save. */
  onBudUpdated?: (bud: ApiBud) => void
}

type StatusState = { tone: 'success' | 'error'; message: string } | null

const TABS: Array<{ id: BudSettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'device', label: 'Device' },
]

// Hue slider track: oklch stops every 30° at the picker's fixed L/C, so the
// track shows exactly the colors the thumb can land on.
const HUE_TRACK = `linear-gradient(to right, ${Array.from({ length: 13 }, (_, i) => accentColorForHue(i * 30)).join(', ')})`

const ACTION_BUTTON =
  'rounded-md border-2 border-black px-3 py-1.5 font-mono text-[11px] font-bold uppercase shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0'

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'Never'
  const date = new Date(iso)
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return date.toLocaleDateString()
}

export function BudSettingsModal({
  bud,
  isOpen,
  initialTab,
  onClose,
  onNavigateToThread,
  onBudUpdated,
}: BudSettingsModalProps) {
  const [tab, setTab] = useState<BudSettingsTab>(initialTab)

  // Land on the requested tab each time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setTab(initialTab)
    }
  }, [isOpen, initialTab])

  // Escape closes (the backdrop click already does).
  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const budLabel = bud.display_name ?? bud.name
  const budOnline = bud.status === 'online'

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="bud-settings-title"
          className="pointer-events-auto flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border-4 border-black bg-background shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between border-b-4 border-black px-4 py-3">
            <div>
              <h2 id="bud-settings-title" className="font-mono text-sm font-bold uppercase tracking-wide">
                Bud settings
              </h2>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                {budLabel}
                <span className={cn('h-2 w-2 rounded-full', budOnline ? 'bg-green-500' : 'bg-orange-500')} />
                <span>{budOnline ? 'Online' : 'Offline'}</span>
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md border-2 border-black p-1.5 transition-transform hover:-translate-y-0.5"
              style={{ boxShadow: '2px 2px 0px rgba(0,0,0,1)' }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Tabs */}
          <div role="tablist" className="flex shrink-0 border-b-2 border-black">
            {TABS.map((entry) => {
              const active = entry.id === tab
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(entry.id)}
                  className={cn(
                    'flex-1 border-r-2 border-black px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-wide transition-colors last:border-r-0',
                    active
                      ? 'bg-[var(--bud-accent-muted)] text-black dark:text-white'
                      : 'text-muted-foreground hover:bg-[var(--bud-accent-soft)] hover:text-foreground',
                  )}
                >
                  {entry.label}
                </button>
              )
            })}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
            {tab === 'general' && (
              <GeneralTab key={bud.bud_id} bud={bud} onBudUpdated={onBudUpdated} />
            )}
            {tab === 'sessions' && (
              <SessionsTab budId={bud.bud_id} onNavigateToThread={onNavigateToThread} onClose={onClose} />
            )}
            {tab === 'device' && <DeviceTab bud={bud} />}
          </div>

          {/* Footer */}
          <div className="shrink-0 border-t border-black/20 px-4 py-2">
            <p className="text-xs text-muted-foreground">
              {tab === 'general'
                ? 'Name and color only change how this Bud appears to you.'
                : tab === 'sessions'
                  ? 'Sessions are marked idle after 30 minutes and kept until you close them.'
                  : 'Reported by the daemon on its last connection.'}
            </p>
          </div>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// General: display name + accent color
// ---------------------------------------------------------------------------

function GeneralTab({ bud, onBudUpdated }: { bud: ApiBud; onBudUpdated?: (bud: ApiBud) => void }) {
  const currentDisplayName = bud.display_name ?? ''
  // The route resolves fallback accents before handing the row over.
  const currentAccent = bud.accent_color ?? DEFAULT_AVATAR_COLORS[0]!

  const [displayName, setDisplayName] = useState(currentDisplayName)
  const [accent, setAccent] = useState(currentAccent)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<StatusState>(null)

  // Re-sync the form when the server row changes (e.g. after our own save
  // round-trips through the loader).
  useEffect(() => {
    setDisplayName(currentDisplayName)
    setAccent(currentAccent)
  }, [currentDisplayName, currentAccent])

  const isPreset = BUD_ACCENT_PRESETS.includes(accent)
  const hue = getOklchHue(accent) ?? 0

  const trimmedName = displayName.trim()
  const nameDirty = trimmedName !== currentDisplayName
  const accentDirty = accent !== currentAccent
  const dirty = nameDirty || accentDirty

  const handleSave = async () => {
    if (!dirty || saving) return
    setSaving(true)
    setStatus(null)
    try {
      const body: { display_name?: string | null; accent_color?: string } = {}
      if (nameDirty) body.display_name = trimmedName ? trimmedName : null
      if (accentDirty) body.accent_color = accent
      const updated = await apiFetchJson<ApiBud>(`/api/buds/${bud.bud_id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      onBudUpdated?.(updated)
      setStatus({ tone: 'success', message: 'Saved.' })
    } catch (err) {
      setStatus({ tone: 'error', message: err instanceof Error ? err.message : 'Failed to save' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      {status ? <MutationStatus tone={status.tone} message={status.message} onDismiss={() => setStatus(null)} /> : null}

      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="bud-display-name" className="font-mono text-[11px] font-bold uppercase tracking-wide">
            Display name
          </label>
          {(currentDisplayName || trimmedName) && (
            <button
              type="button"
              onClick={() => setDisplayName('')}
              className="font-mono text-[11px] uppercase text-muted-foreground hover:text-foreground"
              title={`Use the daemon's name (${bud.name})`}
            >
              Reset
            </button>
          )}
        </div>
        <input
          id="bud-display-name"
          type="text"
          value={displayName}
          maxLength={120}
          placeholder={bud.name}
          onChange={(e) => setDisplayName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void handleSave()
            }
          }}
          className="mt-1.5 w-full rounded-lg border-2 border-black bg-card px-3 py-2 text-sm shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] focus:outline-none focus:ring-2 focus:ring-[var(--bud-accent-muted)]"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Daemon name: <span className="font-mono">{bud.name}</span>
          {!trimmedName && ' (shown when no display name is set)'}
        </p>
      </div>

      <div>
        <p className="font-mono text-[11px] font-bold uppercase tracking-wide">Accent</p>
        <div className="mt-2 flex flex-wrap items-center gap-3" role="radiogroup" aria-label="Accent color">
          {BUD_ACCENT_PRESETS.map((color) => {
            const selected = color === accent
            return (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={color}
                onClick={() => setAccent(color)}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-lg border-2 border-black transition-transform hover:-translate-y-0.5',
                  selected ? 'ring-2 ring-black ring-offset-2 ring-offset-background' : '',
                )}
                style={{ backgroundColor: color, boxShadow: '2px 2px 0px 0px rgba(0,0,0,1)' }}
              >
                {selected && <Check className="h-4 w-4 text-black" />}
              </button>
            )
          })}
          {/* Custom: the current color when it isn't a preset */}
          <span
            aria-hidden
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg border-2 border-black',
              isPreset ? 'border-dashed opacity-40' : 'ring-2 ring-black ring-offset-2 ring-offset-background',
            )}
            style={{ backgroundColor: accent, boxShadow: '2px 2px 0px 0px rgba(0,0,0,1)' }}
            title="Custom"
          >
            {!isPreset && <Check className="h-4 w-4 text-black" />}
          </span>
        </div>
        <label className="mt-3 block">
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Custom hue</span>
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={hue}
            onChange={(e) => setAccent(accentColorForHue(Number(e.target.value)))}
            aria-label="Custom accent hue"
            className="mt-1 block h-4 w-full cursor-pointer appearance-none rounded-full border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 focus-visible:ring-offset-background [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-black [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-black [&::-webkit-slider-thumb]:bg-white"
            style={{ background: HUE_TRACK }}
          />
        </label>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
          className={cn(ACTION_BUTTON, 'bg-[var(--bud-accent-muted)] text-black dark:text-white')}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Device: read-only facts
// ---------------------------------------------------------------------------

function DeviceTab({ bud }: { bud: ApiBud }) {
  const [copied, setCopied] = useState(false)

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(bud.bud_id)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable (insecure context) — the id is still selectable.
    }
  }

  const rows: Array<{ label: string; value: ReactNode }> = [
    { label: 'Daemon name', value: <span className="font-mono">{bud.name}</span> },
    {
      label: 'Bud ID',
      value: (
        <span className="flex items-center gap-2">
          <span className="select-all font-mono text-xs">{bud.bud_id}</span>
          <button
            type="button"
            onClick={() => void copyId()}
            aria-label="Copy Bud ID"
            className="rounded border border-black/40 p-0.5 text-muted-foreground hover:text-foreground"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        </span>
      ),
    },
    { label: 'Platform', value: <span className="font-mono">{[bud.os, bud.arch].filter(Boolean).join(' / ') || '—'}</span> },
    { label: 'Daemon version', value: <span className="font-mono">{bud.version ?? '—'}</span> },
    { label: 'Status', value: bud.status },
    { label: 'Last seen', value: relativeTime(bud.last_seen_at) },
  ]

  return (
    <dl className="divide-y divide-black/10">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-4 py-2">
          <dt className="font-mono text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 text-right text-sm">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

// ---------------------------------------------------------------------------
// Sessions: the former Terminal Sessions modal body, unchanged in behavior
// ---------------------------------------------------------------------------

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

function SessionsTab({
  budId,
  onNavigateToThread,
  onClose,
}: {
  budId: string
  onNavigateToThread?: (threadId: string) => void
  onClose: () => void
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [budOnline, setBudOnline] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusState>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<SessionInfo | null>(null)

  const fetchSessions = useCallback(async () => {
    if (!budId) return
    try {
      setLoading(true)
      setLoadError(null)
      const resp = await apiFetch(`/api/buds/${budId}/sessions`)
      if (!resp.ok) {
        throw new Error(await readResponseErrorMessage(resp, 'Failed to fetch sessions'))
      }
      const data = (await resp.json()) as { sessions: SessionInfo[]; bud_online: boolean }
      setSessions(data.sessions)
      setBudOnline(data.bud_online)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [budId])

  useEffect(() => {
    setStatus(null)
    setConfirmDelete(null)
    void fetchSessions()
  }, [fetchSessions])

  const handleDeleteSession = async (session: SessionInfo) => {
    setDeletingSessionId(session.session_id)
    setStatus(null)
    try {
      const resp = await apiFetch(`/api/buds/${budId}/sessions/${session.session_id}`, {
        method: 'DELETE',
      })
      if (!resp.ok) {
        throw new Error(await readResponseErrorMessage(resp, 'Failed to close session'))
      }
      setSessions((prev) => prev.filter((s) => s.session_id !== session.session_id))
      setConfirmDelete(null)
      setStatus({ tone: 'success', message: 'Session closed.' })
    } catch (err) {
      setStatus({ tone: 'error', message: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setDeletingSessionId(null)
    }
  }

  const handleThreadClick = (threadId: string | null) => {
    if (!threadId) return
    onNavigateToThread?.(threadId)
    onClose()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="font-mono text-sm text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <MutationStatus
          tone="error"
          title="Sessions unavailable"
          message={loadError}
          action={
            <button
              type="button"
              onClick={() => void fetchSessions()}
              className="rounded-md border-2 border-black bg-background px-3 py-1.5 font-mono text-[11px] font-bold uppercase text-foreground shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-0.5"
            >
              Retry
            </button>
          }
        />
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3">
        {status ? <MutationStatus tone={status.tone} message={status.message} onDismiss={() => setStatus(null)} /> : null}

        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Terminal className="h-12 w-12 text-muted-foreground/50" />
            <p className="mt-4 font-mono text-sm font-semibold uppercase">No active sessions</p>
            <p className="mt-1 text-sm text-muted-foreground">Sessions are created when you visit a thread.</p>
          </div>
        ) : (
          <>
            <p className="font-mono text-xs text-muted-foreground">
              {sessions.length} active session{sessions.length !== 1 ? 's' : ''}
            </p>

            {sessions.map((session) => (
              <div
                key={session.session_id}
                className="rounded-xl border-3 border-black bg-card px-3 py-2 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]"
              >
                {/* State and ID */}
                <div className="flex items-center gap-2">
                  <span className={cn('h-2 w-2 rounded-full', getSessionStateColor(session.state))} />
                  <span className="font-mono text-[10px] font-bold uppercase">{session.state}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {truncateSessionId(session.session_id)}
                  </span>
                </div>

                {/* Thread title */}
                <div className="mt-1 flex items-center gap-1">
                  {session.thread_id && !session.thread_deleted ? (
                    <button
                      type="button"
                      onClick={() => handleThreadClick(session.thread_id)}
                      className="flex items-center gap-1 text-sm font-semibold text-accent hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      <span className="line-clamp-1">{session.thread_title ?? 'Untitled thread'}</span>
                    </button>
                  ) : session.thread_deleted ? (
                    <span className="flex items-center gap-1 text-sm text-muted-foreground">
                      <span className="text-yellow-500">!</span>
                      <span className="italic">(deleted thread)</span>
                    </span>
                  ) : (
                    <span className="text-sm italic text-muted-foreground">No thread</span>
                  )}
                </div>

                {/* Timestamps and actions */}
                <div className="mt-1 flex items-center justify-between">
                  <span className="font-mono text-[11px] uppercase text-muted-foreground">
                    {relativeTime(session.created_at)} • Active {relativeTime(session.last_activity_at)} •{' '}
                    {formatBytes(session.output_bytes)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(session)}
                    disabled={!budOnline || deletingSessionId === session.session_id}
                    className={cn(
                      'rounded-md border-2 border-black bg-destructive px-2 py-1 font-mono text-[10px] font-bold uppercase text-destructive-foreground shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-0.5',
                      'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0',
                    )}
                    title={!budOnline ? 'Cannot close while Bud offline' : 'Close session'}
                  >
                    {deletingSessionId === session.session_id ? '...' : 'Close'}
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Confirmation Dialog */}
      {confirmDelete && (
        <>
          <div className="fixed inset-0 z-[60] bg-black/50" onClick={() => setConfirmDelete(null)} />
          <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center">
            <div
              className="pointer-events-auto w-full max-w-sm rounded-xl border-4 border-black bg-background p-4 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="font-mono text-sm font-bold uppercase">Close Session?</h3>
              <p className="mt-2 text-sm text-muted-foreground">This will close the terminal session on the Bud.</p>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                <li>• Thread "{confirmDelete.thread_title ?? 'Untitled'}" remains intact</li>
                <li>• Session output preserved in history</li>
                <li>• New session created when you return</li>
              </ul>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirmDelete(null)} className={ACTION_BUTTON}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeleteSession(confirmDelete)}
                  disabled={deletingSessionId !== null}
                  className={cn(ACTION_BUTTON, 'bg-destructive text-destructive-foreground')}
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
