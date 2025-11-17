'use client'

import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { getMutedColor } from '@/lib/theme-colors'

interface Message {
  id: number
  content: string
  timestamp: string
  isUser: boolean
}

interface ChatColumnProps {
  sessionId: number
  activeSessionColor: string
}

export function ChatColumn({ sessionId, activeSessionColor }: ChatColumnProps) {
  const [messages, setMessages] = useState<Message[]>([
    { id: 1, content: 'ls -la', timestamp: '14:32', isUser: true },
    { id: 2, content: 'Listed 12 files in current directory', timestamp: '14:32', isUser: false },
    { id: 3, content: 'cd /var/www', timestamp: '14:33', isUser: true },
    { id: 4, content: 'Changed directory to /var/www', timestamp: '14:33', isUser: false },
  ])

  const [systemMessageColor, setSystemMessageColor] = useState<string>('')
  
  useEffect(() => {
    const computedColor = getComputedStyle(document.documentElement)
      .getPropertyValue(activeSessionColor.replace('var(', '').replace(')', ''))
      .trim()
    setSystemMessageColor(getMutedColor(computedColor, 0.4))
  }, [activeSessionColor])

  return (
    <div 
      className="flex w-80 min-w-80 flex-col border-r-4 border-black"
      style={{ backgroundColor: 'var(--chat-bg)' }}
    >
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              'rounded-lg border-3 border-black p-3',
              message.isUser ? 'bg-card text-card-foreground' : 'text-foreground'
            )}
            style={{ 
              boxShadow: '3px 3px 0px 0px rgba(0,0,0,1)',
              backgroundColor: message.isUser ? undefined : systemMessageColor,
            }}
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="font-mono text-xs font-bold">
                {message.isUser ? 'YOU' : 'SYSTEM'}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {message.timestamp}
              </span>
            </div>
            <p className="font-mono text-sm leading-relaxed">{message.content}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
