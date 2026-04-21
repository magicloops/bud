import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { useAuthSession } from '@/contexts/auth-session-context'
import {
  apiFetchJson,
  isApiError,
} from '@/lib/transport'
import type { ApiBud } from '@/lib/api-types'
import { toLoginRedirect } from '@/lib/route-auth'

export const Route = createFileRoute('/')({
  loader: async ({ location }) => {
    try {
      const buds = await apiFetchJson<ApiBud[]>('/api/buds', { redirectOnUnauthorized: false })
      if (buds.length > 0) {
        throw redirect({ to: '/$budId', params: { budId: buds[0].bud_id } })
      }
      return {}
    } catch (error) {
      if (isApiError(error, 401)) {
        throw toLoginRedirect(location.href)
      }
      throw error
    }
  },
  component: NoBudsView,
})

function NoBudsView() {
  const { currentUser } = useAuthSession()

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-3xl rounded-[2rem] border-4 border-black bg-[var(--chat-bg)] p-8 shadow-[12px_12px_0px_rgba(0,0,0,1)]">
        <div className="space-y-4">
          <p className="inline-flex rounded-full border-2 border-black bg-[var(--bud-accent-soft)] px-3 py-1 font-mono text-xs uppercase tracking-[0.25em] text-black">
            Signed In
          </p>
          <div className="space-y-2">
            <h1 className="text-4xl font-black tracking-tight">Your account is ready. No Buds are enrolled yet.</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {currentUser
                ? `Signed in as @${currentUser.profile.username} (${currentUser.user.email}). Once you enroll your first Bud, it will appear here automatically.`
                : 'Once you enroll your first Bud, it will appear here automatically.'}
            </p>
          </div>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border-4 border-black bg-card p-5 shadow-[6px_6px_0px_rgba(0,0,0,1)]">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">What just happened</p>
            <p className="mt-3 text-sm leading-6">
              Browser auth is working and your session is active. This screen is the authenticated empty state, not the old anonymous fallback.
            </p>
          </div>
          <div className="rounded-2xl border-4 border-black bg-[var(--bud-accent-soft)] p-5 shadow-[6px_6px_0px_rgba(0,0,0,1)]">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-black/70">Next step</p>
            <p className="mt-3 text-sm leading-6 text-black">
              Enroll a Bud device or continue into the upcoming claim flow. Once a Bud exists for your account, the app will route you into its workspace.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            to="/settings"
            className="inline-flex rounded-xl border-4 border-black bg-card px-4 py-3 font-mono text-sm font-semibold uppercase tracking-wide shadow-[4px_4px_0px_rgba(0,0,0,1)] transition hover:-translate-y-0.5"
          >
            Open settings
          </Link>
        </div>
      </div>
    </div>
  )
}
