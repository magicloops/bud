import { resolveToolPayload } from './tool-payload'
import { memo } from 'react'
import { Cpu, ChevronRight, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getRoleContentRenderer, getToolContentRenderer } from '@/components/message-renderers'
import { formatWorkDuration } from '@/lib/agent-work-duration'
import { getMessageTiming, getToolName } from '@/lib/agent-message-metadata'
import type { ApiMessage } from '@/lib/api-types'
import { workSegments, type TimelineWorkRow, type TimelineWorkSection } from '@/features/threads/agent-work-projection'
import { isDraftReasoningMessage, isPendingToolMessage } from '@/features/threads/thread-message-state'
import { TRANSCRIPT_COLUMN_CLASSES } from '@/components/workbench/transcript-layout'

type DisclosureProps = {
  expandedItems: ReadonlySet<string>
  onToggleItem: (id: string) => void
}
export const ActivitySection = memo(function ActivitySection({ sections, live, expandedItems, onToggleItem, direct = false }: DisclosureProps & {
  sections: TimelineWorkSection[]; live: boolean; direct?: boolean
}) {
  const id = sections[0].sectionId ?? `activity:${sections[0].message.client_id}`
  const latest = sections[sections.length - 1].message
  const open = direct || expandedItems.has(id)
  const active = live ? sections.filter(({ message }) => isPendingToolMessage(message) || isDraftReasoningMessage(message)).length : 0
  const failed = sections.filter(({ message }) => message.metadata?.outcome === 'failed' || message.metadata?.status === 'failed').length
  const tools = sections.filter(({ message }) => message.role === 'tool').length
  const reasoning = sections.filter(({ message }) => message.role === 'reasoning').length
  const summary = [
    reasoning > 0 ? `${reasoning} reasoning ${reasoning === 1 ? 'step' : 'steps'}` : null,
    tools > 0 ? `${tools} tool ${tools === 1 ? 'call' : 'calls'}` : null,
  ].filter(Boolean).join(' and ')
  return <div data-activity-section={id}>
    {!direct && <button type="button" aria-expanded={open} aria-controls={`${id}:body`}
      onClick={() => onToggleItem(id)} className="flex w-full min-w-0 items-center gap-2 py-1.5 text-left text-xs text-muted-foreground">
      <ChevronRight aria-hidden className={cn('h-3 w-3 shrink-0', open && 'rotate-90')} />
      {(live ? latest.role === 'reasoning' : tools === 0) ? <Cpu aria-hidden className="h-3 w-3 shrink-0" /> : <Wrench aria-hidden className="h-3 w-3 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{live ? itemSummary(latest) || itemKindLabel(latest) : summary}</span>
      {live && <span className="shrink-0 tabular-nums" aria-label={`${sections.length} activities`}>{sections.length}</span>}
      {active > 0 && <span className="shrink-0">{active} running</span>}
      {failed > 0 && <span className="shrink-0 text-destructive">{failed} failed</span>}
    </button>}
    {open && <div id={`${id}:body`} className="space-y-2">
      {sections.map(section => <CompactWorkItem key={section.message.client_id} message={section.message}
        live={live} expanded={expandedItems.has(`item:${section.message.client_id}`)} onToggleItem={onToggleItem} />)}
    </div>}
  </div>
}, (previous, next) => {
  if (previous.live !== next.live || previous.direct !== next.direct || previous.onToggleItem !== next.onToggleItem || previous.sections.length !== next.sections.length) return false
  const sectionId = next.sections[0].sectionId ?? `activity:${next.sections[0].message.client_id}`
  if (previous.expandedItems.has(sectionId) !== next.expandedItems.has(sectionId)) return false
  return previous.sections.every((section, index) => section.message === next.sections[index].message &&
    previous.expandedItems.has(`item:${section.message.client_id}`) === next.expandedItems.has(`item:${section.message.client_id}`))
})

const CompactWorkItem = memo(function CompactWorkItem({ message, live, expanded, onToggleItem }: {
  message: ApiMessage; live: boolean; expanded: boolean; onToggleItem: (id: string) => void
}) {
  const id = `item:${message.client_id}`
  const active = live && (isPendingToolMessage(message) || isDraftReasoningMessage(message))
  return <div>
    <button type="button" aria-expanded={expanded} aria-controls={`${id}:body`} onClick={() => onToggleItem(id)}
      className="flex w-full min-w-0 items-center gap-2 py-1 text-left text-xs text-muted-foreground">
      <ChevronRight aria-hidden className={cn('h-3 w-3 shrink-0', expanded && 'rotate-90')} />
      <span className="min-w-0 flex-1 truncate">{itemSummary(message) || itemKindLabel(message)}</span>
      <ItemStatusChip message={message} live={live} isCurrent={active} />
    </button>
    {expanded && <div id={`${id}:body`} className="mt-1 max-h-96 overflow-auto" data-work-detail>
      <WorkItemDetail message={message} isStreaming={active} />
    </div>}
  </div>
})

export const AgentWorkGroup = memo(function AgentWorkGroup({ row, expanded, onToggle, expandedItems, onToggleItem }: DisclosureProps & {
  row: TimelineWorkRow; expanded: boolean; onToggle: (id: string) => void
}) {
  const segments = workSegments(row)
  const commentary = segments.some(s => s[0].kind === 'intermediate')
  const Renderer = getRoleContentRenderer('assistant')
  return <section data-work-group={row.id} className={cn(
    'text-sm transition-colors hover:bg-secondary/40',
    row.canFold && expanded && 'bg-secondary/40',
  )}>
    <div className={TRANSCRIPT_COLUMN_CLASSES}><div className="border-l-[3px] border-transparent px-4 py-1.5">
      {row.canFold && <button id={`${row.id}:toggle`} type="button" onClick={() => onToggle(row.id)} aria-expanded={expanded} aria-controls={`${row.id}:body`}
        className="flex w-full items-center gap-2 text-left text-xs text-muted-foreground">
        <ChevronRight aria-hidden className={cn('h-3.5 w-3.5', expanded && 'rotate-90')} />
        <span className={expanded ? 'not-italic' : 'italic'}>{row.durationMs !== null ? `Worked for ${formatWorkDuration(row.durationMs)}` : 'Worked'}</span>
        <SectionCounts sections={row.sections} />
        {row.status !== 'ok' && <span>{row.status === 'no_final' ? 'Ended early' : row.status}</span>}
      </button>}
      {(!row.canFold || expanded) && <div id={`${row.id}:body`} className={cn("space-y-2", row.canFold && "pt-2")}>
        {segments.map(segment => segment[0].kind === 'intermediate'
          ? <div key={segment[0].message.client_id} className="min-h-[1lh]">{Renderer ? <Renderer content={segment[0].message.content} /> : segment[0].message.content}</div>
          : <ActivitySection key={segment[0].message.client_id} sections={segment} live={row.live}
              direct={row.canFold && !commentary} expandedItems={expandedItems} onToggleItem={onToggleItem} />)}
      </div>}
    </div></div>
  </section>
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
  const outcome = message.metadata?.outcome ?? message.metadata?.status
  if (outcome === 'failed' || outcome === 'canceled') {
    return <span className="shrink-0 text-destructive">{outcome}</span>
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

/** Full detail mounts only after explicit item expansion. */
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
const summaryCache = new WeakMap<ApiMessage, string>()
const itemSummary = (message: ApiMessage): string => {
  const cached = summaryCache.get(message)
  if (cached !== undefined) return cached
  const summary = computeItemSummary(message)
  summaryCache.set(message, summary)
  return summary
}
const computeItemSummary = (message: ApiMessage): string => {
  if (message.role === 'tool') {
    const payload = message.metadata ?? null
    const text = payload && typeof payload.text === 'string' ? payload.text : null
    const command = payload && typeof payload.command === 'string' ? payload.command : null
    const raw = payload && typeof payload.raw_text === 'string' ? payload.raw_text : null
    const key = payload && typeof payload.key === 'string' ? payload.key : null
    return command ?? raw ?? (key ? `Press ${key}` : text) ?? (typeof payload?.tool === 'string' ? payload.tool : message.display_role) ?? 'Tool'
  }
  const firstLine = message.content.split('\n').find((line) => line.trim().length > 0) ?? ''
  return firstLine
    .replace(/^[#>*\-`_\s]+/, '')
    .replace(/[*_`]+\s*$/, '')
    .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, '$2')
    .trim()
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
          <Cpu aria-hidden className="h-3 w-3" />
          {reasoning}
        </span>
      )}
    </span>
  )
}
