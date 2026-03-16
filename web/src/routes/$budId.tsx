import { createFileRoute, Outlet, redirect, useNavigate, useMatches } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BudRail, type BudProfile, type BudCapabilities } from '@/components/workbench/bud-rail'
import { ThreadPanel, type ThreadSummary } from '@/components/workbench/thread-panel'
import { BudSessionsModal } from '@/components/bud-sessions-modal'
import { DEFAULT_AVATAR_COLORS, deriveBudPalette } from '@/lib/theme-colors'
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
  const { buds: rawBuds, bud: _bud, threads: initialThreads } = Route.useLoaderData()
  const { budId } = Route.useParams()
  const navigate = useNavigate()

  // Thread panel visibility - from global context (shared across all buds/threads)
  const { threadPanelOpen } = useLayout()

  // Sessions modal state
  const [sessionsModalOpen, setSessionsModalOpen] = useState(false)

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

  // Convert API threads to ThreadSummary format
  const threads: ThreadSummary[] = useMemo(() => {
    return initialThreads.map((t) => ({
      thread_id: t.thread_id,
      bud_id: t.bud_id,
      title: t.title,
      created_at: t.created_at,
      last_activity_at: t.last_activity_at,
      last_message_preview: t.last_message_preview,
      message_count: t.message_count,
      pinned: t.pinned,
      archived: t.archived,
      has_terminal_session: t.has_terminal_session,
      session_state: t.session_state,
      session_id: t.session_id,
    }))
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

  const handleSelectThread = useCallback((threadId: string | null) => {
    if (threadId) {
      navigate({ to: '/$budId/$threadId', params: { budId, threadId } })
    } else {
      navigate({ to: '/$budId/new', params: { budId } })
    }
  }, [navigate, budId])

  const handleThreadDeleted = useCallback((_deletedThreadId: string) => {
    // Router will handle re-fetching threads on navigation
    // Just navigate to "new thread" mode
    navigate({ to: '/$budId', params: { budId } })
  }, [navigate, budId])

  const handleOpenSettings = useCallback(() => {
    navigate({ to: '/settings' })
  }, [navigate])

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
      />
      {threadPanelOpen && activeBudProfile && (
        <ThreadPanel
          threads={threads}
          activeThreadId={activeThreadId}
          onSelectThread={handleSelectThread}
          onThreadDeleted={handleThreadDeleted}
          onOpenSettings={handleOpenSettings}
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
        <Outlet />
      </div>
    </div>
  )
}
