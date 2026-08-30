import { memo, useEffect, useMemo, useState } from 'react'
import { Brain, ChevronRight, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getRoleContentRenderer, getToolContentRenderer } from '@/components/message-renderers'
import { formatWorkDuration } from '@/lib/agent-work-duration'
import { getMessageTiming, getToolName } from '@/lib/agent-message-metadata'
import type { ApiMessage } from '@/lib/api-types'
import type { TimelineWorkRow, TimelineWorkSection } from '@/features/threads/agent-work-projection'

/**
 * One turn's agent work (design/web-agent-work-collapse.md, Option B).
 *
 * Live: header reads `Working… · <elapsed> · <current step>`; only the
 * current step renders beneath it — finished steps are already folded in.
 * Done: header reads `Worked for <duration>` (or `Worked`), collapsed by
 * default, failure/cancellation visible as badges. Expanding (allowed while
 * live too) shows the full chronological history: intermediate assistant
 * commentary as separators, activity items as compact headers with
 * per-item detail expansion. Collapsed content is unmounted, not hidden.
 */

type AgentWorkGroupProps = {
  row: TimelineWorkRow
  expanded: boolean
  onToggle: (rowId: string) => void
  expandedItems: ReadonlySet<string>
  onToggleItem: (clientId: string) => void
}

const AgentWorkGroupComponent = ({
  row,
  expanded,
  onToggle,
  expandedItems,
  onToggleItem,
}: AgentWorkGroupProps) => {
  const bodyId = `${row.id}:body`
  const showCurrentItem = row.live && !expanded && row.currentItem !== null

  return (
    <section className="text-sm">
      <button
        type="button"
        onClick={() => onToggle(row.id)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            expanded && 'rotate-90',
          )}
        />
        {row.live ? <LiveHeaderLabel row={row} /> : <SummaryHeaderLabel row={row} />}
      </button>
      {showCurrentItem && row.currentItem && (
        <div className="px-2.5 py-1.5 pl-8">
          <WorkItemDetail message={row.currentItem} isStreaming />
        </div>
      )}
      {expanded && (
        <div id={bodyId} className="space-y-1.5 px-2.5 py-1.5 pl-8">
          {row.sections.map((section) => (
            <WorkSectionRow
              key={section.message.client_id}
              section={section}
              live={row.live}
              isCurrent={section.message === row.currentItem}
              expanded={expandedItems.has(section.message.client_id)}
              onToggleItem={onToggleItem}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export const AgentWorkGroup = memo(AgentWorkGroupComponent)
AgentWorkGroup.displayName = 'AgentWorkGroup'

const LiveHeaderLabel = ({ row }: { row: TimelineWorkRow }) => {
  const startedAtMs = useMemo(() => {
    const first = row.sections[0]?.message
    if (!first) {
      return null
    }
    const metadataStart =
      typeof first.metadata?.started_at === 'string' ? Date.parse(first.metadata.started_at) : NaN
    const parsed = Number.isFinite(metadataStart) ? metadataStart : Date.parse(first.created_at)
    return Number.isFinite(parsed) ? parsed : null
  }, [row.sections])
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  const elapsedLabel = startedAtMs !== null ? formatWorkDuration(Math.max(0, nowMs - startedAtMs)) : null
  const stepLabel = row.currentItem ? describeCurrentStep(row.currentItem) : 'Thinking…'

  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
      <span className="font-semibold text-foreground">Working…</span>
      {elapsedLabel && <span>{elapsedLabel}</span>}
      <span className="truncate normal-case">{stepLabel}</span>
    </span>
  )
}

const SummaryHeaderLabel = ({ row }: { row: TimelineWorkRow }) => (
  <span className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[11px] tracking-wide text-muted-foreground">
    <span className="font-semibold text-foreground">
      {row.durationMs !== null ? `Worked for ${formatWorkDuration(row.durationMs)}` : 'Worked'}
    </span>
    <SectionCounts sections={row.sections} />
    {row.status === 'failed' && <StatusBadge tone="destructive">Failed</StatusBadge>}
    {row.status === 'canceled' && <StatusBadge tone="muted">Canceled</StatusBadge>}
    {row.status === 'no_final' && <StatusBadge tone="muted">Ended early</StatusBadge>}
  </span>
)

const StatusBadge = ({ tone, children }: { tone: 'destructive' | 'muted'; children: string }) => (
  <span
    className={cn(
      'rounded-full px-2 py-0.5 text-[10px] font-semibold',
      tone === 'destructive'
        ? 'bg-red-500/15 text-red-700 dark:text-red-300'
        : 'bg-muted text-muted-foreground',
    )}
  >
    {children}
  </span>
)

type WorkSectionRowProps = {
  section: TimelineWorkSection
  live: boolean
  isCurrent: boolean
  expanded: boolean
  onToggleItem: (clientId: string) => void
}

const WorkSectionRow = memo(function WorkSectionRow({
  section,
  live,
  isCurrent,
  expanded,
  onToggleItem,
}: WorkSectionRowProps) {
  const { message } = section

  if (section.kind === 'intermediate') {
    // Assistant commentary separates activity segments (mobile parity).
    const RoleContentRenderer = getRoleContentRenderer('assistant')
    return (
      <div className="border-l-2 border-border/50 pl-2 text-[13px] text-muted-foreground">
        {RoleContentRenderer ? <RoleContentRenderer content={message.content} /> : <p>{message.content}</p>}
      </div>
    )
  }

  const detailId = `${message.client_id}:detail`
  const showDetail = expanded || (live && isCurrent)
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleItem(message.client_id)}
        aria-expanded={showDetail}
        aria-controls={detailId}
        className="flex w-full items-center gap-2 text-left"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform motion-reduce:transition-none',
            showDetail && 'rotate-90',
          )}
        />
        <span className="flex min-w-0 flex-1 items-baseline gap-2 text-[12px]">
          <span
            className={cn(
              'shrink-0 font-mono text-[10px] uppercase tracking-wide',
              message.role === 'reasoning' ? 'italic text-muted-foreground' : 'text-muted-foreground',
            )}
          >
            {itemKindLabel(message)}
          </span>
          <span className="truncate text-muted-foreground">{itemSummary(message)}</span>
          <ItemStatusChip message={message} live={live} isCurrent={isCurrent} />
        </span>
      </button>
      {showDetail && (
        <div id={detailId} className="mt-1 pl-5">
          <WorkItemDetail message={message} isStreaming={live && isCurrent} />
        </div>
      )}
    </div>
  )
})

const ItemStatusChip = ({
  message,
  live,
  isCurrent,
}: {
  message: ApiMessage
  live: boolean
  isCurrent: boolean
}) => {
  if (live && isCurrent) {
    return <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground/80">running</span>
  }
  const timing = getMessageTiming(message)
  if (!timing) {
    return null
  }
  return (
    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/80">
      {formatWorkDuration(timing.durationMs)}
    </span>
  )
}

/** Full detail via the existing role/tool renderers (also the live current-step surface). */
const WorkItemDetail = ({ message, isStreaming = false }: { message: ApiMessage; isStreaming?: boolean }) => {
  if (message.role === 'tool') {
    const payload = resolveToolPayload(message)
    const ToolContentRenderer = payload?.tool ? getToolContentRenderer(payload.tool as string) : null
    if (ToolContentRenderer && payload) {
      return (
        <div className="text-xs">
          <ToolContentRenderer payload={payload} />
        </div>
      )
    }
    return (
      <pre className="overflow-x-auto rounded-md bg-background/70 p-2 text-[11px] text-muted-foreground">
        <code>{message.content}</code>
      </pre>
    )
  }
  const RoleContentRenderer = getRoleContentRenderer(message.role)
  if (RoleContentRenderer) {
    return <RoleContentRenderer content={message.content} isStreaming={isStreaming} />
  }
  return <p>{message.content}</p>
}

const describeCurrentStep = (message: ApiMessage): string => {
  if (message.role === 'tool') {
    const tool = getToolName(message)
    return tool ? `Running ${tool}` : 'Running a tool'
  }
  if (message.role === 'reasoning') {
    return 'Thinking…'
  }
  return 'Working…'
}

const itemKindLabel = (message: ApiMessage): string => {
  if (message.role === 'tool') {
    return getToolName(message) ?? 'tool'
  }
  return message.role === 'reasoning' ? 'reasoning' : message.role
}

/** First meaningful line with light Markdown decoration stripped (mobile's reasoning-title rule). */
const itemSummary = (message: ApiMessage): string => {
  if (message.role === 'tool') {
    const payload = resolveToolPayload(message)
    const text = payload && typeof payload.text === 'string' ? payload.text : null
    const command = payload && typeof payload.command === 'string' ? payload.command : null
    return text ?? command ?? ''
  }
  const firstLine = message.content.split('\n').find((line) => line.trim().length > 0) ?? ''
  return firstLine.replace(/^[#>*\-`_\s]+/, '').trim()
}

const SectionCounts = ({ sections }: { sections: TimelineWorkSection[] }) => {
  let tools = 0
  let reasoning = 0
  for (const section of sections) {
    if (section.kind !== 'activity') {
      continue
    }
    if (section.message.role === 'tool') {
      tools += 1
    } else if (section.message.role === 'reasoning') {
      reasoning += 1
    }
  }
  if (tools === 0 && reasoning === 0) {
    return null
  }
  return (
    <span className="flex items-center gap-2">
      {tools > 0 && (
        <span
          className="flex items-center gap-1"
          aria-label={`${tools} tool ${tools === 1 ? 'call' : 'calls'}`}
          title={`${tools} tool ${tools === 1 ? 'call' : 'calls'}`}
        >
          <Wrench aria-hidden className="h-3 w-3" />
          {tools}
        </span>
      )}
      {reasoning > 0 && (
        <span
          className="flex items-center gap-1"
          aria-label={`${reasoning} reasoning ${reasoning === 1 ? 'step' : 'steps'}`}
          title={`${reasoning} reasoning ${reasoning === 1 ? 'step' : 'steps'}`}
        >
          <Brain aria-hidden className="h-3 w-3" />
          {reasoning}
        </span>
      )}
    </span>
  )
}

// Same resolution the timeline row uses: canonical tool rows keep the payload
// in metadata; drafts and legacy rows fall back to the JSON content.
const resolveToolPayload = (message: ApiMessage): Record<string, unknown> | null => {
  if (message.metadata && typeof message.metadata === 'object') {
    return message.metadata
  }
  try {
    const parsed = JSON.parse(message.content)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
