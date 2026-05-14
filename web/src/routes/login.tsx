import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  AuthDetailPanel,
  AuthPageShell,
  SocialSignInActions,
  type SocialAuthProvider,
} from '@/components/auth-page-shell'
import { authClient } from '@/lib/auth-client'
import { normalizeAppRedirectPath } from '@/lib/auth-redirect'
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
  const [pendingProvider, setPendingProvider] = useState<SocialAuthProvider | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loginTarget = getLoginTarget(search.redirect)
  const isClaimRedirect = loginTarget.startsWith('/devices/claim/')

  useEffect(() => {
    if (!currentUser) {
      return
    }

    window.location.replace(loginTarget)
  }, [currentUser, loginTarget])

  const handleSocialSignIn = async (provider: SocialAuthProvider) => {
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
    <AuthPageShell
      badge={isClaimRedirect ? 'Claim Login' : 'Bud Login'}
      title={isClaimRedirect ? 'Sign in to approve this Bud device' : 'Sign in to Bud'}
      description={
        isClaimRedirect
          ? 'Use GitHub or Google to continue. After sign-in, Bud will return you to the pending device claim automatically.'
          : 'Use GitHub or Google to continue. If you already have an active session, the app will return you automatically.'
      }
      error={error}
    >
      <SocialSignInActions
        pendingProvider={pendingProvider}
        onProviderSelect={handleSocialSignIn}
      />
      <div className="mt-8">
        <AuthDetailPanel label="Return target">
          <p className="break-all">{loginTarget}</p>
        </AuthDetailPanel>
      </div>
    </AuthPageShell>
  )
}
