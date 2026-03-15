import { Chrome, Github } from 'lucide-react'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { authClient } from '@/lib/auth-client'
import { normalizeAppRedirectPath } from '@/lib/api'
import { useAuthSession } from '@/contexts/auth-session-context'

type LoginSearch = {
  redirect?: string
}

const getLoginTarget = (redirectValue?: string) => normalizeAppRedirectPath(redirectValue)

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  component: LoginView,
})

function LoginView() {
  const search = Route.useSearch()
  const { currentUser } = useAuthSession()
  const [pendingProvider, setPendingProvider] = useState<'github' | 'google' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loginTarget = getLoginTarget(search.redirect)
  const isClaimRedirect = loginTarget.startsWith('/devices/claim/')

  useEffect(() => {
    if (!currentUser) {
      return
    }

    window.location.replace(loginTarget)
  }, [currentUser, loginTarget])

  const handleSocialSignIn = async (provider: 'github' | 'google') => {
    setPendingProvider(provider)
    setError(null)

    try {
      const callbackURL = new URL(loginTarget, window.location.origin).toString()
      await authClient.signIn.social({
        provider,
        callbackURL,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to start ${provider} sign-in`)
      setPendingProvider(null)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-xl rounded-[2rem] border-4 border-black bg-[var(--chat-bg)] p-8 shadow-[12px_12px_0px_rgba(0,0,0,1)]">
        <div className="space-y-3">
          <p className="inline-flex rounded-full border-2 border-black bg-[var(--bud-accent-soft)] px-3 py-1 font-mono text-xs uppercase tracking-[0.25em] text-black">
            {isClaimRedirect ? 'Claim Login' : 'Bud Login'}
          </p>
          <h1 className="text-4xl font-black tracking-tight">
            {isClaimRedirect ? 'Sign in to approve this Bud device' : 'Sign in to your Bud workspace'}
          </h1>
          <p className="max-w-lg text-sm text-muted-foreground">
            {isClaimRedirect
              ? 'Use GitHub or Google to continue. After sign-in, Bud will return you to the pending device claim automatically.'
              : 'Use GitHub or Google to continue. If you already have an active session, the app will return you automatically.'}
          </p>
        </div>

        <div className="mt-8 grid gap-3">
          <button
            type="button"
            onClick={() => handleSocialSignIn('github')}
            disabled={pendingProvider !== null}
            className="flex items-center justify-between rounded-2xl border-4 border-black bg-card px-5 py-4 text-left shadow-[6px_6px_0px_rgba(0,0,0,1)] transition hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
          >
            <span className="flex items-center gap-3">
              <Github className="h-5 w-5" />
              <span className="font-semibold">Continue with GitHub</span>
            </span>
            <span className="font-mono text-xs uppercase text-muted-foreground">
              {pendingProvider === 'github' ? 'Starting...' : 'OAuth'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => handleSocialSignIn('google')}
            disabled={pendingProvider !== null}
            className="flex items-center justify-between rounded-2xl border-4 border-black bg-[var(--bud-accent-soft)] px-5 py-4 text-left shadow-[6px_6px_0px_rgba(0,0,0,1)] transition hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
          >
            <span className="flex items-center gap-3">
              <Chrome className="h-5 w-5" />
              <span className="font-semibold">Continue with Google</span>
            </span>
            <span className="font-mono text-xs uppercase text-black/60">
              {pendingProvider === 'google' ? 'Starting...' : 'OAuth'}
            </span>
          </button>
        </div>

        <div className="mt-8 rounded-2xl border-3 border-dashed border-black/70 bg-background/70 p-4">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Return target</p>
          <p className="mt-2 break-all text-sm">{loginTarget}</p>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border-3 border-black bg-destructive px-4 py-3 text-sm font-semibold text-destructive-foreground shadow-[4px_4px_0px_rgba(0,0,0,1)]">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
