import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  AuthDetailPanel,
  AuthPageShell,
  SocialSignInActions,
  type SocialAuthProvider,
} from '@/components/auth-page-shell'
import { useAuthSession } from '@/contexts/auth-session-context'
import { authClient } from '@/lib/auth-client'
import {
  formatOAuthScopeLabel,
  getOAuthRequestDetails,
  hasOAuthPrompt,
} from '@/lib/oauth-provider'

export const Route = createFileRoute('/auth/mobile')({
  component: MobileAuthLoginView,
})

function MobileAuthLoginView() {
  const { currentUser } = useAuthSession()
  const [pendingProvider, setPendingProvider] = useState<SocialAuthProvider | null>(null)
  const [error, setError] = useState<string | null>(null)
  const oauthRequest = getOAuthRequestDetails(
    typeof window === 'undefined' ? '' : window.location.search,
  )
  const continuingAuthorization = currentUser !== null && oauthRequest.authorizeResumeUrl !== null

  useEffect(() => {
    if (!continuingAuthorization || !oauthRequest.authorizeResumeUrl) {
      return
    }

    window.location.replace(oauthRequest.authorizeResumeUrl)
  }, [continuingAuthorization, oauthRequest.authorizeResumeUrl])

  const handleSocialSignIn = async (provider: SocialAuthProvider) => {
    setPendingProvider(provider)
    setError(null)

    try {
      const callbackURL =
        typeof window === 'undefined'
          ? 'http://localhost/auth/mobile'
          : new URL(`${window.location.pathname}${window.location.search}`, window.location.origin).toString()
      await authClient.signIn.social({
        provider,
        callbackURL,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to start ${provider} sign-in`)
      setPendingProvider(null)
    }
  }

  const title = continuingAuthorization
    ? 'Continuing mobile authorization'
    : currentUser
      ? 'Your Bud session is ready'
      : 'Sign in to Bud mobile'

  const description = continuingAuthorization
    ? 'Your Bud session is active. Finishing the OAuth request now.'
    : oauthRequest.signedQuery
      ? 'Use GitHub or Google to continue the mobile OAuth flow. After sign-in, Bud will resume the authorization request automatically.'
      : 'This page is reserved for mobile OAuth entry. Use GitHub or Google to start a Bud mobile sign-in session.'

  return (
    <AuthPageShell badge="Mobile Auth" title={title} description={description} error={error}>
      {continuingAuthorization ? (
        <div className="mt-8 rounded-2xl border-4 border-black bg-card px-5 py-4 shadow-[6px_6px_0px_rgba(0,0,0,1)]">
          <p className="text-sm font-semibold">Redirecting back into Better Auth to resume authorization...</p>
        </div>
      ) : (
        <SocialSignInActions
          pendingProvider={pendingProvider}
          disabled={continuingAuthorization}
          onProviderSelect={handleSocialSignIn}
        />
      )}

      <div className="mt-8 space-y-4">
        {oauthRequest.signedQuery ? (
          <>
            <AuthDetailPanel label="Client ID">
              <p className="break-all">{oauthRequest.clientId ?? 'Unknown client'}</p>
            </AuthDetailPanel>

            <div className="rounded-2xl border-3 border-dashed border-black/70 bg-background/70 p-4">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
                Requested scopes
              </p>
              {oauthRequest.scopes.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {oauthRequest.scopes.map((scope) => (
                    <span
                      key={scope}
                      className="rounded-full border-2 border-black bg-[var(--bud-accent-soft)] px-3 py-1 font-mono text-xs uppercase tracking-[0.15em] text-black"
                    >
                      {formatOAuthScopeLabel(scope)}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No explicit scopes were requested.</p>
              )}
              {hasOAuthPrompt(oauthRequest.prompt, 'consent') && (
                <p className="mt-3 text-xs text-muted-foreground">
                  This request explicitly asked Better Auth to show consent.
                </p>
              )}
            </div>

            {oauthRequest.redirectUri && (
              <AuthDetailPanel label="App redirect URI">
                <p className="break-all">{oauthRequest.redirectUri}</p>
              </AuthDetailPanel>
            )}
          </>
        ) : (
          <AuthDetailPanel label="Route usage">
            <p className="text-muted-foreground">
              This page is meant to be launched by Better Auth as the hosted mobile login surface.
              Normal browser sign-in still lives on{' '}
              <Link to="/login" className="font-semibold underline">
                /login
              </Link>
              .
            </p>
          </AuthDetailPanel>
        )}
      </div>
    </AuthPageShell>
  )
}
