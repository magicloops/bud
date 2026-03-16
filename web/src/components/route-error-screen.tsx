import { Home, LockKeyhole, SearchX, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isApiError } from '@/lib/api'

type RouteErrorScreenProps = {
  error: unknown
}

const readApiErrorCode = (error: unknown) => {
  if (!isApiError(error)) {
    return null
  }

  const { body } = error
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'string'
  ) {
    return body.error
  }

  return typeof error.message === 'string' ? error.message : null
}

const readErrorMessage = (error: unknown) => {
  if (typeof readApiErrorCode(error) === 'string') {
    return readApiErrorCode(error)
  }
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message
  }
  return null
}

const isDisplayableErrorCode = (value: string | null) =>
  typeof value === 'string' && /^[a-z0-9_]+$/i.test(value)

const getErrorPresentation = (error: unknown) => {
  const errorCode = readApiErrorCode(error)
  const normalizedMessage = readErrorMessage(error)?.trim().toLowerCase() ?? ''

  if (
    isApiError(error, 404) ||
    normalizedMessage.endsWith('_not_found') ||
    normalizedMessage.includes('not found')
  ) {
    return {
      eyebrow: 'Not Available',
      title: 'This Bud page is not available',
      description:
        'That Bud or thread either does not exist anymore, or your account does not have access to it.',
      hint: 'If you expected to see it here, make sure you are signed into the right account.',
      icon: SearchX,
      tone:
        'bg-[var(--bud-accent-soft)] text-black',
      errorCode: isDisplayableErrorCode(errorCode) ? errorCode : null,
    }
  }

  if (isApiError(error, 401) || normalizedMessage === 'unauthorized') {
    return {
      eyebrow: 'Sign In Required',
      title: 'Your session is no longer active',
      description: 'Bud needs you to sign in again before it can open this page.',
      hint: 'Returning home will restart the normal auth flow.',
      icon: LockKeyhole,
      tone: 'bg-[var(--bud-accent-soft)] text-black',
      errorCode: isDisplayableErrorCode(errorCode) ? errorCode : null,
    }
  }

  return {
    eyebrow: 'Route Error',
    title: 'We could not open this page',
    description: 'Something went wrong while loading this workspace.',
    hint: 'Head back home and try again. If the problem persists, check the service and browser logs.',
    icon: TriangleAlert,
    tone: 'bg-secondary text-secondary-foreground',
    errorCode: isDisplayableErrorCode(errorCode) ? errorCode : null,
  }
}

export function RouteErrorScreen({ error }: RouteErrorScreenProps) {
  const presentation = getErrorPresentation(error)
  const Icon = presentation.icon

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-2xl rounded-[2rem] border-4 border-black bg-[var(--chat-bg)] p-8 shadow-[12px_12px_0px_rgba(0,0,0,1)]">
        <div className="space-y-4">
          <div
            className={`inline-flex items-center gap-2 rounded-full border-2 border-black px-3 py-1 font-mono text-xs uppercase tracking-[0.25em] ${presentation.tone}`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{presentation.eyebrow}</span>
          </div>

          <div className="space-y-3">
            <h1 className="text-4xl font-black tracking-tight">{presentation.title}</h1>
            <p className="max-w-xl text-sm text-muted-foreground">{presentation.description}</p>
            <p className="max-w-xl text-sm text-muted-foreground">{presentation.hint}</p>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <Button
            asChild
            className="h-12 rounded-2xl border-4 border-black bg-card px-5 font-semibold text-foreground shadow-[6px_6px_0px_rgba(0,0,0,1)] transition hover:-translate-y-0.5"
          >
            <a href="/">
              <Home className="h-4 w-4" />
              Return Home
            </a>
          </Button>
        </div>

        {presentation.errorCode && (
          <div className="mt-8 rounded-2xl border-3 border-dashed border-black/70 bg-background/70 p-4">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Error code</p>
            <p className="mt-2 font-mono text-sm">{presentation.errorCode}</p>
          </div>
        )}
      </div>
    </div>
  )
}
