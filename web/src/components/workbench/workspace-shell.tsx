import type { ReactNode, RefObject } from 'react'
import { WorkspaceTopBar, type ViewMode } from '@/components/workbench/workspace-top-bar'

type WorkspaceShellProps = {
  title: string
  view: ViewMode
  onViewChange: (view: ViewMode) => void
  onToggleThreads: () => void
  /** Forwarded to the top bar: hide its hamburger while the panel is open. */
  threadsOpen?: boolean
  fileViewLabel?: string | null
  /** Below md: single-pane shell — chat becomes a peer view with its own
   *  tab, the composer shows only with the chat view, and the debug pill
   *  is hidden. Panes stay MOUNTED and hide via CSS (the terminal/iframe
   *  state-preservation rule). */
  isMobile?: boolean
  /** Forwarded to the top bar so the title aligns with the chat column. */
  alignToPaneRef?: RefObject<HTMLDivElement | null>
  leftPane: ReactNode
  rightPane: ReactNode
  composer: ReactNode
  debugPanel?: ReactNode
}

export function WorkspaceShell({
  title,
  view,
  onViewChange,
  onToggleThreads,
  threadsOpen = false,
  fileViewLabel = null,
  isMobile = false,
  alignToPaneRef,
  leftPane,
  rightPane,
  composer,
  debugPanel = null,
}: WorkspaceShellProps) {
  return (
    <>
      <WorkspaceTopBar
        title={title}
        view={view}
        onViewChange={onViewChange}
        onToggleThreads={onToggleThreads}
        threadsOpen={threadsOpen}
        fileViewLabel={fileViewLabel}
        showChatTab={isMobile}
        alignToPaneRef={alignToPaneRef}
      />
      <div className="flex flex-1 overflow-hidden">
        {leftPane}
        {rightPane}
      </div>
      {(!isMobile || view === 'chat') && composer}
      {!isMobile && debugPanel}
    </>
  )
}
