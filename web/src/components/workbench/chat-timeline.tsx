import { memo, type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { config } from '@/lib/config'
import { getMutedColor, resolveCssVar } from '@/lib/theme-colors'
import { getToolContentRenderer, getRoleContentRenderer } from '@/components/message-renderers'
import {
  ThinkingIndicator,
  THINKING_INDICATOR_ENTER_DURATION_MS,
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
  accentColor: string
  activityIndicatorVisible?: boolean
  activityIndicatorLabel?: string
  hasOlderMessages?: boolean
  isLoadingOlderMessages?: boolean
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
  accentColor,
  activityIndicatorVisible = false,
  activityIndicatorLabel,
  hasOlderMessages = false,
  isLoadingOlderMessages = false,
  onLoadOlderMessages = null,
  scrollContainerRef,
  onOpenFile,
  onSubmitQuestionResponse,
  questionSubmitError = null,
}: ChatTimelineProps) => {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const shouldStickRef = useRef(true)
  const [JsonView, setJsonView] = useState<JsonViewComponent | null>(null)
  const systemColor = getMutedColor(resolveCssVar(accentColor || 'var(--avatar-3)'), 0.4)

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
    () => (config.showSystemMessages ? messages : messages.filter((message) => message.role !== 'system')),
    [messages],
  )
  const timelineItems = useMemo(() => {
    const items: Array<
      | { type: 'message'; message: ChatMessage }
      | { type: 'notice'; notice: ChatTimelineNotice }
    > = [
      ...visibleMessages.map((message) => ({ type: 'message' as const, message })),
      ...notices.map((notice) => ({ type: 'notice' as const, notice })),
    ]
    items.sort((a, b) => {
      const aTime = new Date(a.type === 'message' ? a.message.created_at : a.notice.created_at).getTime()
      const bTime = new Date(b.type === 'message' ? b.message.created_at : b.notice.created_at).getTime()
      return aTime - bTime
    })
    return items
  }, [notices, visibleMessages])

  const scrollSyncKey = useMemo(() => {
    const lastItem = timelineItems.at(-1)
    const lastKey = lastItem?.type === 'message'
      ? `${lastItem.message.client_id}:${lastItem.message.content.length}`
      : lastItem?.notice.notice_id ?? ''
    const activityKey = activityIndicatorVisible
      ? `activity:${activityIndicatorLabel ?? 'default'}`
      : 'activity:hidden'
    return `${timelineItems.length}:${lastKey}:${activityKey}`
  }, [activityIndicatorLabel, activityIndicatorVisible, timelineItems])

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

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const handler = () => {
      const { scrollTop, scrollHeight, clientHeight } = node
      const atBottom = scrollHeight - (scrollTop + clientHeight) < 48
      shouldStickRef.current = atBottom
    }
    node.addEventListener('scroll', handler, { passive: true })
    return () => {
      node.removeEventListener('scroll', handler)
    }
  }, [])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    if (!shouldStickRef.current) {
      return
    }
    const syncScroll = () => {
      node.scrollTop = node.scrollHeight
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(syncScroll)
    })
  }, [scrollSyncKey])

  useEffect(() => {
    const node = scrollRef.current
    if (!node || !activityIndicatorVisible || !shouldStickRef.current) {
      return
    }

    let frameId: number | null = null
    const start = window.performance.now()
    const followIndicatorGrowth = (timestamp: number) => {
      if (!shouldStickRef.current) {
        return
      }

      node.scrollTop = node.scrollHeight
      if (timestamp - start <= THINKING_INDICATOR_ENTER_DURATION_MS) {
        frameId = window.requestAnimationFrame(followIndicatorGrowth)
      }
    }

    frameId = window.requestAnimationFrame(followIndicatorGrowth)
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
      }
    }
  }, [activityIndicatorVisible])

  return (
    <div ref={setScrollNode} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      {onLoadOlderMessages && (
        <div className="flex justify-center pb-1">
          {hasOlderMessages ? (
            <button
              type="button"
              onClick={onLoadOlderMessages}
              disabled={isLoadingOlderMessages}
              className="rounded-full border-2 border-black bg-card px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-foreground shadow-[2px_2px_0px_rgba(0,0,0,1)] transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
            >
              {isLoadingOlderMessages ? 'Loading older…' : 'Load older messages'}
            </button>
          ) : visibleMessages.length > 0 ? (
            <p className="text-[11px] font-mono uppercase tracking-wide text-muted-foreground">
              Start of transcript
            </p>
          ) : null}
        </div>
      )}
      {timelineItems.length === 0 && (
        <p className="text-sm text-muted-foreground">No messages yet. Share a task to start the loop.</p>
      )}
      {timelineItems.map((item) => item.type === 'message' ? (
        <ChatTimelineMessage
          key={item.message.client_id}
          message={item.message}
          systemColor={systemColor}
          JsonView={JsonView}
          ensureJsonViewLoaded={ensureJsonViewLoaded}
          onOpenFile={onOpenFile}
          onSubmitQuestionResponse={onSubmitQuestionResponse}
          questionSubmitError={questionSubmitError}
        />
      ) : (
        <ChatTimelineNoticeRow key={item.notice.notice_id} notice={item.notice} />
      ))}
      <ThinkingIndicator
        isVisible={activityIndicatorVisible}
        label={activityIndicatorLabel}
      />
    </div>
  )
}

export const ChatTimeline = memo(ChatTimelineComponent)
ChatTimeline.displayName = 'ChatTimeline'

type ChatTimelineMessageProps = {
  message: ChatMessage
  systemColor: string
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
  message,
  systemColor,
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
  const isSystem = message.role === 'system'
  const isAssistant = message.role === 'assistant' && !isTool
  const isDraftAssistant = isAssistant && message.metadata?.draft === true
  const payload = isTool ? resolveToolPayload(message) : null
  const toolName = (payload?.tool as string | undefined) ?? (message.display_role || 'Tool')
  const pendingQuestionRequest =
    isTool && message.metadata?.pending === true ? resolveQuestionRequest(payload) : null
  const ToolContentRenderer = payload?.tool ? getToolContentRenderer(payload.tool as string) : null
  const RoleContentRenderer = !isTool ? getRoleContentRenderer(message.role) : null
  const assistantFileSource: OpenFileSource | null = isAssistant
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
  const timeLabel = new Date(message.created_at).toLocaleTimeString()
  const backgroundColor = isUser ? 'var(--chat-message)' : undefined
  const assistantBackground = isAssistant || isTool ? 'var(--chat-message)' : undefined
  const accentStyles =
    isUser && systemColor
      ? {
          borderColor: systemColor,
          boxShadow: `3px 3px 0 ${systemColor}`,
        }
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

  if (isSystem) {
    return (
      <article className="rounded-lg border-2 border-dashed border-muted-foreground/30 bg-muted/30 px-3 py-2 text-xs italic text-muted-foreground">
        <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase">
          <span>{message.display_role || 'System'}</span>
          <time>{timeLabel}</time>
        </div>
        <p>{message.content}</p>
      </article>
    )
  }

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
                base02: 'var(--chat-bg)',
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
      className={cn(
        'group/message relative rounded-xl border-3 border-black p-3 text-sm leading-relaxed shadow-[3px_3px_0px_rgba(0,0,0,1)]',
        isUser ? 'text-card-foreground' : 'text-foreground',
        (isAssistant || isTool) && 'bg-background',
      )}
      style={{
        backgroundColor: backgroundColor ?? assistantBackground,
        ...(accentStyles ?? {}),
      }}
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

      <div className="mb-1 flex items-center justify-between text-[11px] font-mono uppercase text-muted-foreground">
        <span>{isTool ? `Tool • ${toolName}` : message.display_role || (isUser ? 'User' : message.role)}</span>
        <time>{timeLabel}</time>
      </div>
      <div>{contentNode}</div>
    </article>
  )
})

ChatTimelineMessage.displayName = 'ChatTimelineMessage'

function ChatTimelineNoticeRow({ notice }: { notice: ChatTimelineNotice }) {
  const isFailed = notice.status === 'failed'
  const phaseLabel = formatCompactionPhase(notice.phase)
  const tokenLabel = formatCompactionNoticeTokens(notice)

  return (
    <div className="flex items-center gap-3 py-1 text-[11px] font-mono uppercase tracking-wide text-muted-foreground">
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

function formatCompactionPhase(phase: ApiAgentCompactionPhase): string {
  switch (phase) {
    case 'pre_turn':
      return 'Pre-turn'
    case 'mid_turn':
      return 'Mid-turn'
    case 'standalone_turn':
      return 'Standalone'
  }
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

function formatCompactTokens(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}m`
  }
  if (absolute >= 1_000) {
    return `${Math.round(value / 1_000)}k`
  }
  return String(Math.round(value))
}

function resolveToolPayload(message: ChatMessage): Record<string, unknown> | null {
  if (message.metadata && typeof message.metadata === 'object') {
    return message.metadata
  }
  try {
    const parsed = JSON.parse(message.content)
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore parse failures, fall back to null
  }
  return null
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
