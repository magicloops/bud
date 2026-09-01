import { createFileRoute, Outlet, useNavigate, useMatches, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { MutationStatus, type MutationStatusTone } from '@/components/ui/mutation-status'
import { BudRail, type BudProfile, type BudCapabilities } from '@/components/workbench/bud-rail'
import { ThreadPanel, type ThreadSummary } from '@/components/workbench/thread-panel'
import { BudSettingsModal, type BudSettingsTab } from '@/components/bud-settings-modal'
import { deriveBudPalette, withFallbackAccentColors } from '@/lib/theme-colors'
import { BudRouteContext, type BudRouteContextValue } from '@/contexts/bud-route-context'
import {
  apiFetchJson,
  isApiError,
} from '@/lib/transport'
import { normalizeCapabilities, type ApiBud, type ApiThread } from '@/lib/api-types'
import { toLoginRedirect } from '@/lib/route-auth'
import { useLayout } from '@/contexts/layout-context'
import { useAppHeightVar, useIsCompact, useIsMobile } from '@/lib/use-viewport'

const toThreadSummary = (thread: ApiThread): ThreadSummary => ({
  thread_id: thread.thread_id,
  bud_id: thread.bud_id,
  title: thread.title,
  created_at: thread.created_at,
  last_activity_at: thread.last_activity_at,
  last_message_preview: thread.last_message_preview,
  message_count: thread.message_count,
  pinned: thread.pinned,
  archived: thread.archived,
  has_terminal_session: thread.has_terminal_session,
  session_state: thread.session_state,
  session_id: thread.session_id,
  model: thread.model,
  reasoning_effort: thread.reasoning_effort,
  effective_model: thread.effective_model,
  effective_reasoning_effort: thread.effective_reasoning_effort,
  model_selection_source: thread.model_selection_source,
})

const mergeOptional = <T,>(incoming: T | undefined, existing: T | undefined) =>
  incoming === undefined ? existing : incoming

const mergeThreadSummary = (
  existing: ThreadSummary | undefined,
  incoming: ApiThread | ThreadSummary,
): ThreadSummary => {
  const next = toThreadSummary(incoming)
  if (!existing) {
    return next
  }

  return {
    ...existing,
    ...next,
    has_terminal_session: mergeOptional(next.has_terminal_session, existing.has_terminal_session),
    session_state: mergeOptional(next.session_state, existing.session_state),
    session_id: mergeOptional(next.session_id, existing.session_id),
    model: mergeOptional(next.model, existing.model),
    reasoning_effort: mergeOptional(next.reasoning_effort, existing.reasoning_effort),
    effective_model: mergeOptional(next.effective_model, existing.effective_model),
    effective_reasoning_effort: mergeOptional(
      next.effective_reasoning_effort,
      existing.effective_reasoning_effort,
    ),
    model_selection_source: mergeOptional(next.model_selection_source, existing.model_selection_source),
  }
}

export const Route = createFileRoute('/$budId')({
  loader: async ({ params, location }) => {
    try {
      const [buds, threads] = await Promise.all([
        apiFetchJson<ApiBud[]>('/api/buds', { redirectOnUnauthorized: false }),
        apiFetchJson<ApiThread[]>(`/api/threads?bud_id=${params.budId}`, { redirectOnUnauthorized: false }),
      ])

      const bud = buds.find(b => b.bud_id === params.budId)
      if (!bud) {
        throw new Error('Bud not found')
      }

      return { buds, bud, threads }
    } catch (error) {
      if (isApiError(error, 401)) {
        throw toLoginRedirect(location.href)
      }
      throw error
    }
  },
  component: BudLayout,
})

function BudLayout() {
  const { buds: rawBuds, threads: initialThreads } = Route.useLoaderData()
  const { budId } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()

  // Thread panel visibility - from global context (shared across all buds/threads)
  const { threadPanelOpen, setThreadPanelOpen } = useLayout()
  const isMobile = useIsMobile()
  const isCompact = useIsCompact()
  useAppHeightVar()
  // Crossing into the compact range must not leave the persisted-open
  // panel covering the whole screen as a drawer.
  useEffect(() => {
    if (isCompact) {
      setThreadPanelOpen(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompact])

  // Bud settings modal (general / sessions / device tabs)
  const [budSettings, setBudSettings] = useState<{ open: boolean; tab: BudSettingsTab }>({
    open: false,
    tab: 'general',
  })
  // Rows saved from the settings modal, applied instantly over loader data
  // until the invalidated loader catches up (cleared on every reload).
  const [budOverrides, setBudOverrides] = useState<Record<string, ApiBud>>({})
  useEffect(() => {
    setBudOverrides({})
  }, [rawBuds])
  // Every row downstream carries an accent: the service resolves legacy NULL
  // colors positionally by creation order, and withFallbackAccentColors does
  // the same here for older services (never by this list's last_seen_at order).
  const apiBuds = useMemo(
    () => withFallbackAccentColors(rawBuds.map((apiBud) => budOverrides[apiBud.bud_id] ?? apiBud)),
    [rawBuds, budOverrides],
  )
  const [threadPanelStatus, setThreadPanelStatus] = useState<{ tone: MutationStatusTone; message: string } | null>(null)
  const [threads, setThreads] = useState<ThreadSummary[]>(() => initialThreads.map(toThreadSummary))

  // Get threadId from child route match (if we're on /$budId/$threadId)
  const matches = useMatches()
  const activeThreadId = useMemo(() => {
    const threadMatch = matches.find(m => m.routeId === '/$budId/$threadId')
    return (threadMatch?.params as { threadId?: string })?.threadId ?? null
  }, [matches])

  // Convert API buds to BudProfile format
  const buds: BudProfile[] = useMemo(() => {
    return apiBuds.map((apiBud) => {
      return {
        id: apiBud.bud_id,
        label: apiBud.display_name ?? apiBud.name,
        accentColor: apiBud.accent_color ?? 'var(--accent)',
        status: apiBud.status,
        tags: apiBud.tags,
        capabilities: normalizeCapabilities(apiBud.capabilities) as BudCapabilities | null,
      }
    })
  }, [apiBuds])

  useEffect(() => {
    setThreads(initialThreads.map(toThreadSummary))
  }, [initialThreads])

  const activeBudProfile = useMemo(() => {
    return buds.find((b) => b.id === budId)
  }, [budId, buds])
  const activeApiBud = useMemo(() => apiBuds.find((b) => b.bud_id === budId), [apiBuds, budId])

  // Compute palette for theming
  const palette = useMemo(() => {
    return deriveBudPalette(activeBudProfile?.accentColor ?? 'var(--accent)')
  }, [activeBudProfile])

  // Apply CSS custom properties for theming
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--bud-accent-vibrant', palette.vibrant)
    root.style.setProperty('--bud-accent-muted', palette.muted)
    root.style.setProperty('--bud-accent-soft', palette.soft)
  }, [palette])

  const handleSelectBud = useCallback((id: string) => {
    navigate({ to: '/$budId', params: { budId: id } })
  }, [navigate])

  const handleOpenSettings = useCallback(() => {
    navigate({ to: '/settings' })
  }, [navigate])

  const handleSelectThread = useCallback((threadId: string | null) => {
    setThreadPanelStatus(null)
    if (threadId) {
      navigate({ to: '/$budId/$threadId', params: { budId, threadId } })
    } else {
      navigate({ to: '/$budId/new', params: { budId } })
    }
  }, [navigate, budId])

  const removeThreadSummary = useCallback((threadId: string) => {
    setThreads((prev) => prev.filter((thread) => thread.thread_id !== threadId))
  }, [])

  const upsertThreadSummary = useCallback((thread: ApiThread | ThreadSummary) => {
    setThreads((prev) => {
      const index = prev.findIndex((entry) => entry.thread_id === thread.thread_id)
      if (index === -1) {
        return [mergeThreadSummary(undefined, thread), ...prev]
      }

      const next = [...prev]
      next[index] = mergeThreadSummary(next[index], thread)
      return next
    })
  }, [])

  const patchThreadSummary = useCallback((threadId: string, patch: Partial<ThreadSummary>) => {
    setThreads((prev) =>
      prev.map((thread) => (thread.thread_id === threadId ? { ...thread, ...patch } : thread)),
    )
  }, [])

  const handleThreadDeleted = useCallback((deletedThreadId: string) => {
    removeThreadSummary(deletedThreadId)
    navigate({ to: '/$budId', params: { budId } })
  }, [budId, navigate, removeThreadSummary])

  const handleOpenBudSettings = useCallback((tab: BudSettingsTab) => {
    setBudSettings({ open: true, tab })
  }, [])

  const handleCloseBudSettings = useCallback(() => {
    setBudSettings((prev) => ({ ...prev, open: false }))
  }, [])

  const handleBudUpdated = useCallback((bud: ApiBud) => {
    setBudOverrides((prev) => ({ ...prev, [bud.bud_id]: bud }))
    void router.invalidate()
  }, [router])

  const handleNavigateToThread = useCallback((threadId: string) => {
    navigate({ to: '/$budId/$threadId', params: { budId, threadId } })
  }, [navigate, budId])

  const threadPanel = activeBudProfile ? (
    <ThreadPanel
      threads={threads}
      activeThreadId={activeThreadId}
      onSelectThread={(threadId) => {
        handleSelectThread(threadId)
        if (isCompact) {
          setThreadPanelOpen(false)
        }
      }}
      onThreadDeleted={handleThreadDeleted}
      onOpenBudSettings={handleOpenBudSettings}
      onToggleOpen={() => setThreadPanelOpen(false)}
      onStatusChange={setThreadPanelStatus}
      accentColor={palette.vibrant}
      budLabel={activeBudProfile.label}
      budId={budId}
    />
  ) : null

  return (
    <div
      className="flex bg-background text-foreground"
      style={{ height: 'var(--app-height, 100dvh)' }}
    >
      {/* Below md the rail lives inside the thread drawer instead. */}
      <div className="flex max-md:hidden">
        <BudRail
          buds={buds}
          activeBudId={budId}
          onSelectBud={handleSelectBud}
          onOpenSettings={handleOpenSettings}
        />
      </div>
      {threadPanelOpen && !isCompact && threadPanel}
      {threadPanelOpen && isCompact && (
        <div className="fixed inset-0 z-40 flex">
          <button
            type="button"
            aria-label="Close thread list"
            className="absolute inset-0 bg-black/40"
            onClick={() => setThreadPanelOpen(false)}
          />
          {/* Opaque base: the panel's translucent bg-secondary/40 (and the
              rail's bg-less aside) are composited over the app background
              in-flow, but as an overlay they showed the chat through. */}
          <div className="relative flex h-full max-w-[92vw] bg-background pb-[env(safe-area-inset-bottom)]">
            {isMobile && (
              <BudRail
                buds={buds}
                activeBudId={budId}
                onSelectBud={(id) => {
                  handleSelectBud(id)
                  setThreadPanelOpen(false)
                }}
                onOpenSettings={handleOpenSettings}
              />
            )}
            {threadPanel}
          </div>
        </div>
      )}

      {/* Bud settings modal (sessions live in a tab) */}
      {activeApiBud && (
        <BudSettingsModal
          bud={activeApiBud}
          isOpen={budSettings.open}
          initialTab={budSettings.tab}
          onClose={handleCloseBudSettings}
          onNavigateToThread={handleNavigateToThread}
          onBudUpdated={handleBudUpdated}
        />
      )}
      <div className="flex flex-1 flex-col overflow-hidden">
        {threadPanelStatus && (
          <MutationStatus
            tone={threadPanelStatus.tone}
            message={threadPanelStatus.message}
            className="rounded-none border-x-0 border-t-0 shadow-none"
            onDismiss={() => setThreadPanelStatus(null)}
          />
        )}
        <BudRouteContext.Provider
          value={{
            budLabel: activeBudProfile?.label ?? null,
            threads,
            upsertThreadSummary,
            patchThreadSummary,
            removeThreadSummary,
          } satisfies BudRouteContextValue}
        >
          <Outlet />
        </BudRouteContext.Provider>
      </div>
    </div>
  )
}
