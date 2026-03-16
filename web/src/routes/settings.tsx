import { ArrowLeft, Chrome, Github, Loader2, LogOut, Save } from 'lucide-react'
import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useAuthSession } from '@/contexts/auth-session-context'
import { authClient } from '@/lib/auth-client'
import {
  fetchCurrentUser,
  getLoginRedirectValue,
  isApiError,
  type ApiCurrentUser,
  updateCurrentUserProfile,
} from '@/lib/api'

const toLoginRedirect = (pathname: string, search = '', hash = '') =>
  redirect({
    to: '/login',
    search: {
      redirect: getLoginRedirectValue(pathname, search, hash),
    },
  })

export const Route = createFileRoute('/settings')({
  beforeLoad: async ({ location }) => {
    const currentUser = await fetchCurrentUser()
    if (!currentUser) {
      throw toLoginRedirect(location.href)
    }
  },
  component: SettingsView,
})

function deriveAvatarLabel(currentUser: ApiCurrentUser) {
  const seed =
    currentUser.profile.username ||
    currentUser.user.name ||
    currentUser.user.email.split('@')[0] ||
    'bud'

  return seed
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'BU'
}

function providerStatusLabel(linked: boolean) {
  return linked ? 'Connected' : 'Not linked'
}

function SettingsView() {
  const navigate = useNavigate()
  const { currentUser, setCurrentUser } = useAuthSession()
  const [usernameDraft, setUsernameDraft] = useState(currentUser?.profile.username ?? '')
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null)
  const [savingProfile, setSavingProfile] = useState(false)
  const [linkingProvider, setLinkingProvider] = useState<'github' | 'google' | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)

  useEffect(() => {
    setUsernameDraft(currentUser?.profile.username ?? '')
  }, [currentUser?.profile.username])

  const avatarLabel = useMemo(
    () => (currentUser ? deriveAvatarLabel(currentUser) : 'BU'),
    [currentUser],
  )

  if (!currentUser) {
    return null
  }

  const usernameChanged = usernameDraft.trim() !== currentUser.profile.username

  const handleSaveProfile = async () => {
    setSavingProfile(true)
    setProfileError(null)
    setProfileSuccess(null)

    try {
      const updatedUser = await updateCurrentUserProfile({
        username: usernameDraft,
      })
      setCurrentUser(updatedUser)
      setUsernameDraft(updatedUser.profile.username)
      setProfileSuccess('Username updated.')
    } catch (error) {
      if (isApiError(error, 409)) {
        setProfileError('That username is already taken.')
      } else if (isApiError(error, 400)) {
        setProfileError('Username must normalize to at least 3 characters.')
      } else {
        setProfileError(error instanceof Error ? error.message : 'Failed to update username.')
      }
    } finally {
      setSavingProfile(false)
    }
  }

  const handleLinkProvider = async (provider: 'github' | 'google') => {
    setLinkingProvider(provider)
    setLinkError(null)

    try {
      const callbackURL = new URL('/settings', window.location.origin).toString()
      await authClient.linkSocial({
        provider,
        callbackURL,
      })
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : `Failed to link ${provider}.`)
      setLinkingProvider(null)
    }
  }

  const handleSignOut = async () => {
    setSigningOut(true)
    setSessionError(null)

    try {
      await authClient.signOut()
      setCurrentUser(null)
      await navigate({
        to: '/login',
        search: {
          redirect: '/',
        },
        replace: true,
      })
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : 'Failed to sign out.')
      setSigningOut(false)
    }
  }

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            to="/"
            className="inline-flex items-center gap-2 rounded-xl border-4 border-black bg-card px-4 py-3 font-mono text-sm font-semibold uppercase tracking-wide shadow-[4px_4px_0px_rgba(0,0,0,1)] transition hover:-translate-y-0.5"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to workspace
          </Link>
          <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
            Settings
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <section className="rounded-[2rem] border-4 border-black bg-[var(--chat-bg)] p-8 shadow-[12px_12px_0px_rgba(0,0,0,1)]">
            <div className="flex flex-col gap-6">
              <div className="flex flex-wrap items-center gap-5">
                {currentUser.user.image ? (
                  <img
                    src={currentUser.user.image}
                    alt={`Avatar for @${currentUser.profile.username}`}
                    className="h-24 w-24 rounded-[1.5rem] border-4 border-black object-cover shadow-[6px_6px_0px_rgba(0,0,0,1)]"
                  />
                ) : (
                  <div className="flex h-24 w-24 items-center justify-center rounded-[1.5rem] border-4 border-black bg-[var(--bud-accent-soft)] text-3xl font-black uppercase text-black shadow-[6px_6px_0px_rgba(0,0,0,1)]">
                    {avatarLabel}
                  </div>
                )}

                <div className="space-y-2">
                  <p className="inline-flex rounded-full border-2 border-black bg-[var(--bud-accent-soft)] px-3 py-1 font-mono text-xs uppercase tracking-[0.25em] text-black">
                    Account
                  </p>
                  <div>
                    <h1 className="text-4xl font-black tracking-tight">@{currentUser.profile.username}</h1>
                    <p className="text-sm text-muted-foreground">
                      {currentUser.user.email}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border-4 border-black bg-card p-5 shadow-[6px_6px_0px_rgba(0,0,0,1)]">
                <div className="space-y-2">
                  <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
                    Username
                  </p>
                  <h2 className="text-2xl font-black tracking-tight">Choose the handle Bud shows in the UI.</h2>
                  <p className="text-sm text-muted-foreground">
                    Lowercase letters, numbers, <code>_</code>, and <code>-</code> are preserved.
                    Spaces and unsupported characters normalize to dashes.
                  </p>
                </div>

                <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end">
                  <label className="flex-1">
                    <span className="mb-2 block font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
                      Username
                    </span>
                    <div className="flex items-center rounded-xl border-4 border-black bg-background px-4 shadow-[4px_4px_0px_rgba(0,0,0,1)]">
                      <span className="font-mono text-sm text-muted-foreground">@</span>
                      <input
                        value={usernameDraft}
                        onChange={(event) => setUsernameDraft(event.target.value)}
                        className="h-12 w-full bg-transparent px-2 text-base outline-none"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </div>
                  </label>

                  <Button
                    type="button"
                    onClick={handleSaveProfile}
                    disabled={!usernameChanged || savingProfile}
                    className="h-12 rounded-xl border-4 border-black bg-[var(--bud-accent-soft)] px-5 text-black shadow-[4px_4px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 hover:bg-[var(--bud-accent-soft)] disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {savingProfile ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save username
                  </Button>
                </div>

                {profileError && (
                  <div className="mt-4 rounded-xl border-3 border-black bg-destructive px-4 py-3 text-sm font-semibold text-destructive-foreground shadow-[4px_4px_0px_rgba(0,0,0,1)]">
                    {profileError}
                  </div>
                )}

                {profileSuccess && (
                  <div className="mt-4 rounded-xl border-3 border-black bg-[var(--bud-accent-soft)] px-4 py-3 text-sm font-semibold text-black shadow-[4px_4px_0px_rgba(0,0,0,1)]">
                    {profileSuccess}
                  </div>
                )}
              </div>
            </div>
          </section>

          <div className="flex flex-col gap-6">
            <section className="rounded-[2rem] border-4 border-black bg-card p-6 shadow-[10px_10px_0px_rgba(0,0,0,1)]">
              <div className="space-y-2">
                <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Linked accounts
                </p>
                <h2 className="text-2xl font-black tracking-tight">Connect the providers you want to use.</h2>
              </div>

              <div className="mt-5 space-y-3">
                <ProviderCard
                  provider="github"
                  label="GitHub"
                  icon={<Github className="h-5 w-5" />}
                  linked={currentUser.linked_accounts.github}
                  pending={linkingProvider === 'github'}
                  onConnect={handleLinkProvider}
                />
                <ProviderCard
                  provider="google"
                  label="Google"
                  icon={<Chrome className="h-5 w-5" />}
                  linked={currentUser.linked_accounts.google}
                  pending={linkingProvider === 'google'}
                  onConnect={handleLinkProvider}
                />
              </div>

              <p className="mt-4 text-sm text-muted-foreground">
                Same verified email addresses auto-link into the same Bud account. Manual linking here remains available for existing sessions.
              </p>

              {linkError && (
                <div className="mt-4 rounded-xl border-3 border-black bg-destructive px-4 py-3 text-sm font-semibold text-destructive-foreground shadow-[4px_4px_0px_rgba(0,0,0,1)]">
                  {linkError}
                </div>
              )}
            </section>

            <section className="rounded-[2rem] border-4 border-black bg-[var(--bud-accent-soft)] p-6 shadow-[10px_10px_0px_rgba(0,0,0,1)]">
              <div className="space-y-2">
                <p className="font-mono text-xs uppercase tracking-[0.2em] text-black/70">
                  Session
                </p>
                <h2 className="text-2xl font-black tracking-tight text-black">End the current browser session.</h2>
                <p className="text-sm text-black/70">
                  The current Better Auth session ends immediately. Returning to the app will require sign-in again.
                </p>
              </div>

              <Button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="mt-5 h-12 w-full rounded-xl border-4 border-black bg-black px-5 text-sm font-semibold uppercase tracking-wide text-white shadow-[4px_4px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 hover:bg-black disabled:cursor-not-allowed disabled:opacity-70"
              >
                {signingOut ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogOut className="mr-2 h-4 w-4" />}
                Sign out
              </Button>

              {sessionError && (
                <div className="mt-4 rounded-xl border-3 border-black bg-destructive px-4 py-3 text-sm font-semibold text-destructive-foreground shadow-[4px_4px_0px_rgba(0,0,0,1)]">
                  {sessionError}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

function ProviderCard({
  provider,
  label,
  icon,
  linked,
  pending,
  onConnect,
}: {
  provider: 'github' | 'google'
  label: string
  icon: ReactNode
  linked: boolean
  pending: boolean
  onConnect: (provider: 'github' | 'google') => Promise<void>
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border-4 border-black bg-background px-4 py-4 shadow-[4px_4px_0px_rgba(0,0,0,1)]">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl border-3 border-black bg-card">
          {icon}
        </div>
        <div>
          <p className="font-semibold">{label}</p>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            {providerStatusLabel(linked)}
          </p>
        </div>
      </div>

      <Button
        type="button"
        onClick={() => onConnect(provider)}
        disabled={linked || pending}
        className="rounded-xl border-4 border-black bg-[var(--bud-accent-soft)] px-4 py-2 text-black shadow-[4px_4px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 hover:bg-[var(--bud-accent-soft)] disabled:cursor-not-allowed disabled:opacity-70"
      >
        {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        {linked ? 'Connected' : 'Connect'}
      </Button>
    </div>
  )
}
