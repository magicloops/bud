import { useRef, type ReactNode, type RefObject } from 'react'
import { useComposerColumnAlignment } from '@/components/workbench/chat-pane-resize'
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
  /** While the thread panel is open it hosts the hamburger itself. */
  threadsOpen?: boolean
  fileViewLabel?: string | null
  /** Below md the chat pane is a peer view with its own tab. */
  showChatTab?: boolean
  /** Chat pane to align the title with (same column geometry the composer
   *  uses); when the column starts left of the title's natural position
   *  the title simply stays put. */
  alignToPaneRef?: RefObject<HTMLDivElement | null>
}

const NULL_PANE_REF: RefObject<HTMLDivElement | null> = { current: null }
// Title's natural left edge on md+: px-6 (24) + menu button (40) + gap-4 (16).
const TITLE_NATURAL_LEFT_PX = 80
// Message text sits 16px (the rows' px-4) inside the column's rail edge.
const ROW_TEXT_PADDING_PX = 16

export function WorkspaceTopBar({
  title,
  view,
  onViewChange,
  onToggleThreads,
  threadsOpen = false,
  fileViewLabel = null,
  showChatTab = false,
  alignToPaneRef,
}: WorkspaceTopBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null)
  const alignment = useComposerColumnAlignment(alignToPaneRef ?? NULL_PANE_REF, barRef)
  const titleOffset = alignment
    ? Math.max(0, alignment.paddingLeft + ROW_TEXT_PADDING_PX - TITLE_NATURAL_LEFT_PX)
    : 0
  return (
    <div
      ref={barRef}
      className="flex h-12 items-center justify-between gap-2 border-b-2 border-black bg-secondary/40 px-3 md:px-4"
    >
        <div className="flex min-w-0 items-center gap-2 md:gap-4">
          {!threadsOpen && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Toggle thread list"
              onClick={onToggleThreads}
              className="h-8 w-8 shrink-0 rounded-lg border-2 border-black transition-all hover:-translate-y-0.5"
              style={{ boxShadow: '2px 2px 0px rgba(0,0,0,1)' }}
            >
              <Menu className="h-4 w-4" />
            </Button>
          )}
          <div className="flex min-w-0 flex-col" style={titleOffset > 0 ? { marginLeft: titleOffset } : undefined}>
            <p className="truncate font-mono text-lg font-semibold">{title}</p>
          </div>
        </div>
      <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
        {showChatTab && (
          <ViewToggleButton active={view === 'chat'} onClick={() => onViewChange('chat')} icon={<MessageSquare className="h-4 w-4" />}>
            Chat
          </ViewToggleButton>
        )}
        <ViewToggleButton active={view === 'terminal'} onClick={() => onViewChange('terminal')} icon={<TerminalIcon className="h-4 w-4" />}>
          Terminal
        </ViewToggleButton>
        <ViewToggleButton active={view === 'web'} onClick={() => onViewChange('web')} icon={<Monitor className="h-4 w-4" />}>
          Web view
        </ViewToggleButton>
        {(fileViewLabel || view === 'file') && (
          <ViewToggleButton active={view === 'file'} onClick={() => onViewChange('file')} icon={<FileText className="h-4 w-4" />}>
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
      size="icon-sm"
      onClick={onClick}
      // Icon-only buttons: the label survives as accessible name + tooltip.
      aria-label={typeof children === 'string' ? children : undefined}
      title={typeof children === 'string' ? children : undefined}
      className={cn(
        'rounded-lg border-2 border-black font-mono transition-all',
        active
          ? 'bg-[var(--bud-accent-muted)] text-black shadow-none translate-y-0.5 dark:bg-[var(--bud-accent-muted)] dark:text-white'
          : 'bg-card hover:-translate-y-0.5 hover:bg-[var(--bud-accent-soft)]'
      )}
      style={active ? { boxShadow: '2px 2px 0px rgba(0,0,0,0.4)' } : { boxShadow: '2px 2px 0px rgba(0,0,0,1)' }}
    >
      {icon}
    </Button>
  )
}
