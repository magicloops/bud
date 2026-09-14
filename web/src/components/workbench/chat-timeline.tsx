import { resolveToolPayload } from './tool-payload'
import { Link } from '@tanstack/react-router'
import { memo, type MutableRefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { config } from '@/lib/config'
import { automationAttribution } from './automation-attribution'
import { getToolContentRenderer, getRoleContentRenderer } from '@/components/message-renderers'
import {
  ThinkingIndicator,
} from '@/components/workbench/thinking-indicator'
import type {
  ApiAskUserQuestionsRequest,
  ApiAskUserQuestionsResponseInput,
  ApiAgentCompactionPhase,
  ApiMessage,
} from '@/lib/api-types'
import {
  toOpenFileCandidate,
  type FilePathCandidate,
  type OpenFileCandidate,
  type OpenFileSource,
} from '@/lib/file-paths'
import { QuestionRequestCard } from '@/components/workbench/question-request-card'
import { useAuthSession } from '@/contexts/auth-session-context'
import { isFinalAssistantMessage } from '@/features/threads/assistant-activity-indicator-state'
import { formatRelativeTimestamp } from '@/lib/relative-time.ts'
import { TRANSCRIPT_COLUMN_CLASSES } from '@/components/workbench/transcript-layout'
import { useTranscriptViewport } from './use-transcript-viewport'
import { AgentWorkGroup, ActivitySection } from '@/components/workbench/agent-work-group'
import { getRoleContentRenderer as getRoleRenderer } from '@/components/message-renderers'
import {
  formatCompactTokens,
  formatCompactionPhase,
  getCompactionRowPresentation,
} from '@/features/threads/compaction-row-state'
import {
  createTimelineProjector,
  workSegments,
  type TimelineRow,
  type TurnOutcome,
} from '@/features/threads/agent-work-projection'

type JsonViewComponent = typeof import('@microlink/react-json-view').default

export type ChatMessage = Pick<
  ApiMessage,
  'message_id' | 'client_id' | 'role' | 'display_role' | 'content' | 'created_at' | 'metadata'
>

export type ChatTimelineNotice = {
  notice_id: string
  kind: 'context_compaction'
  status: 'completed' | 'failed'
  created_at: string
  phase: ApiAgentCompactionPhase
  tokens_before: number | null
  tokens_after?: number | null
  error_code?: string | null
}

// Older pages load automatically as the user scrolls up: a sentinel above
// the first row is observed against the scroll container, and this margin
// starts the fetch before the user actually reaches the top.
const OLDER_MESSAGES_PREFETCH_PX = 600

let jsonViewComponentPromise: Promise<JsonViewComponent> | null = null

function loadJsonViewComponent() {
  if (!jsonViewComponentPromise) {
    jsonViewComponentPromise = import('@microlink/react-json-view')
      .then((module) => module.default)
      .catch((error) => {
        jsonViewComponentPromise = null
        throw error
      })
  }

  return jsonViewComponentPromise
}

type ChatTimelineProps = {
  messages: ChatMessage[]
  notices?: ChatTimelineNotice[]
  /** The active run's turn id (`agentState.active ? turn_id : null`); keeps its work group live. */
  liveTurnId?: string | null
  /** Session-local `final`-event outcomes for failed/canceled badges. */
  turnOutcomes?: ReadonlyMap<string, TurnOutcome>
  responseActive?: boolean
  activityIndicatorVisible?: boolean
  activityIndicatorWorkStarted?: boolean
  activityIndicatorLabel?: string
  hasOlderMessages?: boolean
  isLoadingOlderMessages?: boolean
  /** Last older-page fetch failed: pause auto-loading and offer a retry. */
  olderMessagesLoadFailed?: boolean
  onLoadOlderMessages?: (() => void) | null
  scrollContainerRef?: MutableRefObject<HTMLDivElement | null>
  onOpenFile?: (candidate: OpenFileCandidate) => void
  onSubmitQuestionResponse?: (
    request: ApiAskUserQuestionsRequest,
    response: ApiAskUserQuestionsResponseInput,
  ) => Promise<void> | void
  questionSubmitError?: string | null
}

const ChatTimelineComponent = ({
  messages,
  notices = [],
  liveTurnId = null,
  turnOutcomes,
  activityIndicatorVisible = false,
  activityIndicatorWorkStarted = false,
  responseActive = activityIndicatorVisible,
  activityIndicatorLabel,
  hasOlderMessages = false,
  isLoadingOlderMessages = false,
  olderMessagesLoadFailed = false,
  onLoadOlderMessages = null,
  scrollContainerRef,
  onOpenFile,
  onSubmitQuestionResponse,
  questionSubmitError = null,
}: ChatTimelineProps) => {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const olderSentinelRef = useRef<HTMLDivElement | null>(null)
  const [JsonView, setJsonView] = useState<JsonViewComponent | null>(null)
  const { currentUser } = useAuthSession()
  // User rows label with the viewer's first name, falling back to their
  // chosen username, then the generic role.
  const userName =
    currentUser?.user.name.trim().split(/\s+/)[0] || currentUser?.profile.username || null

  const setScrollNode = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node
      if (scrollContainerRef) {
        scrollContainerRef.current = node
      }
    },
    [scrollContainerRef],
  )

  const visibleMessages = useMemo(
    () => (config.showSystemMessages ? messages : messages.filter((message) => message.role !== 'system' || automationAttribution(message) !== null)),
    [messages],
  )

  // Agent-work projection (design/web-agent-work-collapse.md): one stable
  // projector instance so unchanged rows keep object identity across renders.
  const projectorRef = useRef(createTimelineProjector())
  const timelineRows = useMemo(
    () =>
      projectorRef.current({
        messages: visibleMessages,
        liveTurnId,
        ...(turnOutcomes ? { turnOutcomes } : {}),
      }),
    [liveTurnId, turnOutcomes, visibleMessages],
  )

  // Expansion state is ephemeral presentation state keyed by stable
  // projection ids (turn ULIDs are globally unique, so no cross-thread
  // collisions; never persisted).
  const [expandedWork, setExpandedWork] = useState<ReadonlySet<string>>(new Set())
  const [expandedItems, setExpandedItems] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const validWork = new Set<string>()
    const validItems = new Set<string>()
    for (const row of timelineRows) if (row.kind === 'work') {
      validWork.add(row.id)
      for (const section of row.sections) {
        validItems.add(`item:${section.message.client_id}`)
        if (section.sectionId) validItems.add(section.sectionId)
      }
    }
    const prune = (current: ReadonlySet<string>, valid: Set<string>) =>
      [...current].every(id => valid.has(id)) ? current : new Set([...current].filter(id => valid.has(id)))
    setExpandedWork(current => prune(current, validWork))
    setExpandedItems(current => prune(current, validItems))
  }, [timelineRows])
  const focusedWork = useRef<{ element: HTMLElement; owner: string } | null>(null)
  useLayoutEffect(() => {
    const focused = focusedWork.current
    if (focused && !focused.element.isConnected) {
      const button = document.getElementById(`${focused.owner}:toggle`)
      button?.focus({ preventScroll: true })
      focusedWork.current = null
    }
  }, [timelineRows])
  const toggleWorkRow = useCallback((rowId: string) => {
    setExpandedWork((current) => {
      const next = new Set(current)
      if (next.has(rowId)) {
        next.delete(rowId)
      } else {
        next.add(rowId)
      }
      return next
    })
  }, [])
  const toggleWorkItem = useCallback((clientId: string) => {
    setExpandedItems((current) => {
      const next = new Set(current)
      if (next.has(clientId)) {
        next.delete(clientId)
      } else {
        next.add(clientId)
      }
      return next
    })
  }, [])

  const timelineItems = useMemo(() => {
    const rowTime = (row: TimelineRow) =>
      row.kind === 'message'
        ? row.message.created_at
        : row.sections[0]?.message.created_at ?? ''
    const items: Array<
      | { type: 'row'; row: TimelineRow }
      | { type: 'notice'; notice: ChatTimelineNotice }
    > = [
      ...timelineRows.map((row) => ({ type: 'row' as const, row })),
      ...notices.map((notice) => ({ type: 'notice' as const, notice })),
    ]
    items.sort((a, b) => {
      const aTime = new Date(a.type === 'row' ? rowTime(a.row) : a.notice.created_at).getTime()
      const bTime = new Date(b.type === 'row' ? rowTime(b.row) : b.notice.created_at).getTime()
      return aTime - bTime
    })
    return items
  }, [notices, timelineRows])

  const optimisticSend = [...messages].reverse().find(message => message.role === 'user' && message.metadata?.optimistic === true)?.client_id ?? null
  const { inspect: inspectViewport, jump, showJump } = useTranscriptViewport(scrollRef, optimisticSend)
  const handoff = useRef<{ height: number; width: number; folds: number } | null>(null)
  const foldCount = timelineRows.filter(row => row.kind === 'work' && row.canFold).length
  const inspect = useCallback(() => {
    handoff.current = null
    const content = scrollRef.current?.firstElementChild as HTMLElement | null
    if (content) content.style.minHeight = ''
    inspectViewport()
  }, [inspectViewport])
  // Keep the former response line only until natural content consumes its space.
  // This is a layout floor, not a second spinner-sized sibling or a render gate.
  useLayoutEffect(() => {
    const node = scrollRef.current
    const content = node?.firstElementChild as HTMLElement | null
    if (!node || !content || !node.clientHeight) return
    if (activityIndicatorVisible) {
      content.style.minHeight = ''
      handoff.current = { height: content.getBoundingClientRect().height, width: node.clientWidth, folds: foldCount }
    } else if (responseActive && handoff.current?.width === node.clientWidth && handoff.current.folds === foldCount) {
      content.style.minHeight = `${handoff.current.height}px`
    } else {
      content.style.minHeight = ''
      handoff.current = null
    }
  }, [activityIndicatorVisible, responseActive, foldCount, messages])

  const ensureJsonViewLoaded = useCallback(() => {
    if (JsonView) {
      return
    }

    void loadJsonViewComponent()
      .then((component) => {
        setJsonView(() => component)
      })
      .catch((error) => {
        console.error('Failed to load JSON payload viewer', error)
      })
  }, [JsonView])

  // Infinite scroll upward. The observer is (re)created whenever a load
  // finishes, and a fresh observer reports the current intersection right
  // away — so if the sentinel is still within range after a prepend (short
  // page, tall viewport) the next page loads without further scrolling.
  // Paused while loading, after a failure (retry button instead), and once
  // there is nothing older.
  useEffect(() => {
    const root = scrollRef.current
    const target = olderSentinelRef.current
    if (
      !root ||
      !target ||
      !onLoadOlderMessages ||
      !hasOlderMessages ||
      isLoadingOlderMessages ||
      olderMessagesLoadFailed ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadOlderMessages()
        }
      },
      { root, rootMargin: `${OLDER_MESSAGES_PREFETCH_PX}px 0px 0px 0px` },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [hasOlderMessages, isLoadingOlderMessages, olderMessagesLoadFailed, onLoadOlderMessages])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={setScrollNode} className="@container min-h-0 flex-1 overflow-y-auto bg-background"
      onClickCapture={event => {
        if ((event.target as Element).closest('button[aria-expanded], summary')) inspect()
      }}
      onFocusCapture={event => {
        const element = event.target as HTMLElement
        const owner = element.closest<HTMLElement>('[data-work-owner]')?.dataset.workOwner
        focusedWork.current = owner ? { element, owner } : null
      }}>
      {/* Rows are full-bleed (hover highlights span the pane); each row
          constrains its own content via TRANSCRIPT_COLUMN_CLASSES. */}
      <div className="py-2">
      {onLoadOlderMessages && hasOlderMessages && (
        <div
          ref={olderSentinelRef}
          aria-live="polite"
          className={cn(
            'flex justify-center',
            isLoadingOlderMessages || olderMessagesLoadFailed ? 'pt-3 pb-2' : 'h-px',
          )}
        >
          {isLoadingOlderMessages ? (
            <span className="rounded-full border border-border bg-card px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Loading older messages…
            </span>
          ) : olderMessagesLoadFailed ? (
            <button
              type="button"
              onClick={onLoadOlderMessages}
              className="rounded-full border border-border bg-card px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
            >
              Couldn't load older messages — retry
            </button>
          ) : null}
        </div>
      )}
      {timelineItems.length === 0 && (
        <p className="px-4 py-3 text-sm text-muted-foreground">No messages yet. Share a task to start the loop.</p>
      )}
      {timelineItems.flatMap((item) => {
        if (item.type === 'notice') {
          return <ChatTimelineNoticeRow key={item.notice.notice_id} notice={item.notice} />
        }
        if (item.row.kind === 'work') {
          if (!item.row.canFold) {
            const work = item.row
            return workSegments(work).map(segment => segment[0].kind === 'intermediate'
              ? <ChatTimelineMessage key={segment[0].message.client_id} message={segment[0].message}
                  userName={userName} JsonView={JsonView} ensureJsonViewLoaded={ensureJsonViewLoaded} workOwner={work.id} />
              : <div data-work-owner={work.id} key={segment[0].sectionId ?? `activity:${segment[0].message.client_id}`} className={TRANSCRIPT_COLUMN_CLASSES}>
                  <div className="border-l-[3px] border-transparent px-4 py-1.5">
                    <ActivitySection sections={segment} live={work.live} expandedItems={expandedItems} onToggleItem={toggleWorkItem} />
                  </div>
                </div>)
          }
          return (
            <AgentWorkGroup
              key={item.row.id}
              row={item.row}
              expanded={expandedWork.has(item.row.id)}
              onToggle={toggleWorkRow}
              expandedItems={expandedItems}
              onToggleItem={toggleWorkItem}
            />
          )
        }
        return (
          <ChatTimelineMessage
            key={item.row.message.client_id}
            message={item.row.message}
            userName={userName}
            JsonView={JsonView}
            ensureJsonViewLoaded={ensureJsonViewLoaded}
            onOpenFile={onOpenFile}
            onSubmitQuestionResponse={onSubmitQuestionResponse}
            questionSubmitError={questionSubmitError}
          />
        )
      })}
      <div className={TRANSCRIPT_COLUMN_CLASSES}><ThinkingIndicator
        isVisible={activityIndicatorVisible}
        workStarted={activityIndicatorWorkStarted}
        label={activityIndicatorLabel}
      /></div>
      </div>
    </div>
    {showJump && <button type="button" onClick={jump} className="absolute bottom-3 right-4 rounded-full border bg-background px-3 py-1.5 text-xs shadow-sm">Jump to latest</button>}
    </div>
  )
}

export const ChatTimeline = memo(ChatTimelineComponent)
ChatTimeline.displayName = 'ChatTimeline'

/**
 * Hover-revealed timestamp: relative ("3 hours ago") by default, clicking
 * toggles the absolute date and time.
 */
const MessageTimestamp = ({ createdAt }: { createdAt: string }) => {
  const [showAbsolute, setShowAbsolute] = useState(false)
  return (
    <button
      type="button"
      onClick={() => setShowAbsolute((value) => !value)}
      title={showAbsolute ? undefined : new Date(createdAt).toLocaleString()}
      className="opacity-0 transition-opacity group-hover/message:opacity-100 focus-visible:opacity-100"
    >
      <time dateTime={createdAt}>
        {showAbsolute ? new Date(createdAt).toLocaleString() : formatRelativeTimestamp(createdAt)}
      </time>
    </button>
  )
}

const capitalize = (label: string): string =>
  label.length > 0 ? label[0].toUpperCase() + label.slice(1) : label

type ChatTimelineMessageProps = {
  workOwner?: string
  message: ChatMessage
  userName: string | null
  JsonView: JsonViewComponent | null
  ensureJsonViewLoaded: () => void
  onOpenFile?: (candidate: OpenFileCandidate) => void
  onSubmitQuestionResponse?: (
    request: ApiAskUserQuestionsRequest,
    response: ApiAskUserQuestionsResponseInput,
  ) => Promise<void> | void
  questionSubmitError?: string | null
}

const ChatTimelineMessage = memo(function ChatTimelineMessage({
  workOwner,
  message,
  userName,
  JsonView,
  ensureJsonViewLoaded,
  onOpenFile,
  onSubmitQuestionResponse,
  questionSubmitError = null,
}: ChatTimelineMessageProps) {
  const [isPayloadExpanded, setIsPayloadExpanded] = useState(false)
  const [isCopied, setIsCopied] = useState(false)
  const copyResetTimeoutRef = useRef<number | null>(null)

  const isUser = message.role === 'user'
  const isTool = message.role === 'tool'
  const isCompaction = message.role === 'compaction'
  const isSystem = message.role === 'system'
  const isAssistant = message.role === 'assistant' && !isTool
  const isDraftAssistant = isAssistant && message.metadata?.draft === true
  // Drafts and commentary render without message-header chrome.
  const hideAssistantHeader = isAssistant && (isDraftAssistant || Boolean(workOwner) ||
    message.metadata?.segment_kind === 'intermediate' || message.metadata?.assistant_phase === 'commentary')
  const payload = isTool ? resolveToolPayload(message) : null
  const toolName = (payload?.tool as string | undefined) ?? (message.display_role || 'Tool')
  const pendingQuestionRequest =
    isTool && message.metadata?.pending === true ? resolveQuestionRequest(payload) : null
  const ToolContentRenderer = payload?.tool ? getToolContentRenderer(payload.tool as string) : null
  const RoleContentRenderer = !isTool ? getRoleContentRenderer(message.role) : null
  const assistantFileSource: OpenFileSource | null = isAssistant && isFinalAssistantMessage(message)
    ? {
        kind: 'assistant_message',
        ...(isDraftAssistant ? {} : { message_id: message.message_id }),
        client_id: message.client_id,
      }
    : null
  const fileActions = assistantFileSource && onOpenFile
    ? (() => {
        const source = assistantFileSource
        return {
          source,
          onOpenFileCandidate: (candidate: FilePathCandidate) => {
            onOpenFile(toOpenFileCandidate(candidate, source))
          },
        }
      })()
    : undefined

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
    }
  }, [])

  const handleCopyMessage = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setIsCopied(true)
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setIsCopied(false)
      }, 1500)
    } catch (err) {
      console.error('Failed to copy message:', err)
    }
  }, [message.content])

  const handleTogglePayload = useCallback(() => {
    setIsPayloadExpanded((prev) => {
      const next = !prev
      if (next) {
        ensureJsonViewLoaded()
      }
      return next
    })
  }, [ensureJsonViewLoaded])

  if (isCompaction) {
    return <CompactionRow message={message} />
  }

  const attribution = automationAttribution(message)
  if (attribution) {
    return (
      <article className="text-xs text-muted-foreground" aria-label="Automation trigger">
        <div className={TRANSCRIPT_COLUMN_CLASSES}>
          <details className="px-4 py-2">
            <summary className="cursor-pointer">{attribution.label}</summary>
            <div className="mt-3 space-y-2">
              <p>Invocation created <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString()}</time></p>
              {attribution.automationId && <p className="break-all">Automation: {attribution.automationId}{attribution.revision !== null ? ` · Revision ${attribution.revision}` : ''}</p>}
              {attribution.automationId && <Link to="/automations" search={{ rule: attribution.automationId }} className="inline-block underline">View automation and activity</Link>}
              {attribution.invocationId && <p className="break-all">Run: {attribution.invocationId}</p>}
              {attribution.eventId && <p className="break-all">Event: {attribution.eventId}</p>}
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            </div>
          </details>
        </div>
      </article>
    )
  }

  if (isSystem) {
    return (
      <article className="group/message bg-muted/30 text-xs italic text-muted-foreground">
        <div className={TRANSCRIPT_COLUMN_CLASSES}>
          <div className="border-l-[3px] border-transparent px-4 py-2">
            <div className="mb-1 flex items-center justify-between font-mono text-[10px]">
              <span>{capitalize(message.display_role || 'System')}</span>
              <MessageTimestamp createdAt={message.created_at} />
            </div>
            <p>{message.content}</p>
          </div>
        </div>
      </article>
    )
  }

  if (isAssistant && !message.content.trim()) return null

  const contentNode = pendingQuestionRequest && onSubmitQuestionResponse ? (
    <QuestionRequestCard
      request={pendingQuestionRequest}
      submitError={questionSubmitError}
      onSubmit={(response) => onSubmitQuestionResponse(pendingQuestionRequest, response)}
    />
  ) : isTool ? (
    <div className="space-y-2 text-xs">
      {ToolContentRenderer && payload && <ToolContentRenderer payload={payload} />}
      <button
        type="button"
        onClick={handleTogglePayload}
        aria-expanded={isPayloadExpanded}
        className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
      >
        {isPayloadExpanded ? 'Hide payload' : 'Show payload'}
      </button>
      {isPayloadExpanded && (
        <div className="rounded-lg border border-border bg-card/70 p-2 text-foreground shadow-sm">
          {JsonView ? (
            <JsonView
              src={payload ?? { content: message.content }}
              name={false}
              collapsed={1}
              enableClipboard={false}
              displayDataTypes={false}
              displayObjectSize={false}
              theme={{
                base00: 'var(--chat-message)',
                base01: 'var(--chat-message)',
                base02: 'var(--background)',
                base03: 'var(--muted-foreground)',
                base04: 'var(--foreground)',
                base05: 'var(--foreground)',
                base06: 'var(--foreground)',
                base07: 'var(--foreground)',
                base08: '#a6ff4d',
                base09: '#ffb347',
                base0A: '#ffb347',
                base0B: '#a6ff4d',
                base0C: '#7dd3fc',
                base0D: '#7dd3fc',
                base0E: '#f472b6',
                base0F: '#f472b6',
              }}
            />
          ) : (
            <pre className="overflow-x-auto rounded-md bg-background/80 p-2 text-[11px] text-muted-foreground">
              <code>{JSON.stringify(payload ?? { content: message.content }, null, 2)}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  ) : RoleContentRenderer ? (
    <RoleContentRenderer
      content={message.content}
      fileActions={fileActions}
      isStreaming={isDraftAssistant}
    />
  ) : (
    <p>{message.content}</p>
  )

  return (
    <article
      data-work-owner={workOwner}
      className={cn(
        // Full-bleed row: the hover highlight (thread-list background) runs
        // edge to edge; content sits in the shared centered column.
        'group/message text-sm leading-relaxed text-foreground transition-colors hover:bg-secondary/40',
        (isUser || isAssistant) && 'font-mono',
      )}
    >
      <div className={TRANSCRIPT_COLUMN_CLASSES}>
        <div
          // User rows carry a rail in the per-bud accent; everything else a
          // transparent rail of the same width so text columns align.
          className="relative border-l-[3px] border-transparent px-4 py-2.5"
          style={isUser ? { borderLeftColor: 'var(--bud-accent-vibrant)' } : undefined}
        >
          <button
            type="button"
            onClick={handleCopyMessage}
            className={cn(
              'absolute bottom-2 right-2 z-10 rounded-md p-1.5 transition-all',
              'opacity-0 group-hover/message:opacity-100',
              'bg-black/10 text-muted-foreground hover:bg-black/20 hover:text-foreground',
              isCopied && 'opacity-100 bg-green-500/20 text-green-600',
            )}
            title="Copy message"
          >
            {isCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>

          {!hideAssistantHeader && <div className="mb-0.5 flex items-center justify-between text-[10px] font-mono text-muted-foreground">
            <span>
              {isTool
                ? `Tool • ${toolName}`
                : isUser
                  ? capitalize(userName ?? (message.display_role || 'User'))
                  : isAssistant
                    ? 'Bud'
                    : capitalize(message.display_role || message.role)}
            </span>
            <MessageTimestamp createdAt={message.created_at} />
          </div>}
          <div className={isAssistant ? 'min-h-[1lh]' : undefined}>{contentNode}</div>
        </div>
      </div>
    </article>
  )
})

ChatTimelineMessage.displayName = 'ChatTimelineMessage'

/**
 * A durable compaction marker (`role: "compaction"`): collapsed it is the
 * same pill the live notice shows; expanded it reveals the summary the
 * model now carries in place of the history above it.
 */
function CompactionRow({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false)
  const presentation = getCompactionRowPresentation(message as ApiMessage)
  const SummaryRenderer = getRoleRenderer('assistant')
  const canExpand = presentation.summary.length > 0
  return (
    <div className="px-4 py-1 text-[11px] font-mono uppercase tracking-wide text-muted-foreground">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-black/15" />
        <button
          type="button"
          onClick={() => canExpand && setExpanded((value) => !value)}
          aria-expanded={canExpand ? expanded : undefined}
          disabled={!canExpand}
          title={canExpand ? (expanded ? 'Hide the summary' : 'Show what the model now remembers') : undefined}
          className={cn(
            'flex items-center gap-1.5 rounded-full border border-black/20 bg-background/70 px-3 py-1 shadow-sm transition-colors',
            canExpand && 'cursor-pointer hover:border-black/40 hover:text-foreground',
          )}
        >
          {canExpand && (expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />)}
          <span className="font-semibold text-foreground">{presentation.label}</span>
          {presentation.detail && <span className="text-muted-foreground">{presentation.detail}</span>}
        </button>
        <div className="h-px flex-1 bg-black/15" />
      </div>
      {expanded && canExpand && (
        <div className={TRANSCRIPT_COLUMN_CLASSES}>
          <div className="mt-2 rounded-lg border-2 border-black/20 bg-card px-4 py-3 normal-case tracking-normal">
            <p className="mb-2 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
              What the model now remembers of the conversation above
            </p>
            <div className="text-sm leading-relaxed text-foreground">
              {SummaryRenderer ? (
                <SummaryRenderer content={presentation.summary} />
              ) : (
                <pre className="whitespace-pre-wrap break-words">{presentation.summary}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ChatTimelineNoticeRow({ notice }: { notice: ChatTimelineNotice }) {
  const isFailed = notice.status === 'failed'
  const phaseLabel = formatCompactionPhase(notice.phase)
  const tokenLabel = formatCompactionNoticeTokens(notice)

  return (
    <div className="flex items-center gap-3 px-4 py-1 text-[11px] font-mono uppercase tracking-wide text-muted-foreground">
      <div className="h-px flex-1 bg-black/15" />
      <div className="rounded-full border border-black/20 bg-background/70 px-3 py-1 shadow-sm">
        <span className={cn('font-semibold', isFailed ? 'text-destructive' : 'text-foreground')}>
          {isFailed ? 'Context compaction failed' : 'Context compacted'}
        </span>
        <span className="ml-2 text-muted-foreground">
          {phaseLabel}{tokenLabel ? ` - ${tokenLabel}` : ''}
        </span>
      </div>
      <div className="h-px flex-1 bg-black/15" />
    </div>
  )
}

function formatCompactionNoticeTokens(notice: ChatTimelineNotice): string | null {
  if (
    notice.status !== 'completed' ||
    notice.tokens_before === null ||
    notice.tokens_after === null ||
    notice.tokens_after === undefined
  ) {
    return null
  }
  return `${formatCompactTokens(notice.tokens_before)} -> ${formatCompactTokens(notice.tokens_after)}`
}

function resolveQuestionRequest(payload: Record<string, unknown> | null): ApiAskUserQuestionsRequest | null {
  if (
    !payload ||
    payload.tool !== 'ask_user_questions' ||
    payload.schema !== 'ask_user_questions_request_v1' ||
    typeof payload.request_id !== 'string' ||
    !Array.isArray(payload.questions)
  ) {
    return null
  }

  return payload as ApiAskUserQuestionsRequest
}
