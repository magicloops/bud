import { resolveToolPayload } from './tool-payload'
import { memo } from 'react'
import { Brain, ChevronRight, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getRoleContentRenderer, getToolContentRenderer } from '@/components/message-renderers'
import { formatWorkDuration } from '@/lib/agent-work-duration'
import { getMessageTiming, getToolName } from '@/lib/agent-message-metadata'
import type { ApiMessage } from '@/lib/api-types'
import type { TimelineWorkRow, TimelineWorkSection } from '@/features/threads/agent-work-projection'
import { isDraftReasoningMessage, isPendingToolMessage } from '@/features/threads/thread-message-state'
import { TRANSCRIPT_COLUMN_CLASSES } from '@/components/workbench/transcript-layout'

/** Live commentary stays visible; activity segments fold at text boundaries. */
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
  const segments: TimelineWorkSection[][] = []
  for (const section of row.sections) {
    if (section.kind === 'intermediate' && !section.message.content.trim()) continue
    const last = segments.at(-1)
    if (section.kind === 'activity' && last?.[0].kind === 'activity') last.push(section)
    else segments.push([section])
  }
  const hasCommentary = segments.some((segment) => segment[0].kind === 'intermediate')
  return (
    <section className="text-sm transition-colors hover:bg-secondary/40">
      <div className={TRANSCRIPT_COLUMN_CLASSES}>
        <div className="border-l-[3px] border-transparent">
          {!row.live && (
            <button type="button" onClick={() => onToggle(row.id)}
              aria-expanded={expanded} aria-controls={bodyId}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left">
              <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', expanded && 'rotate-90')} />
              <SummaryHeaderLabel row={row} />
            </button>
          )}
          {(row.live || expanded) && (
            <div id={bodyId} className="space-y-2 px-4 py-1.5">
              {segments.map((segment, index) => {
                const first = segment[0]
                if (first.kind === 'intermediate') {
                  return <WorkSectionRow key={first.message.client_id} section={first} live={row.live} isCurrent={false} />
                }
                const id = `activity:${first.message.client_id}`
                const activeCount = row.live ? segment.filter(({ message }) =>
                  isPendingToolMessage(message) || isDraftReasoningMessage(message)).length : 0
                const direct = row.live
                  ? index === segments.length - 1 && !row.endsAtAssistant
                  : !hasCommentary
                const open = direct || expandedItems.has(id)
                return (
                  <div key={id}>
                    {!direct && (
                      <button type="button" onClick={() => {
                        if (row.live && !expanded && !expandedItems.has(id)) onToggle(row.id)
                        onToggleItem(id)
                      }}
                        aria-expanded={open} aria-controls={`${id}:body`}
                        className="flex w-full items-center gap-2 py-1.5 text-left text-xs text-muted-foreground">
                        <ChevronRight className={cn('h-3 w-3 transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
                        <SectionCounts sections={segment} />
                        {activeCount > 0 && <span>{activeCount} running</span>}
                      </button>
                    )}
                    {open && (
                      <div id={`${id}:body`} className="space-y-2">
                        {segment.map((section) => (
                          <WorkSectionRow key={section.message.client_id} section={section} live={row.live}
                            isCurrent={row.live && (isPendingToolMessage(section.message) || isDraftReasoningMessage(section.message))} />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export const AgentWorkGroup = memo(AgentWorkGroupComponent)
AgentWorkGroup.displayName = 'AgentWorkGroup'

const SummaryHeaderLabel = ({ row }: { row: TimelineWorkRow }) => (
  <span className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[11px] tracking-wide text-muted-foreground">
    <span className="font-semibold">
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
}

const WorkSectionRow = memo(function WorkSectionRow({ section, live, isCurrent }: WorkSectionRowProps) {
  const { message } = section
  if (section.kind === 'intermediate') {
    const RoleContentRenderer = getRoleContentRenderer('assistant')
    return <div className="py-1">{RoleContentRenderer ? <RoleContentRenderer content={message.content} /> : <p>{message.content}</p>}</div>
  }
  return (
    <div>
      <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{itemKindLabel(message)}</span>
        <span className="truncate">{itemSummary(message)}</span>
        <ItemStatusChip message={message} live={live} isCurrent={isCurrent} />
      </div>
      <div className="mt-1 max-h-96 overflow-auto">
        <WorkItemDetail message={message} isStreaming={live && isCurrent} />
      </div>
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
