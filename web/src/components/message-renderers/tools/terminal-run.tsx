import type { ToolContentRendererProps } from '../types'

/**
 * Renders terminal tool payloads for the revised exec/send/observe contract.
 */
export function TerminalExecContent({ payload }: ToolContentRendererProps) {
  const command = (payload.command as string | undefined)?.trim()

  if (!command) return null

  return (
    <div className="rounded-md bg-black/90 px-3 py-2 font-mono text-[12px] leading-relaxed">
      <span className="select-none text-green-600/70">$ </span>
      <span className="whitespace-pre-wrap text-green-400">{command}</span>
    </div>
  )
}

export function TerminalSendContent({ payload }: ToolContentRendererProps) {
  const text = payload.text as string | undefined
  const submit = payload.submit === true
  const keys = Array.isArray(payload.keys) ? payload.keys.filter((value): value is string => typeof value === 'string') : []
  const delta = isRecord(payload.delta) ? payload.delta : null
  const readiness = isRecord(payload.readiness) ? payload.readiness : null
  const contextAfter = isRecord(payload.context_after) ? payload.context_after : null
  const deltaChanged = delta?.changed === true
  const deltaText = typeof delta?.text === 'string' && delta.text.length > 0 ? delta.text : null
  const deltaTruncated = delta?.truncated === true
  const readinessReady = readiness?.ready === true
  const readinessConfidence =
    typeof readiness?.confidence === 'number' ? readiness.confidence : null
  const readinessTrigger = typeof readiness?.trigger === 'string' ? readiness.trigger : null
  const submitted = typeof payload.submitted === 'boolean' ? payload.submitted : null
  const contextMode = typeof contextAfter?.mode === 'string' ? contextAfter.mode : null
  const contextProgram =
    typeof contextAfter?.programDisplayName === 'string'
      ? contextAfter.programDisplayName
      : typeof contextAfter?.program === 'string'
        ? contextAfter.program
        : null
  const contextSource = typeof contextAfter?.source === 'string' ? contextAfter.source : null

  if (!text && !submit && keys.length === 0) return null

  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] leading-relaxed">
      <div className="mb-2 flex flex-wrap gap-2">
        <span className={deltaBadgeClassName(deltaChanged)}>
          {deltaChanged ? 'Visible delta' : 'No visible delta'}
        </span>
        {readinessConfidence !== null ? (
          <span className="rounded-full border border-border bg-background/80 px-2 py-0.5 text-[11px] text-muted-foreground">
            {readinessReady ? 'Ready' : 'Not ready'} {Math.round(readinessConfidence * 100)}%
          </span>
        ) : null}
        {readinessTrigger ? (
          <span className="rounded-full border border-border bg-background/80 px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            {readinessTrigger}
          </span>
        ) : null}
      </div>
      {text ? <div className="font-mono text-foreground whitespace-pre-wrap">{text}</div> : null}
      {submit ? <div className="text-muted-foreground">Submit: Enter</div> : null}
      {keys.length > 0 ? (
        <div className="text-muted-foreground">Keys: {keys.join(', ')}</div>
      ) : null}
      {submitted !== null ? (
        <div className="mt-1 text-muted-foreground">
          Submitted: {submitted ? 'yes' : 'no'}
        </div>
      ) : null}
      {contextMode ? (
        <div className="mt-1 text-muted-foreground">
          Context: {contextProgram ? `${contextProgram} (${contextMode})` : contextMode}
          {contextSource ? `, ${contextSource}` : ''}
        </div>
      ) : null}
      {deltaText ? (
        <div className="mt-1 rounded-md bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/80">
            Delta
          </div>
          <div className="whitespace-pre-wrap">{deltaText}</div>
        </div>
      ) : null}
      {deltaTruncated ? (
        <div className="mt-1 text-muted-foreground">Delta was truncated.</div>
      ) : null}
    </div>
  )
}

export function TerminalObserveContent({ payload }: ToolContentRendererProps) {
  const lines = payload.lines as number | undefined
  const view = (payload.view as string | undefined) ?? 'delta'
  const waitFor = typeof payload.wait_for === 'string' ? payload.wait_for : null

  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
      Observed {view}
      {typeof lines === 'number' ? ` (${lines} lines)` : ''}
      {waitFor && waitFor !== 'none' ? ` after waiting for ${waitFor}` : ''}
    </div>
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function deltaBadgeClassName(changed: boolean): string {
  const base =
    'rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide'

  return changed
    ? `${base} bg-emerald-500/15 text-emerald-700 dark:text-emerald-300`
    : `${base} bg-amber-500/15 text-amber-700 dark:text-amber-300`
}
