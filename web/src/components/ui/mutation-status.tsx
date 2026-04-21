import { AlertCircle, CheckCircle2, Info, Loader2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type MutationStatusTone = 'pending' | 'success' | 'error' | 'info'

type MutationStatusProps = {
  tone: MutationStatusTone
  message: ReactNode
  title?: string
  action?: ReactNode
  className?: string
  onDismiss?: () => void
}

const toneStyles: Record<MutationStatusTone, string> = {
  pending: 'bg-card text-foreground',
  success: 'bg-[var(--bud-accent-soft)] text-black',
  error: 'bg-destructive text-destructive-foreground',
  info: 'bg-card text-foreground',
}

const toneIcons: Record<MutationStatusTone, typeof Loader2> = {
  pending: Loader2,
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
}

export function MutationStatus({
  tone,
  message,
  title,
  action,
  className,
  onDismiss,
}: MutationStatusProps) {
  const Icon = toneIcons[tone]

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-xl border-3 border-black px-4 py-3 text-sm shadow-[4px_4px_0px_rgba(0,0,0,1)]',
        toneStyles[tone],
        className,
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'pending' && 'animate-spin')} />

      <div className="min-w-0 flex-1">
        {title ? <p className="font-mono text-xs uppercase tracking-[0.2em]">{title}</p> : null}
        <div className={cn(title && 'mt-1', 'font-semibold')}>{message}</div>
      </div>

      {action ? <div className="shrink-0">{action}</div> : null}

      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-md border-2 border-black/70 p-1 transition-transform hover:-translate-y-0.5"
          aria-label="Dismiss status message"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  )
}
