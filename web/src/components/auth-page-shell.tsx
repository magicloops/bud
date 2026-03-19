import { Chrome, Github } from 'lucide-react'
import type { ReactNode } from 'react'

export type SocialAuthProvider = 'github' | 'google'

type AuthPageShellProps = {
  badge: string
  title: string
  description: string
  children: ReactNode
  error?: string | null
}

type AuthDetailPanelProps = {
  label: string
  children: ReactNode
}

type SocialSignInActionsProps = {
  pendingProvider: SocialAuthProvider | null
  disabled?: boolean
  onProviderSelect: (provider: SocialAuthProvider) => void
}

export function AuthPageShell({
  badge,
  title,
  description,
  children,
  error,
}: AuthPageShellProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-xl rounded-[2rem] border-4 border-black bg-[var(--chat-bg)] p-8 shadow-[12px_12px_0px_rgba(0,0,0,1)]">
        <div className="space-y-3">
          <p className="inline-flex rounded-full border-2 border-black bg-[var(--bud-accent-soft)] px-3 py-1 font-mono text-xs uppercase tracking-[0.25em] text-black">
            {badge}
          </p>
          <h1 className="text-4xl font-black tracking-tight">{title}</h1>
          <p className="max-w-lg text-sm text-muted-foreground">{description}</p>
        </div>

        {children}

        {error && (
          <div className="mt-4 rounded-xl border-3 border-black bg-destructive px-4 py-3 text-sm font-semibold text-destructive-foreground shadow-[4px_4px_0px_rgba(0,0,0,1)]">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

export function AuthDetailPanel({ label, children }: AuthDetailPanelProps) {
  return (
    <div className="rounded-2xl border-3 border-dashed border-black/70 bg-background/70 p-4">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
      <div className="mt-2 text-sm">{children}</div>
    </div>
  )
}

export function SocialSignInActions({
  pendingProvider,
  disabled = false,
  onProviderSelect,
}: SocialSignInActionsProps) {
  const actionsDisabled = disabled || pendingProvider !== null

  return (
    <div className="mt-8 grid gap-3">
      <button
        type="button"
        onClick={() => onProviderSelect('github')}
        disabled={actionsDisabled}
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
        onClick={() => onProviderSelect('google')}
        disabled={actionsDisabled}
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
  )
}
