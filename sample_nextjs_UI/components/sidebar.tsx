'use client'

import { Terminal, Plus, Sun, Moon, Monitor } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/components/theme-provider'

interface Session {
  id: number
  name: string
  color: string
}

interface SidebarProps {
  sessions: Session[]
  activeSession: number
  onSessionChange: (id: number) => void
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
}

export function Sidebar({
  sessions,
  activeSession,
  onSessionChange,
  collapsed,
  onCollapsedChange,
}: SidebarProps) {
  const { theme, setTheme } = useTheme()
  
  const cycleTheme = () => {
    if (theme === 'system') setTheme('light')
    else if (theme === 'light') setTheme('dark')
    else setTheme('system')
  }
  
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor

  return (
    <div
      className={cn(
        'flex flex-col border-r-4 border-black transition-all duration-300',
        collapsed ? 'w-20' : 'w-20'
      )}
      style={{ backgroundColor: 'var(--background)' }}
    >
      <div className="flex flex-col gap-3 p-3 flex-1">
        {sessions.map((session, index) => (
          <button
            key={session.id}
            onClick={() => onSessionChange(session.id)}
            className={cn(
              'group relative flex h-14 w-14 items-center justify-center rounded-xl border-3 border-black transition-all',
              'hover:translate-y-0.5 active:translate-y-1',
              activeSession === session.id && 'translate-y-0.5 shadow-none'
            )}
            style={{
              backgroundColor: session.color,
              opacity: activeSession === session.id ? 1 : 0.4,
              boxShadow: activeSession === session.id ? 'none' : '4px 4px 0px 0px rgba(0,0,0,1)',
            }}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 font-mono text-sm font-bold text-black">
              {index + 1}
            </div>
          </button>
        ))}
        
        <button
          className={cn(
            'flex h-14 w-14 items-center justify-center rounded-xl border-3 border-black transition-all',
            'bg-muted hover:translate-y-0.5 active:translate-y-1'
          )}
          style={{ boxShadow: '4px 4px 0px 0px rgba(0,0,0,1)' }}
        >
          <Plus className="h-6 w-6" />
        </button>
      </div>
      
      <div className="p-3">
        <button
          onClick={cycleTheme}
          className={cn(
            'flex h-14 w-14 items-center justify-center rounded-xl border-3 border-black transition-all',
            'bg-accent hover:translate-y-0.5 active:translate-y-1'
          )}
          style={{ boxShadow: '4px 4px 0px 0px rgba(0,0,0,1)' }}
          title={`Theme: ${theme}`}
        >
          <ThemeIcon className="h-6 w-6 text-accent-foreground" />
        </button>
      </div>
    </div>
  )
}
