import { createFileRoute, Outlet, redirect, useNavigate, useMatches } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BudRail, type BudProfile, type BudCapabilities } from '@/components/workbench/bud-rail'
import { ThreadPanel, type ThreadSummary } from '@/components/workbench/thread-panel'
import { BudSessionsModal } from '@/components/bud-sessions-modal'
import { DEFAULT_AVATAR_COLORS, deriveBudPalette } from '@/lib/theme-colors'
import { BudRouteContext, type BudRouteContextValue } from '@/contexts/bud-route-context'
import {
  apiFetchJson,
  fetchCurrentUser,
  getLoginRedirectValue,
  isApiError,
  normalizeCapabilities,
  type ApiBud,
  type ApiThread,
} from '@/lib/api'
import { useLayout } from '@/contexts/layout-context'

const toLoginRedirect = (pathname: string, search = '', hash = '') =>
  redirect({
    to: '/login',
    search: {
      redirect: getLoginRedirectValue(pathname, search, hash),
    },
  })

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
  }
}

export const Route = createFileRoute('/$budId')({
  beforeLoad: async ({ location }) => {
    const currentUser = await fetchCurrentUser()
    if (!currentUser) {
      throw toLoginRedirect(location.href)
    }
  },
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

  // Thread panel visibility - from global context (shared across all buds/threads)
  const { threadPanelOpen } = useLayout()

  // Sessions modal state
  const [sessionsModalOpen, setSessionsModalOpen] = useState(false)
  const [threads, setThreads] = useState<ThreadSummary[]>(() => initialThreads.map(toThreadSummary))

  // Get threadId from child route match (if we're on /$budId/$threadId)
  const matches = useMatches()
  const activeThreadId = useMemo(() => {
    const threadMatch = matches.find(m => m.routeId === '/$budId/$threadId')
    return (threadMatch?.params as { threadId?: string })?.threadId ?? null
  }, [matches])

  // Convert API buds to BudProfile format
  const buds: BudProfile[] = useMemo(() => {
    return rawBuds.map((apiBud, index) => {
      const fallback = DEFAULT_AVATAR_COLORS[index % DEFAULT_AVATAR_COLORS.length]
      return {
        id: apiBud.bud_id,
        label: apiBud.display_name ?? apiBud.name,
        accentColor: apiBud.accent_color ?? fallback,
        status: apiBud.status,
        tags: apiBud.tags,
        capabilities: normalizeCapabilities(apiBud.capabilities) as BudCapabilities | null,
      }
    })
  }, [rawBuds])

  useEffect(() => {
    setThreads(initialThreads.map(toThreadSummary))
  }, [initialThreads])

  const activeBudProfile = useMemo(() => {
    return buds.find((b) => b.id === budId)
  }, [budId, buds])

  // Compute palette for theming
  const palette = useMemo(() => {
    const budIndex = buds.findIndex((b) => b.id === budId)
    const fallbackIndex = budIndex >= 0 ? budIndex : 0
    const fallbackColor = DEFAULT_AVATAR_COLORS[fallbackIndex % DEFAULT_AVATAR_COLORS.length] ?? 'var(--accent)'
    const baseColor = activeBudProfile?.accentColor ?? fallbackColor
    return deriveBudPalette(baseColor)
  }, [activeBudProfile, budId, buds])

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

  const handleOpenSessions = useCallback(() => {
    setSessionsModalOpen(true)
  }, [])

  const handleNavigateToThread = useCallback((threadId: string) => {
    navigate({ to: '/$budId/$threadId', params: { budId, threadId } })
  }, [navigate, budId])

  return (
    <div className="flex h-screen bg-background text-foreground">
      <BudRail
        buds={buds}
        activeBudId={budId}
        onSelectBud={handleSelectBud}
        onOpenSettings={handleOpenSettings}
      />
      {threadPanelOpen && activeBudProfile && (
        <ThreadPanel
          threads={threads}
          activeThreadId={activeThreadId}
          onSelectThread={handleSelectThread}
          onThreadDeleted={handleThreadDeleted}
          onOpenSessions={handleOpenSessions}
          accentColor={palette.vibrant}
          budLabel={activeBudProfile.label}
          budId={budId}
        />
      )}

      {/* Sessions Modal */}
      {activeBudProfile && (
        <BudSessionsModal
          budId={budId}
          budName={activeBudProfile.label}
          isOpen={sessionsModalOpen}
          onClose={() => setSessionsModalOpen(false)}
          onNavigateToThread={handleNavigateToThread}
        />
      )}
      <div className="flex flex-1 flex-col overflow-hidden">
        <BudRouteContext.Provider
          value={{
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
