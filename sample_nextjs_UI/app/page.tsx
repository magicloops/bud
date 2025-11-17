'use client'

import { useState } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sidebar } from '@/components/sidebar'
import { TopBar } from '@/components/top-bar'
import { ChatColumn } from '@/components/chat-column'
import { TerminalColumn } from '@/components/terminal-column'
import { ConversationSelector } from '@/components/conversation-selector'

export default function Home() {
  const [activeSession, setActiveSession] = useState(2)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [conversationSelectorOpen, setConversationSelectorOpen] = useState(true)
  const [view, setView] = useState<'terminal' | 'web'>('terminal')
  const [input, setInput] = useState('')
  const [activeConversation, setActiveConversation] = useState(0)

  const sessions = [
    { id: 0, name: 'Session 1', color: 'var(--avatar-1)' },
    { id: 1, name: 'Session 2', color: 'var(--avatar-2)' },
    { id: 2, name: 'Session 3', color: 'var(--avatar-3)' },
    { id: 3, name: 'Session 4', color: 'var(--avatar-4)' },
  ]

  const conversations = [
    { id: 0, title: 'System Configuration', timestamp: new Date(Date.now() - 1000 * 60 * 30) },
    { id: 1, title: 'Database Migration', timestamp: new Date(Date.now() - 1000 * 60 * 60 * 5) },
    { id: 2, title: 'API Development', timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3) },
    { id: 3, title: 'Security Audit', timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7) },
    { id: 4, title: 'Performance Testing', timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14) },
  ]

  const handleSend = () => {
    if (input.trim()) {
      // TODO: Handle sending command to active session
      console.log('Sending command:', input, 'to session:', activeSession)
      setInput('')
    }
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        sessions={sessions}
        activeSession={activeSession}
        onSessionChange={setActiveSession}
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
      />
      
      {conversationSelectorOpen && (
        <ConversationSelector
          conversations={conversations}
          activeConversation={activeConversation}
          onConversationChange={setActiveConversation}
          activeSessionColor={sessions[activeSession].color}
        />
      )}
      
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar 
          sessionName={sessions[activeSession].name}
          view={view}
          onViewChange={setView}
          onMenuClick={() => setConversationSelectorOpen(!conversationSelectorOpen)}
        />
        
        <div className="flex flex-1 overflow-hidden">
          <ChatColumn sessionId={activeSession} activeSessionColor={sessions[activeSession].color} />
          <TerminalColumn view={view} sessionId={activeSession} />
        </div>

        <div className="relative border-t-4 border-black">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="Enter command..."
            className="h-32 w-full resize-none bg-background p-4 pr-16 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <Button
            onClick={handleSend}
            size="icon"
            className="absolute bottom-4 right-4 h-10 w-10 shrink-0 rounded-lg border-3 border-black bg-accent text-white hover:translate-y-0.5 active:translate-y-1"
            style={{ boxShadow: '3px 3px 0px 0px rgba(0,0,0,1)' }}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
