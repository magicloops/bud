import ReactJsonView from '@microlink/react-json-view'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { getMutedColor, resolveCssVar } from '@/lib/theme-colors'

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

export function ChatTimeline({ messages, accentColor }: ChatTimelineProps) {
  const [systemColor, setSystemColor] = useState(accentColor || 'var(--avatar-3)')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

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
    node.scrollTop = node.scrollHeight
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
          const payload = isTool ? resolveToolPayload(message) : null
          const toolName =
            (payload?.tool as string | undefined) ?? (message.displayRole || 'Tool')
          const summaryText =
            typeof payload?.command === 'string' ? payload.command : message.content
          const isExpanded = expanded[message.id] ?? false
          return (
            <article
              key={message.id}
              className={cn(
                'rounded-xl border-3 border-black p-3 text-sm leading-relaxed shadow-[3px_3px_0px_rgba(0,0,0,1)]',
                isUser ? 'bg-card text-card-foreground' : 'text-foreground',
                isTool && 'bg-background'
              )}
              style={{ backgroundColor: isUser ? undefined : systemColor }}
            >
              <div className="mb-1 flex items-center justify-between text-[11px] font-mono uppercase text-muted-foreground">
                <span>{isTool ? `Tool • ${toolName}` : message.displayRole || (isUser ? 'User' : message.role)}</span>
                <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
              </div>
              {isTool ? (
                <div className="space-y-2 text-xs">
                  <div className="rounded-md border border-dashed border-black/20 bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
                    {summaryText}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => ({
                        ...prev,
                        [message.id]: !isExpanded
                      }))
                    }
                    className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
                  >
                    {isExpanded ? 'Hide payload' : 'Show payload'}
                  </button>
                  {isExpanded && (
                    <div className="rounded-lg border border-border bg-card/70 p-2 text-foreground shadow-sm">
                      <ReactJsonView
                        src={payload ?? { content: message.content }}
                        name={false}
                        collapsed={1}
                        enableClipboard={false}
                        displayDataTypes={false}
                        displayObjectSize={false}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <p>{message.content}</p>
              )}
            </article>
          )
        })}
      </div>
    </div>
  )
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
