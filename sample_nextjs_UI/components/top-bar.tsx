'use client'

import { Menu, Monitor, TerminalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface TopBarProps {
  sessionName: string
  view: 'terminal' | 'web'
  onViewChange: (view: 'terminal' | 'web') => void
  onMenuClick: () => void
}

export function TopBar({ sessionName, view, onViewChange, onMenuClick }: TopBarProps) {
  return (
    <div 
      className="flex h-16 items-center justify-between border-b-4 border-black px-6"
      style={{ backgroundColor: 'var(--chat-bg)' }}
    >
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={onMenuClick}
          className="h-10 w-10 rounded-lg border-3 border-black hover:translate-y-0.5 active:translate-y-1"
          style={{ boxShadow: '3px 3px 0px 0px rgba(0,0,0,1)' }}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <h1 className="font-mono text-xl font-bold">{sessionName}</h1>
      </div>
      
      <div className="flex gap-2">
        <Button
          variant={view === 'terminal' ? 'default' : 'outline'}
          size="sm"
          onClick={() => onViewChange('terminal')}
          className={cn(
            'rounded-lg border-3 border-black font-mono transition-all',
            view === 'terminal' 
              ? 'bg-primary text-primary-foreground shadow-none translate-y-0.5' 
              : 'hover:translate-y-0.5 active:translate-y-1'
          )}
          style={view !== 'terminal' ? { boxShadow: '3px 3px 0px 0px rgba(0,0,0,1)' } : {}}
        >
          <TerminalIcon className="mr-2 h-4 w-4" />
          Terminal
        </Button>
        <Button
          variant={view === 'web' ? 'default' : 'outline'}
          size="sm"
          onClick={() => onViewChange('web')}
          className={cn(
            'rounded-lg border-3 border-black font-mono transition-all',
            view === 'web' 
              ? 'bg-primary text-primary-foreground shadow-none translate-y-0.5' 
              : 'hover:translate-y-0.5 active:translate-y-1'
          )}
          style={view !== 'web' ? { boxShadow: '3px 3px 0px 0px rgba(0,0,0,1)' } : {}}
        >
          <Monitor className="mr-2 h-4 w-4" />
          Web View
        </Button>
      </div>
    </div>
  )
}
