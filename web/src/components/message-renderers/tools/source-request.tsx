import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { apiFetchJson } from '@/lib/transport'
import { phonePermission, sourceRequestClosedLine, sourceRequestPurpose, webAccessSteps, type DataSource, type SourceRequest } from '@/lib/data-sources'
import type { ToolContentRendererProps } from '../types'

type Document = { request: SourceRequest; source?: DataSource }

/**
 * The agent asked for a data source (tool `data_source_request`, bud-mobile
 * `plan/data-sources-ux` Phase 2b). One card: what it is for, one button that turns the source
 * on for the account and the agent, and "Not now". iOS permission is the phone's to ask for, so
 * when it is missing the card says to continue there and completes when the phone reports it.
 * Every change is a click here; the agent can't grant anything.
 */
export function SourceRequestContent({ payload }: ToolContentRendererProps) {
  const given = payload.request && typeof payload.request === 'object' ? payload.request as Record<string, unknown> : payload
  const id = typeof given.request_id === 'string' && /^dsr_[0-9A-HJKMNP-TV-Z]{26}$/.test(given.request_id) ? given.request_id : null
  const [document, setDocument] = useState<Document | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [acted, setActed] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!id) return
    try {
      const next = await apiFetchJson<Document>(`/api/data/source-requests/${id}`, { signal })
      if (!signal?.aborted) { setDocument(next); setMessage('') }
    } catch {
      if (!signal?.aborted) setMessage('Could not load this request.')
    }
  }, [id])
  // The conversation's own record of how the request ended: the tool result, once there is one.
  // Answered on another device or replaced by a message, it arrives here before any reload.
  const outcome = typeof payload.outcome === 'string' ? payload.outcome : null
  const waiting = payload.pending === true
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
    // Reads again when the conversation's record changes.
  }, [load, outcome, waiting])

  // A closed request never offers its actions, even before the reload lands.
  const request = document && outcome && document.request.status === 'pending'
    ? { ...document.request, status: outcome } : document?.request
  const source = document?.source
  const pending = request?.status === 'pending'
  const steps = source ? webAccessSteps(source) : []
  const waitingOnPhone = pending && steps[0] === 'continue_on_phone'
  // The phone reports its permission when the user allows it there.
  useEffect(() => {
    if (!waitingOnPhone) return
    const timer = setInterval(() => { void load() }, 4000)
    return () => clearInterval(timer)
  }, [waitingOnPhone, load])

  const respond = useCallback(async (outcome: 'granted' | 'declined') => {
    if (!id) return
    setBusy(true)
    try {
      const answer = await apiFetchJson<Document>(`/api/data/source-requests/${id}/response`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome }) })
      setDocument(current => ({ ...current, request: answer.request }))
      setMessage('')
    } catch {
      setMessage('That did not go through. Try again.')
      await load()
    } finally { setBusy(false) }
  }, [id, load])
  // After a click here, nothing left to do means the request is granted.
  useEffect(() => {
    // Once: a failed answer leaves the button, it doesn't retry by itself.
    if (acted && pending && source && steps.length === 0 && !busy) { setActed(false); void respond('granted') }
  }, [acted, pending, source, steps.length, busy, respond])

  if (!id) return <p>{typeof payload.summary === 'string' ? payload.summary : 'Data source request unavailable.'}</p>
  if (!request) return <p className="text-muted-foreground">{message || 'Loading…'}</p>
  const label = source?.label ?? request.source
  if (!pending) return <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <span>{sourceRequestClosedLine(request, label)}</span>
    <Link className="underline underline-offset-4" to="/data">Manage</Link>
  </p>

  const allow = async () => {
    setActed(true); setBusy(true)
    try {
      setDocument(await apiFetchJson<Document>(`/api/data/source-requests/${id}/allow`, { method: 'POST' }))
      setMessage('')
    } catch { setMessage('That did not go through. Try again.') }
    finally { setBusy(false) }
  }
  const step = steps[0]
  return <div className="settings-surface space-y-2">
    <p className="font-medium">{label}</p>
    <p>{sourceRequestPurpose(request.purpose)}</p>
    {step === 'turn_on' && <p className="text-muted-foreground">Bud will collect {label.toLowerCase()} from your phone and keep it in your account.
      Your agent, and the model provider it uses, can read it. Change it any time in Data sources.</p>}
    {step === 'continue_on_phone' && <>
      <p className="text-muted-foreground">{label} is on and your agent can read it. iOS still has to allow it: continue on your iPhone, in this conversation.</p>
      {source?.installations.map((phone, index) => <p key={phone.installation_id} className="text-muted-foreground">
        Phone {index + 1}: {phonePermission(request.source, phone)}</p>)}
      {source?.installations.length === 0 && <p className="text-muted-foreground">No phone has reported yet. Open Bud on your iPhone.</p>}
    </>}
    {!step && <p className="text-muted-foreground">{label} is on and your agent can read it.{request.source === 'location' ? ' For a fresh reading, answer from your phone.' : ''}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <button type="button" className="underline underline-offset-4" disabled={busy} onClick={() => void respond('declined')}>Not now</button>
      {step === 'turn_on' && <button type="button" className="settings-action" disabled={busy} onClick={() => void allow()}>Turn on {label}</button>}
      {!step && <button type="button" className="settings-action" disabled={busy} onClick={() => { setActed(true); void respond('granted') }}>Use {label}</button>}
    </div>
    {message && <p role="alert">{message}</p>}
  </div>
}

/**
 * A personal-data read refused for a setting the user can change: a way to change it without
 * the agent asking. It doesn't wake the agent.
 */
export function SourceUnavailableContent({ payload }: ToolContentRendererProps) {
  const source = typeof payload.unavailable_source === 'string' ? payload.unavailable_source : ''
  const label = source ? source[0].toUpperCase() + source.slice(1) : 'this source'
  return <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <span>{typeof payload.summary === 'string' ? payload.summary : `${label} could not be read.`}</span>
    <Link className="underline underline-offset-4" to="/data">Turn on {label}</Link>
  </p>
}
