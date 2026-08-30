import type { ToolContentRendererProps } from '../types'

function modeChip(payload: Record<string, unknown>) {
  const mode = typeof payload.mode === 'string' ? payload.mode : null
  const altScreen = payload.alt_screen === true
  if (!mode) return null
  return (
    <span className="rounded-full border border-border bg-background/80 px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
      {mode}
      {altScreen ? ' · alt-screen' : ''}
    </span>
  )
}

/** proto 0.3 `terminal.run`: a shell command with a real exit code. */
export function TerminalRunContent({ payload }: ToolContentRendererProps) {
  const command = typeof payload.command === 'string' ? payload.command : null
  const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : null
  const durationMs = typeof payload.duration_ms === 'number' ? payload.duration_ms : null
  const output = typeof payload.output === 'string' && payload.output.length > 0 ? payload.output : null
  const truncated = payload.truncated === true
  const stillRunning = payload.status === 'still_running'
  const interactive = payload.status === 'interactive'
  // Launch proof (interactive/input_absorbed): what the program painted.
  const delta = isRecord(payload.delta) ? payload.delta : null
  const deltaText = typeof delta?.text === 'string' && delta.text.length > 0 ? delta.text : null

  if (!command) return null

  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] leading-relaxed">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {interactive ? (
          <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300">
            Interactive
          </span>
        ) : null}
        {stillRunning ? (
          <span className="rounded-full bg-yellow-500/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-yellow-700 dark:text-yellow-300">
            Still running
          </span>
        ) : exitCode !== null ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
              exitCode === 0
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : 'bg-red-500/15 text-red-700 dark:text-red-300'
            }`}
          >
            Exit {exitCode}
          </span>
        ) : null}
        {durationMs !== null ? (
          <span className="rounded-full border border-border bg-background/80 px-2 py-0.5 text-[11px] text-muted-foreground">
            {durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`}
          </span>
        ) : null}
        {modeChip(payload)}
      </div>
      <div className="text-muted-foreground">Command</div>
      <div className="font-mono text-foreground whitespace-pre-wrap">{command}</div>
      {output ? (
        <div className="mt-1 max-h-64 overflow-y-auto rounded-md bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap">
          {output}
        </div>
      ) : null}
      {deltaText ? (
        <div className="mt-1 max-h-64 overflow-y-auto rounded-md bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/80">Screen</div>
          <div className="whitespace-pre-wrap">{deltaText}</div>
        </div>
      ) : null}
      {truncated ? (
        <div className="mt-1 text-muted-foreground">Output truncated (showing the tail).</div>
      ) : null}
    </div>
  )
}

/**
 * `terminal.send` — the single terminal input tool. Two result shapes chosen
 * by the daemon: `kind:"command"` (the text ran as a shell command: exit
 * code, duration, output — rendered like the retired terminal.run) and
 * `kind:"interaction_ack"` (input into a program: settled-delta proof).
 * Historical rows carry `raw_text` (pre-unification) or `command`/`text`.
 */
export function TerminalSendContent({ payload }: ToolContentRendererProps) {
  if (payload.kind === 'command') {
    return <TerminalRunContent payload={{ ...payload, command: payload.text ?? payload.command }} />
  }
  const rawText =
    typeof payload.text === 'string'
      ? payload.text
      : typeof payload.raw_text === 'string'
        ? payload.raw_text
        : null
  const key = typeof payload.key === 'string' && payload.key.length > 0 ? payload.key : null
  // Legacy 0.2 rows (command / text+submit) keep rendering in old transcripts.
  const legacyCommand = typeof payload.command === 'string' ? payload.command : null
  const legacyText = null
  const delta = isRecord(payload.delta) ? payload.delta : null
  const deltaText = typeof delta?.text === 'string' && delta.text.length > 0 ? delta.text : null
  const changed = payload.changed === true || delta?.changed === true
  const dispatched =
    typeof payload.dispatched === 'boolean'
      ? payload.dispatched
      : typeof payload.input_dispatched === 'boolean'
        ? payload.input_dispatched
        : null

  if (!rawText && !key && !legacyCommand && !legacyText) return null

  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] leading-relaxed">
      <div className="mb-2 flex flex-wrap gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
            changed
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
              : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
          }`}
        >
          {changed ? 'Visible delta' : 'No visible delta'}
        </span>
        {modeChip(payload)}
      </div>
      {rawText ?? legacyText ? (
        <>
          <div className="text-muted-foreground">Text</div>
          <div className="font-mono text-foreground whitespace-pre-wrap">{rawText ?? legacyText}</div>
        </>
      ) : null}
      {legacyCommand ? (
        <>
          <div className="text-muted-foreground">Legacy command</div>
          <div className="font-mono text-foreground whitespace-pre-wrap">{legacyCommand}</div>
        </>
      ) : null}
      {key ? <div className="text-muted-foreground">Key: {key}</div> : null}
      {dispatched !== null ? (
        <div className="mt-1 text-muted-foreground">Input dispatched: {dispatched ? 'yes' : 'no'}</div>
      ) : null}
      {deltaText ? (
        <div className="mt-1 rounded-md bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/80">Delta</div>
          <div className="whitespace-pre-wrap">{deltaText}</div>
        </div>
      ) : null}
    </div>
  )
}

export function TerminalObserveContent({ payload }: ToolContentRendererProps) {
  const lines = payload.lines as number | undefined
  const view = (payload.view as string | undefined) ?? 'delta'

  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
      <span>
        Observed {view}
        {typeof lines === 'number' ? ` (${lines} lines)` : ''}
      </span>
      <span className="ml-2 inline-flex">{modeChip(payload)}</span>
    </div>
  )
}

const WAIT_OUTCOME_LABELS: Record<string, string> = {
  settled: 'terminal settled',
  stalled: 'output stopped changing',
  no_activity: 'no activity — program looks idle',
  command_finished: 'command finished',
  prompt_ready: 'back at the prompt',
  idle: 'nothing to wait for',
  closed: 'session closed',
  timeout: 'still busy (budget expired)',
  interrupted: 'interrupted',
  superseded: 'ended by a new message',
}

function formatWaited(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
}

/** `terminal.wait`: the agent parked until a terminal fact; show what it waited for and how long. */
export function TerminalWaitContent({ payload }: ToolContentRendererProps) {
  const outcome = typeof payload.outcome === 'string' ? payload.outcome : null
  const waitedMs = typeof payload.waited_ms === 'number' ? payload.waited_ms : null
  const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : null
  const label = outcome ? (WAIT_OUTCOME_LABELS[outcome] ?? outcome) : 'waiting'

  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
      <span>
        Waited{waitedMs !== null ? ` ${formatWaited(waitedMs)}` : ''}: {label}
        {exitCode !== null ? ` (exit ${exitCode})` : ''}
      </span>
      <span className="ml-2 inline-flex">{modeChip(payload)}</span>
    </div>
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}
