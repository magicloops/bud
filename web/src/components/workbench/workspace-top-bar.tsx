import type { ReactNode } from 'react'
import { FileText, Menu, MessageSquare, Monitor, TerminalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** `none` = viewer collapsed (desktop only): chat fills the workspace and no tab is active. */
export type ViewMode = 'chat' | 'terminal' | 'web' | 'file' | 'none'
export type WorkbenchStatus =
  | 'idle'
  | 'dispatching'
  | 'streaming'
  | 'waiting_for_user'
  /** The agent is parked on `terminal.wait`: idle until the terminal settles. */
  | 'waiting_for_terminal'

type WorkspaceTopBarProps = {
  title: string
  view: ViewMode
  onViewChange: (view: ViewMode) => void
  onToggleThreads: () => void
  status: WorkbenchStatus
  fileViewLabel?: string | null
  /** Below md the chat pane is a peer view with its own tab. */
  showChatTab?: boolean
}

export function WorkspaceTopBar({
  title,
  view,
  onViewChange,
  onToggleThreads,
  status,
  fileViewLabel = null,
  showChatTab = false,
}: WorkspaceTopBarProps) {
  return (
    <div className="flex h-16 items-center justify-between gap-2 border-b-3 border-black px-3 md:px-6" style={{ backgroundColor: 'var(--chat-bg)' }}>
        <div className="flex min-w-0 items-center gap-2 md:gap-4">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Toggle thread list"
            onClick={onToggleThreads}
            className="h-10 w-10 shrink-0 rounded-lg border-2 border-black transition-all hover:-translate-y-0.5"
            style={{ boxShadow: '3px 3px 0px rgba(0,0,0,1)' }}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex min-w-0 flex-col">
            <p className="truncate font-mono text-lg font-semibold">{title}</p>
          </div>
        </div>
      <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
        <span className="hidden text-xs font-mono uppercase tracking-wide text-muted-foreground lg:inline">
          {status === 'dispatching'
            ? 'Dispatching'
            : status === 'streaming'
              ? 'Streaming'
              : status === 'waiting_for_user'
                ? 'Waiting'
                : status === 'waiting_for_terminal'
                  ? 'Waiting on terminal'
                  : 'Idle'}
        </span>
        {showChatTab && (
          <ViewToggleButton active={view === 'chat'} onClick={() => onViewChange('chat')} icon={<MessageSquare className="h-4 w-4 md:mr-2" />}>
            Chat
          </ViewToggleButton>
        )}
        <ViewToggleButton active={view === 'terminal'} onClick={() => onViewChange('terminal')} icon={<TerminalIcon className="h-4 w-4 md:mr-2" />}>
          Terminal
        </ViewToggleButton>
        <ViewToggleButton active={view === 'web'} onClick={() => onViewChange('web')} icon={<Monitor className="h-4 w-4 md:mr-2" />}>
          Web view
        </ViewToggleButton>
        {(fileViewLabel || view === 'file') && (
          <ViewToggleButton active={view === 'file'} onClick={() => onViewChange('file')} icon={<FileText className="h-4 w-4 md:mr-2" />}>
            {fileViewLabel ?? 'File'}
          </ViewToggleButton>
        )}
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
      // The text label is hidden below md — icon-only buttons still need an
      // accessible name.
      aria-label={typeof children === 'string' ? children : undefined}
      className={cn(
        'rounded-lg border-2 border-black font-mono transition-all',
        active
          ? 'bg-[var(--bud-accent-muted)] text-black shadow-none translate-y-0.5 dark:bg-[var(--bud-accent-muted)] dark:text-white'
          : 'bg-card hover:-translate-y-0.5 hover:bg-[var(--bud-accent-soft)] dark:bg-background dark:hover:bg-[var(--bud-accent-soft)]'
      )}
      style={active ? { boxShadow: '3px 3px 0px rgba(0,0,0,0.4)' } : { boxShadow: '3px 3px 0px rgba(0,0,0,1)' }}
    >
      {icon}
      <span className="max-md:hidden">{children}</span>
    </Button>
  )
}
