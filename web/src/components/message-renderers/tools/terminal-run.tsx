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
  const followUpHint = typeof payload.follow_up_hint === 'string' ? payload.follow_up_hint : undefined
  const acceptance = isRecord(payload.acceptance) ? payload.acceptance : null
  const observation = isRecord(payload.observation) ? payload.observation : null
  const state = isRecord(payload.state) ? payload.state : null
  const contextAfter = isRecord(payload.context_after) ? payload.context_after : null
  const status = typeof state?.status === 'string' ? state.status : null
  const nextAction = typeof state?.next_action === 'string' ? state.next_action : null
  const capturedAfterMs =
    typeof observation?.captured_after_ms === 'number' ? observation.captured_after_ms : null
  const screenChanged = observation?.screen_changed === true
  const lastNonEmptyLine =
    typeof observation?.last_non_empty_line === 'string' ? observation.last_non_empty_line : null
  const previewTail = typeof observation?.preview_tail === 'string' ? observation.preview_tail : null
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
        {status ? (
          <span className={statusBadgeClassName(status)}>
            {statusLabel(status)}
          </span>
        ) : null}
        {nextAction ? (
          <span className="rounded-full border border-border bg-background/80 px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            Next: {nextAction}
          </span>
        ) : null}
        {capturedAfterMs !== null ? (
          <span className="rounded-full border border-border bg-background/80 px-2 py-0.5 text-[11px] text-muted-foreground">
            Observed {capturedAfterMs}ms
          </span>
        ) : null}
      </div>
      {text ? <div className="font-mono text-foreground whitespace-pre-wrap">{text}</div> : null}
      {submit ? <div className="text-muted-foreground">Submit: Enter</div> : null}
      {keys.length > 0 ? (
        <div className="text-muted-foreground">Keys: {keys.join(', ')}</div>
      ) : null}
      {acceptance ? (
        <div className="mt-2 text-muted-foreground">
          Acceptance: {formatAcceptance(acceptance.status)}
          {screenChanged ? ' with visible screen change' : ''}
        </div>
      ) : null}
      {contextMode ? (
        <div className="mt-1 text-muted-foreground">
          Context: {contextProgram ? `${contextProgram} (${contextMode})` : contextMode}
          {contextSource ? `, ${contextSource}` : ''}
        </div>
      ) : null}
      {lastNonEmptyLine ? (
        <div className="mt-1 rounded-md bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          Last line: {lastNonEmptyLine}
        </div>
      ) : previewTail ? (
        <div className="mt-1 rounded-md bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          Preview: {previewTail}
        </div>
      ) : null}
      {followUpHint ? (
        <div className="mt-2 border-l-2 border-border/80 pl-2 text-muted-foreground">
          {followUpHint}
        </div>
      ) : null}
    </div>
  )
}

export function TerminalObserveContent({ payload }: ToolContentRendererProps) {
  const lines = payload.lines as number | undefined
  const view = (payload.view as string | undefined) ?? 'screen'
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

function statusLabel(status: string): string {
  switch (status) {
    case 'processing':
      return 'Still processing'
    case 'waiting_for_input':
      return 'Waiting for input'
    case 'ready_at_shell':
      return 'Back at shell'
    case 'ambiguous':
      return 'Needs verification'
    default:
      return status
  }
}

function statusBadgeClassName(status: string): string {
  const base =
    'rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide'

  switch (status) {
    case 'processing':
      return `${base} bg-amber-500/15 text-amber-700 dark:text-amber-300`
    case 'waiting_for_input':
      return `${base} bg-emerald-500/15 text-emerald-700 dark:text-emerald-300`
    case 'ready_at_shell':
      return `${base} bg-sky-500/15 text-sky-700 dark:text-sky-300`
    case 'ambiguous':
      return `${base} bg-rose-500/15 text-rose-700 dark:text-rose-300`
    default:
      return `${base} bg-muted text-foreground`
  }
}

function formatAcceptance(status: unknown): string {
  switch (status) {
    case 'observed_change':
      return 'Observed change'
    case 'no_visible_change':
      return 'No visible change'
    case 'observation_unavailable':
      return 'Observation unavailable'
    default:
      return 'Unknown'
  }
}
