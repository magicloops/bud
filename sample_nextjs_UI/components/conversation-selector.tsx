'use client'

import { useEffect, useState } from 'react'
import { Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getMutedColor } from '@/lib/theme-colors'

interface Conversation {
  id: number
  title: string
  timestamp: Date
}

interface ConversationSelectorProps {
  conversations: Conversation[]
  activeConversation: number
  onConversationChange: (id: number) => void
  activeSessionColor: string
}

function getRelativeTime(date: Date): string {
  const now = new Date()
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000)
  
  if (diffInSeconds < 60) return 'just now'
  if (diffInSeconds < 3600) {
    const minutes = Math.floor(diffInSeconds / 60)
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  }
  if (diffInSeconds < 86400) {
    const hours = Math.floor(diffInSeconds / 3600)
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  }
  if (diffInSeconds < 604800) {
    const days = Math.floor(diffInSeconds / 86400)
    return `${days} ${days === 1 ? 'day' : 'days'} ago`
  }
  if (diffInSeconds < 2592000) {
    const weeks = Math.floor(diffInSeconds / 604800)
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`
  }
  if (diffInSeconds < 31536000) {
    const months = Math.floor(diffInSeconds / 2592000)
    return `${months} ${months === 1 ? 'month' : 'months'} ago`
  }
  const years = Math.floor(diffInSeconds / 31536000)
  return `${years} ${years === 1 ? 'year' : 'years'} ago`
}

export function ConversationSelector({
  conversations,
  activeConversation,
  onConversationChange,
  activeSessionColor,
}: ConversationSelectorProps) {
  const [mutedColor, setMutedColor] = useState<string>('')
  
  useEffect(() => {
    const computedColor = getComputedStyle(document.documentElement)
      .getPropertyValue(activeSessionColor.replace('var(', '').replace(')', ''))
      .trim()
    setMutedColor(getMutedColor(computedColor, 0.6))
  }, [activeSessionColor])

  return (
    <div className="flex h-full w-64 flex-col border-r-4 border-black bg-secondary/50">
      <div 
        className="flex h-16 items-center justify-between border-b-4 border-black px-4"
        style={{ backgroundColor: 'var(--chat-bg)' }}
      >
        <h1 className="text-xl font-bold truncate pr-2">Bud the almighty Linux guru</h1>
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 flex-shrink-0 rounded-lg border-3 border-black hover:translate-y-0.5 active:translate-y-1"
          style={{ boxShadow: '3px 3px 0px 0px rgba(0,0,0,1)' }}
        >
          <Settings className="h-5 w-5" />
        </Button>
      </div>
      
      <div className="flex-1 overflow-y-auto p-2">
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            onClick={() => onConversationChange(conversation.id)}
            className={`mb-2 w-full rounded-lg border-3 border-black p-3 text-left transition-all ${
              activeConversation === conversation.id
                ? 'bg-muted text-foreground shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-x-1 active:translate-y-1 active:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] opacity-100'
                : 'bg-card text-card-foreground shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:translate-x-1 active:translate-y-1 active:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] opacity-40'
            }`}
            style={
              activeConversation === conversation.id
                ? { backgroundColor: mutedColor }
                : undefined
            }
            onMouseEnter={(e) => {
              if (activeConversation !== conversation.id && mutedColor) {
                e.currentTarget.style.backgroundColor = mutedColor
                e.currentTarget.style.opacity = '0.6'
              }
            }}
            onMouseLeave={(e) => {
              if (activeConversation !== conversation.id) {
                e.currentTarget.style.backgroundColor = ''
                e.currentTarget.style.opacity = '0.4'
              }
            }}
          >
            <div className="font-semibold text-sm truncate mb-1">
              {conversation.title}
            </div>
            <div className="text-xs opacity-70">
              {getRelativeTime(conversation.timestamp)}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
