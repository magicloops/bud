import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAuthSession } from '@/contexts/auth-session-context'
import {
  apiFetchJson,
  buildLoginUrl,
  isApiError,
  type ApiDeviceAuthApproval,
  type ApiDeviceAuthFlow,
} from '@/lib/api'

export const Route = createFileRoute('/devices/claim/$flowId')({
  component: DeviceClaimView,
})

const FLOW_REFRESH_INTERVAL_MS = 1500
const AUTO_REDIRECT_DELAY_MS = 800

function getClaimRedirectStorageKey(flowId: string) {
  return `device-claim:auto-redirected:${flowId}`
}

async function fetchClaimFlow(flowId: string) {
  return apiFetchJson<ApiDeviceAuthFlow>(`/api/device-auth/flows/${flowId}`, {
    redirectOnUnauthorized: false,
  })
}

function getClaimErrorMessage(error: unknown) {
  if (isApiError(error, 404)) {
    return 'This Bud claim link is invalid or no longer exists.'
  }

  return error instanceof Error ? error.message : 'Failed to load device claim'
}

function DeviceClaimView() {
  const { flowId } = Route.useParams()
  const navigate = useNavigate()
  const { currentUser } = useAuthSession()
  const [flow, setFlow] = useState<ApiDeviceAuthFlow | null>(null)
  const [pending, setPending] = useState(true)
  const [approving, setApproving] = useState(false)
  const [approvalAttempted, setApprovalAttempted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const loadFlow = async () => {
      setPending(true)
      setApprovalAttempted(false)
      setApproving(false)
      setError(null)
      try {
        const nextFlow = await fetchClaimFlow(flowId)
        if (!cancelled) {
          setFlow(nextFlow)
        }
      } catch (err) {
        if (!cancelled) {
          setError(getClaimErrorMessage(err))
        }
      } finally {
        if (!cancelled) {
          setPending(false)
        }
      }
    }

    void loadFlow()

    return () => {
      cancelled = true
    }
  }, [flowId])

  useEffect(() => {
    if (!currentUser || !flow || (flow.status !== 'pending' && flow.status !== 'approved')) {
      return
    }

    let cancelled = false
    let timeoutId: number | null = null

    const refreshFlow = async () => {
      let shouldContinuePolling = true

      try {
        const nextFlow = await fetchClaimFlow(flowId)
        if (!cancelled) {
          setFlow(nextFlow)
          setError(null)
          if (nextFlow.status !== 'pending') {
            setApproving(false)
          }
        }

        shouldContinuePolling =
          nextFlow.status === 'pending' || nextFlow.status === 'approved'
      } catch (err) {
        if (!cancelled) {
          setError(getClaimErrorMessage(err))
        }
      } finally {
        if (!cancelled && shouldContinuePolling) {
          timeoutId = window.setTimeout(refreshFlow, FLOW_REFRESH_INTERVAL_MS)
        }
      }
    }

    timeoutId = window.setTimeout(refreshFlow, FLOW_REFRESH_INTERVAL_MS)

    return () => {
      cancelled = true
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [currentUser, flow, flowId])

  useEffect(() => {
    if (!flow || flow.status !== 'pending' || currentUser || pending) {
      return
    }

    const timeout = window.setTimeout(() => {
      window.location.replace(buildLoginUrl(`/devices/claim/${flowId}`))
    }, 600)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [currentUser, flow, flowId, pending])

  useEffect(() => {
    if (!flow || flow.status !== 'pending' || !currentUser || approving || approvalAttempted) {
      return
    }

    let cancelled = false

    const approve = async () => {
      setApproving(true)
      setApprovalAttempted(true)
      setError(null)
      try {
        const result = await apiFetchJson<ApiDeviceAuthApproval>(
          `/api/device-auth/flows/${flowId}/approve`,
          {
            method: 'POST',
          },
        )
        if (!cancelled) {
          setFlow((currentFlow) =>
            currentFlow
              && currentFlow.status !== 'completed'
              && currentFlow.status !== 'rejected'
              && currentFlow.status !== 'expired'
              ? {
                  ...currentFlow,
                  status: 'approved',
                  approved_at: currentFlow.approved_at ?? new Date().toISOString(),
                  approved_bud_id: result.bud_id,
                  error_code: null,
                }
              : currentFlow,
          )
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to approve device claim')
        }
      } finally {
        if (!cancelled) {
          setApproving(false)
        }
      }
    }

    void approve()

    return () => {
      cancelled = true
    }
  }, [approvalAttempted, approving, currentUser, flow, flowId])

  useEffect(() => {
    if (
      !flow?.approved_bud_id
      || (flow.status !== 'approved' && flow.status !== 'completed')
      || typeof window === 'undefined'
    ) {
      return
    }

    const storageKey = getClaimRedirectStorageKey(flowId)
    if (window.sessionStorage.getItem(storageKey) === '1') {
      return
    }

    const timeoutId = window.setTimeout(() => {
      window.sessionStorage.setItem(storageKey, '1')
      void navigate({
        to: '/$budId',
        params: { budId: flow.approved_bud_id as string },
      })
    }, AUTO_REDIRECT_DELAY_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [flow, flowId, navigate])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8 text-foreground">
      <div className="w-full max-w-xl rounded-[2rem] border-4 border-black bg-[var(--chat-bg)] p-8 shadow-[12px_12px_0px_rgba(0,0,0,1)]">
        <div className="space-y-3">
          <p className="inline-flex rounded-full border-2 border-black bg-[var(--bud-accent-soft)] px-3 py-1 font-mono text-xs uppercase tracking-[0.25em] text-black">
            Device Claim
          </p>
          <h1 className="text-4xl font-black tracking-tight">Approve this Bud device</h1>
          <p className="max-w-lg text-sm text-muted-foreground">
            {currentUser
              ? 'Your session is active. Bud will claim this device automatically and deliver its credential directly to the daemon.'
              : 'You need to sign in before Bud can finish this device claim. You will return here automatically after login.'}
          </p>
        </div>

        <div className="mt-8 rounded-2xl border-4 border-black bg-card p-5 shadow-[6px_6px_0px_rgba(0,0,0,1)]">
          {pending && <p className="text-sm font-semibold">Loading claim details...</p>}

          {!pending && flow && (
            <div className="space-y-4">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Device</p>
                <p className="mt-2 text-2xl font-black">{flow.device.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {flow.device.os} / {flow.device.arch}
                  {flow.device.version ? ` / ${flow.device.version}` : ''}
                </p>
              </div>

              <div className="rounded-2xl border-3 border-dashed border-black/70 bg-background/70 p-4">
                <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Status</p>
                <p className="mt-2 text-sm font-semibold">
                  {flow.status === 'pending' && (currentUser ? (approving ? 'Approving device...' : 'Finalizing device claim...') : 'Redirecting to sign-in...')}
                  {flow.status === 'approved' && 'Device approved. Opening Bud...'}
                  {flow.status === 'completed' && 'Device is connected. Opening Bud...'}
                  {flow.status === 'expired' && 'This claim link has expired.'}
                  {flow.status === 'rejected' && 'This claim could not be approved.'}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">Expires at {flow.expires_at}</p>
              </div>

              {!currentUser && flow.status === 'pending' && (
                <a
                  href={buildLoginUrl(`/devices/claim/${flowId}`)}
                  className="inline-flex rounded-2xl border-4 border-black bg-[var(--bud-accent-soft)] px-5 py-3 font-semibold shadow-[6px_6px_0px_rgba(0,0,0,1)]"
                >
                  Continue to sign in
                </a>
              )}

              {(flow.status === 'approved' || flow.status === 'completed') && flow.approved_bud_id && (
                <div className="flex flex-wrap gap-3">
                  <Link
                    to="/$budId"
                    params={{ budId: flow.approved_bud_id }}
                    className="inline-flex rounded-2xl border-4 border-black bg-[var(--bud-accent-soft)] px-5 py-3 font-semibold shadow-[6px_6px_0px_rgba(0,0,0,1)]"
                  >
                    Open Bud
                  </Link>
                  <Link
                    to="/"
                    className="inline-flex rounded-2xl border-4 border-black bg-background px-5 py-3 font-semibold shadow-[6px_6px_0px_rgba(0,0,0,1)]"
                  >
                    Back to app
                  </Link>
                </div>
              )}
            </div>
          )}
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
