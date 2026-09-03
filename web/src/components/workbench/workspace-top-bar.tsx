import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  TRANSCRIPT_ROW_TEXT_PADDING_PX,
  useComposerColumnAlignment,
} from '@/components/workbench/chat-pane-resize'
import { FileText, FoldVertical, Menu, MessageSquare, Monitor, TerminalIcon, UnfoldVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** `none` = viewer collapsed (desktop only): chat fills the workspace and no tab is active. */
export type ViewMode = 'chat' | 'terminal' | 'web' | 'file' | 'none'
/** What the chat pane renders: the transcript, or the exact model context. */
export type TranscriptMode = 'chat' | 'model'
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
  /** When provided, renders the Model-view toggle: unfold icon to expand into what the model sees, fold to return. */
  transcriptMode?: TranscriptMode
  onTranscriptModeChange?: (mode: TranscriptMode) => void
}

const NULL_PANE_REF: RefObject<HTMLDivElement | null> = { current: null }
/** Inset of the model-view toggle from the chat pane's right edge while a
 *  viewer is open — the same 12px the pinned send button keeps below it. */
const CHAT_PANE_CONTROL_INSET_PX = 12

export function WorkspaceTopBar({
  title,
  view,
  onViewChange,
  onToggleThreads,
  threadsOpen = false,
  fileViewLabel = null,
  showChatTab = false,
  alignToPaneRef,
  transcriptMode,
  onTranscriptModeChange,
}: WorkspaceTopBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null)
  const titleBlockRef = useRef<HTMLDivElement | null>(null)
  const alignment = useComposerColumnAlignment(alignToPaneRef ?? NULL_PANE_REF, barRef)
  // The title's natural left edge depends on the responsive padding/gap and
  // on whether the hamburger is rendered (the thread panel hosts it while
  // open), so measure it instead of hardcoding the layout. The offset margin
  // lives on the <p> inside the block, so this rect is offset-free.
  const [titleNaturalLeft, setTitleNaturalLeft] = useState<number | null>(null)
  useLayoutEffect(() => {
    const bar = barRef.current
    const titleBlock = titleBlockRef.current
    if (!bar || !titleBlock) {
      return
    }
    setTitleNaturalLeft(
      titleBlock.getBoundingClientRect().left - bar.getBoundingClientRect().left,
    )
    // `alignment` changes on every bar/pane resize, re-measuring across
    // responsive padding/gap breakpoints.
  }, [threadsOpen, alignment])
  const titleOffset = alignment && titleNaturalLeft !== null
    ? Math.max(0, alignment.paddingLeft + TRANSCRIPT_ROW_TEXT_PADDING_PX - titleNaturalLeft)
    : 0

  // The model-view toggle belongs to the chat column: while a viewer is open
  // (the pane ends well before the view tabs) it is anchored to the pane's
  // right edge; when chat fills the workspace it sits inline with the tabs.
  const controlsRef = useRef<HTMLDivElement | null>(null)
  const [toggleRight, setToggleRight] = useState<number | null>(null)
  useEffect(() => {
    const bar = barRef.current
    const pane = alignToPaneRef?.current
    const controls = controlsRef.current
    if (!bar || !pane || !controls || typeof ResizeObserver === 'undefined') {
      setToggleRight(null)
      return
    }
    const measure = () => {
      const barRect = bar.getBoundingClientRect()
      const paneRect = pane.getBoundingClientRect()
      if (paneRect.width <= 0) {
        setToggleRight(null) // hidden pane (mobile non-chat view)
        return
      }
      const paneInset = barRect.right - paneRect.right
      const controlsWidth = controls.getBoundingClientRect().width
      setToggleRight(paneInset > controlsWidth + 24 ? Math.round(paneInset + CHAT_PANE_CONTROL_INSET_PX) : null)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    observer.observe(pane)
    observer.observe(controls)
    measure()
    return () => observer.disconnect()
  }, [alignToPaneRef])

  const modelViewToggle =
    transcriptMode && onTranscriptModeChange ? (
      <ViewToggleButton
        active={transcriptMode === 'model'}
        pressed
        onClick={() => onTranscriptModeChange(transcriptMode === 'model' ? 'chat' : 'model')}
        icon={
          transcriptMode === 'model' ? <FoldVertical className="h-4 w-4" /> : <UnfoldVertical className="h-4 w-4" />
        }
      >
        {transcriptMode === 'model' ? 'Back to chat' : 'Show what the model sees'}
      </ViewToggleButton>
    ) : null

  return (
    <div
      ref={barRef}
      className="relative flex h-12 items-center justify-between gap-2 border-b-2 border-black bg-secondary/40 px-3 md:px-4"
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
          <div ref={titleBlockRef} className="flex min-w-0 flex-col">
            <p
              className="truncate font-mono text-lg font-semibold"
              style={titleOffset > 0 ? { marginLeft: titleOffset } : undefined}
            >
              {title}
            </p>
          </div>
        </div>
      {modelViewToggle && toggleRight !== null && (
        <div className="absolute top-1/2 -translate-y-1/2" style={{ right: toggleRight }}>
          {modelViewToggle}
        </div>
      )}
      <div ref={controlsRef} className="flex shrink-0 items-center gap-1.5 md:gap-2">
        {modelViewToggle && toggleRight === null && modelViewToggle}
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
  /** On/off toggles announce state via aria-pressed; view tabs do not. */
  pressed?: boolean
}

function ViewToggleButton({ active, children, onClick, icon, pressed = false }: ViewToggleButtonProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      onClick={onClick}
      // Icon-only buttons: the label survives as accessible name + tooltip.
      aria-label={typeof children === 'string' ? children : undefined}
      aria-pressed={pressed ? active : undefined}
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
