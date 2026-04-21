import type { ReactNode } from 'react'
import { Menu, Monitor, TerminalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type ViewMode = 'terminal' | 'web'

type WorkspaceTopBarProps = {
  title: string
  view: ViewMode
  onViewChange: (view: ViewMode) => void
  onToggleThreads: () => void
  status: 'idle' | 'dispatching' | 'streaming'
}

export function WorkspaceTopBar({
  title,
  view,
  onViewChange,
  onToggleThreads,
  status
}: WorkspaceTopBarProps) {
  return (
    <div className="flex h-16 items-center justify-between border-b-4 border-black px-6" style={{ backgroundColor: 'var(--chat-bg)' }}>
        <div className="flex items-center gap-4">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleThreads}
            className="h-10 w-10 rounded-lg border-3 border-black transition-all hover:-translate-y-0.5"
            style={{ boxShadow: '3px 3px 0px rgba(0,0,0,1)' }}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex flex-col">
            <p className="font-mono text-lg font-semibold">{title}</p>
          </div>
        </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono uppercase tracking-wide text-muted-foreground">
          {status === 'dispatching' ? 'Dispatching' : status === 'streaming' ? 'Streaming' : 'Idle'}
        </span>
        <ViewToggleButton active={view === 'terminal'} onClick={() => onViewChange('terminal')} icon={<TerminalIcon className="mr-2 h-4 w-4" />}>
          Terminal
        </ViewToggleButton>
        <ViewToggleButton active={view === 'web'} onClick={() => onViewChange('web')} icon={<Monitor className="mr-2 h-4 w-4" />}>
          Web view
        </ViewToggleButton>
      </div>
    </div>
  )
}

type ViewToggleButtonProps = {
  active: boolean
  children: ReactNode
  onClick: () => void
  icon: ReactNode
}

function ViewToggleButton({ active, children, onClick, icon }: ViewToggleButtonProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      className={cn(
        'rounded-lg border-3 border-black font-mono transition-all',
        active
          ? 'bg-[var(--bud-accent-muted)] text-black shadow-none translate-y-0.5 dark:bg-[var(--bud-accent-muted)] dark:text-white'
          : 'bg-card hover:-translate-y-0.5 hover:bg-[var(--bud-accent-soft)] dark:bg-background dark:hover:bg-[var(--bud-accent-soft)]'
      )}
      style={active ? { boxShadow: '3px 3px 0px rgba(0,0,0,0.4)' } : { boxShadow: '3px 3px 0px rgba(0,0,0,1)' }}
    >
      {icon}
      {children}
    </Button>
  )
}
