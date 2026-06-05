import type { ToolContentRendererProps } from '../types'

export function TerminalSendContent({ payload }: ToolContentRendererProps) {
  const command = typeof payload.command === 'string' ? payload.command : null
  const rawText = typeof payload.raw_text === 'string' ? payload.raw_text : null
  const legacyText = typeof payload.text === 'string' ? payload.text : null
  const legacySubmit = payload.submit === true
  const key =
    typeof payload.key === 'string' && payload.key.length > 0
      ? payload.key
      : Array.isArray(payload.keys) &&
          payload.keys.length === 1 &&
          typeof payload.keys[0] === 'string'
        ? payload.keys[0]
        : null
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
  const inputDispatched =
    typeof payload.input_dispatched === 'boolean'
      ? payload.input_dispatched
      : submitted
  const enterRequested =
    typeof payload.enter_requested === 'boolean'
      ? payload.enter_requested
      : command !== null || legacySubmit
  const contextMode = typeof contextAfter?.mode === 'string' ? contextAfter.mode : null
  const contextProgram =
    typeof contextAfter?.programDisplayName === 'string'
      ? contextAfter.programDisplayName
      : typeof contextAfter?.program === 'string'
        ? contextAfter.program
        : null
  const contextSource = typeof contextAfter?.source === 'string' ? contextAfter.source : null

  if (!command && !rawText && !legacyText && !key && !enterRequested) return null

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
      {command ? (
        <>
          <div className="text-muted-foreground">Command</div>
          <div className="font-mono text-foreground whitespace-pre-wrap">{command}</div>
        </>
      ) : null}
      {rawText ? (
        <>
          <div className="text-muted-foreground">Raw text</div>
          <div className="font-mono text-foreground whitespace-pre-wrap">{rawText}</div>
        </>
      ) : null}
      {!command && !rawText && legacyText ? (
        <>
          <div className="text-muted-foreground">
            {legacySubmit ? 'Legacy command' : 'Legacy raw text'}
          </div>
          <div className="font-mono text-foreground whitespace-pre-wrap">{legacyText}</div>
        </>
      ) : null}
      {key ? (
        <div className="text-muted-foreground">Key: {key}</div>
      ) : null}
      {enterRequested ? <div className="text-muted-foreground">Enter requested</div> : null}
      {inputDispatched !== null ? (
        <div className="mt-1 text-muted-foreground">
          Input dispatched: {inputDispatched ? 'yes' : 'no'}
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
