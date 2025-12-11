import ReactJsonView from '@microlink/react-json-view'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { getMutedColor, resolveCssVar } from '@/lib/theme-colors'
import { getToolContentRenderer, getRoleContentRenderer } from '@/components/message-renderers'

const MAX_MESSAGE_HEIGHT = 500

export type ChatMessage = {
  id: string
  role: string
  displayRole: string
  content: string
  createdAt: string
  metadata?: Record<string, unknown> | null
}

type ChatTimelineProps = {
  messages: ChatMessage[]
  accentColor: string
}

const ChatTimelineComponent = ({ messages, accentColor }: ChatTimelineProps) => {
  const [systemColor, setSystemColor] = useState(accentColor || 'var(--avatar-3)')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const shouldStickRef = useRef(true)
  const [expandedPayloads, setExpandedPayloads] = useState<Record<string, boolean>>({})
  const [expandedMessages, setExpandedMessages] = useState<Record<string, boolean>>({})
  const [overflowingMessages, setOverflowingMessages] = useState<Record<string, boolean>>({})
  const contentRefs = useRef<Record<string, HTMLDivElement | null>>({})

  useEffect(() => {
    const resolved = resolveCssVar(accentColor || 'var(--avatar-3)')
    setSystemColor(getMutedColor(resolved, 0.4))
  }, [accentColor])

  const orderedMessages = useMemo(
    () => [...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [messages]
  )

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
  }, [orderedMessages.length])

  useEffect(() => {
    const next: Record<string, boolean> = {}
    for (const msg of orderedMessages) {
      const el = contentRefs.current[msg.id]
      if (!el) continue
      next[msg.id] = el.scrollHeight > MAX_MESSAGE_HEIGHT
    }
    setOverflowingMessages((prev) => {
      const changed =
        Object.keys(next).length !== Object.keys(prev).length ||
        Object.entries(next).some(([key, value]) => prev[key] !== value)
    return changed ? next : prev
    })
  }, [orderedMessages])

  return (
    <div className="flex w-96 flex-col border-r-4 border-black" style={{ backgroundColor: 'var(--chat-bg)' }}>
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {orderedMessages.length === 0 && (
          <p className="text-sm text-muted-foreground">No messages yet. Share a task to start the loop.</p>
        )}
        {orderedMessages.map((message) => {
          const isUser = message.role === 'user'
          const isTool = message.role === 'tool'
          const isAssistant = message.role === 'assistant' && !isTool
          const payload = isTool ? resolveToolPayload(message) : null
          const toolName =
            (payload?.tool as string | undefined) ?? (message.displayRole || 'Tool')
          const ToolContentRenderer = payload?.tool
            ? getToolContentRenderer(payload.tool as string)
            : null
          const isPayloadExpanded = expandedPayloads[message.id] ?? false
          const isMessageExpanded = expandedMessages[message.id] ?? false
          const isOverflowing = overflowingMessages[message.id] ?? false
          const backgroundColor = isUser ? 'var(--chat-message)' : undefined
          const assistantBackground = isAssistant || isTool ? 'var(--chat-message)' : undefined
          const overlayColor = backgroundColor ?? 'hsl(var(--card))'
          const accentStyles =
            isUser && systemColor
              ? {
                  borderColor: systemColor,
                  boxShadow: `3px 3px 0 ${systemColor}`
                }
              : undefined

          // Get role-based content renderer for user/assistant messages
          const RoleContentRenderer = !isTool ? getRoleContentRenderer(message.role) : null

          const contentNode = isTool ? (
            <div className="space-y-2 text-xs">
              {ToolContentRenderer && payload && (
                <ToolContentRenderer payload={payload} />
              )}
              <button
                type="button"
                onClick={() =>
                  setExpandedPayloads((prev) => ({
                    ...prev,
                    [message.id]: !isPayloadExpanded
                  }))
                }
                className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
              >
                {isPayloadExpanded ? 'Hide payload' : 'Show payload'}
              </button>
              {isPayloadExpanded && (
                <div className="rounded-lg border border-border bg-card/70 p-2 text-foreground shadow-sm">
                  <ReactJsonView
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
                      base0F: '#f472b6'
                    }}
                  />
                </div>
              )}
            </div>
          ) : RoleContentRenderer ? (
            <RoleContentRenderer content={message.content} />
          ) : (
            <p>{message.content}</p>
          )

          return (
            <article
              key={message.id}
              className={cn(
                'rounded-xl border-3 border-black p-3 text-sm leading-relaxed shadow-[3px_3px_0px_rgba(0,0,0,1)]',
                isUser ? 'text-card-foreground' : 'text-foreground',
                (isAssistant || isTool) && 'bg-background'
              )}
              style={{
                backgroundColor: backgroundColor ?? assistantBackground,
                ...(accentStyles ?? {})
              }}
            >
              <div className="mb-1 flex items-center justify-between text-[11px] font-mono uppercase text-muted-foreground">
                <span>{isTool ? `Tool • ${toolName}` : message.displayRole || (isUser ? 'User' : message.role)}</span>
                <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
              </div>
              <div className="relative">
                <div
                  ref={(node) => {
                    contentRefs.current[message.id] = node
                  }}
                  className={cn(isOverflowing && !isMessageExpanded && 'max-h-[500px] overflow-hidden')}
                >
                  {contentNode}
                </div>
                {isOverflowing && !isMessageExpanded && (
                  <div
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-5"
                    style={{
                      background: `linear-gradient(0deg, ${overlayColor} 60%, rgba(0,0,0,0))`
                    }}
                  />
                )}
              </div>
              {(isOverflowing || isMessageExpanded) && (
                <button
                  type="button"
                  onClick={() =>
                    setExpandedMessages((prev) => ({
                      ...prev,
                      [message.id]: !isMessageExpanded
                    }))
                  }
                  className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
                >
                  {isMessageExpanded ? 'Collapse message' : 'Expand message'}
                </button>
              )}
            </article>
          )
        })}
      </div>
    </div>
  )
}

export const ChatTimeline = memo(ChatTimelineComponent)
ChatTimeline.displayName = 'ChatTimeline'

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
