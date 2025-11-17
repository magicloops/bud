import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { getMutedColor, resolveCssVar } from '@/lib/theme-colors'

export type ChatMessage = {
  id: string
  role: string
  displayRole: string
  content: string
  createdAt: string
}

type ChatTimelineProps = {
  messages: ChatMessage[]
  accentColor: string
}

export function ChatTimeline({ messages, accentColor }: ChatTimelineProps) {
  const [systemColor, setSystemColor] = useState(accentColor || 'var(--avatar-3)')
  const scrollRef = useRef<HTMLDivElement | null>(null)

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
          return (
            <article
              key={message.id}
              className={cn(
                'rounded-xl border-3 border-black p-3 text-sm leading-relaxed shadow-[3px_3px_0px_rgba(0,0,0,1)]',
                isUser ? 'bg-card text-card-foreground' : 'text-foreground'
              )}
              style={{ backgroundColor: isUser ? undefined : systemColor }}
            >
              <div className="mb-1 flex items-center justify-between text-[11px] font-mono uppercase text-muted-foreground">
                <span>{message.displayRole || (isUser ? 'User' : message.role)}</span>
                <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
              </div>
              <p>{message.content}</p>
            </article>
          )
        })}
      </div>
    </div>
  )
}
