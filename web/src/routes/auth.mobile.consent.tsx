import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AuthDetailPanel, AuthPageShell } from '@/components/auth-page-shell'
import { useAuthSession } from '@/contexts/auth-session-context'
import { buildAbsoluteApiUrl } from '@/lib/transport'
import {
  formatOAuthScopeLabel,
  getOAuthRequestDetails,
  hasOAuthPrompt,
} from '@/lib/oauth-provider'

type ConsentAction = 'approve' | 'deny' | null

type ConsentResponse = {
  redirect_uri?: string
  url?: string
}

export const Route = createFileRoute('/auth/mobile/consent')({
  component: MobileAuthConsentView,
})

async function readConsentError(response: Response) {
  const body = await response.json().catch(() => null)
  if (body && typeof body === 'object') {
    if ('error_description' in body && typeof body.error_description === 'string') {
      return body.error_description
    }
    if ('error' in body && typeof body.error === 'string') {
      return body.error
    }
  }
  return `HTTP ${response.status}`
}

function MobileAuthConsentView() {
  const { currentUser } = useAuthSession()
  const [pendingAction, setPendingAction] = useState<ConsentAction>(null)
  const [error, setError] = useState<string | null>(null)
  const currentSearch = typeof window === 'undefined' ? '' : window.location.search
  const oauthRequest = getOAuthRequestDetails(currentSearch)
  const loginHref = `/auth/mobile${currentSearch}`

  useEffect(() => {
    if (currentUser || !oauthRequest.signedQuery) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      window.location.replace(loginHref)
    }, 600)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [currentUser, loginHref, oauthRequest.signedQuery])

  const handleConsent = async (accept: boolean) => {
    if (!oauthRequest.signedQuery) {
      setError('Missing OAuth request state')
      return
    }

    setPendingAction(accept ? 'approve' : 'deny')
    setError(null)

    try {
      const response = await fetch(buildAbsoluteApiUrl('/api/auth/oauth2/consent'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accept,
          oauth_query: oauthRequest.signedQuery,
        }),
      })

      if (!response.ok) {
        throw new Error(await readConsentError(response))
      }

      const data = (await response.json().catch(() => null)) as ConsentResponse | null
      const redirectUrl = data?.redirect_uri ?? data?.url
      if (!redirectUrl) {
        throw new Error('Consent completed without a redirect URL')
      }

      window.location.replace(redirectUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit consent')
      setPendingAction(null)
    }
  }

  const title = currentUser ? 'Review Bud mobile access' : 'Sign in to review access'
  const description = currentUser
    ? 'Bud usually skips this page for trusted first-party clients. Force `prompt=consent` to verify the consent path end-to-end.'
    : 'Bud needs an authenticated browser session before it can finish this OAuth request.'

  return (
    <AuthPageShell badge="Mobile Consent" title={title} description={description} error={error}>
      <div className="mt-8 space-y-4">
        {!oauthRequest.signedQuery && (
          <AuthDetailPanel label="Consent state">
            <p className="text-muted-foreground">
              This page was opened without Better Auth&apos;s signed OAuth query. Start from the
              hosted mobile login page instead.
            </p>
          </AuthDetailPanel>
        )}

        {oauthRequest.signedQuery && !currentUser && (
          <AuthDetailPanel label="Session status">
            <p className="text-muted-foreground">
              Redirecting you to the hosted mobile login page now.
            </p>
            <a href={loginHref} className="mt-3 inline-flex font-semibold underline">
              Continue to sign in
            </a>
          </AuthDetailPanel>
        )}

        {oauthRequest.signedQuery && currentUser && (
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
                  This request explicitly forced a consent screen.
                </p>
              )}
            </div>

            {oauthRequest.redirectUri && (
              <AuthDetailPanel label="App redirect URI">
                <p className="break-all">{oauthRequest.redirectUri}</p>
              </AuthDetailPanel>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => handleConsent(true)}
                disabled={pendingAction !== null}
                className="inline-flex rounded-2xl border-4 border-black bg-[var(--bud-accent-soft)] px-5 py-3 font-semibold shadow-[6px_6px_0px_rgba(0,0,0,1)] disabled:cursor-wait disabled:opacity-70"
              >
                {pendingAction === 'approve' ? 'Approving...' : 'Approve access'}
              </button>
              <button
                type="button"
                onClick={() => handleConsent(false)}
                disabled={pendingAction !== null}
                className="inline-flex rounded-2xl border-4 border-black bg-background px-5 py-3 font-semibold shadow-[6px_6px_0px_rgba(0,0,0,1)] disabled:cursor-wait disabled:opacity-70"
              >
                {pendingAction === 'deny' ? 'Denying...' : 'Deny'}
              </button>
            </div>
          </>
        )}
      </div>
    </AuthPageShell>
  )
}
