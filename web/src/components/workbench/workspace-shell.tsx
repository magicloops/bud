import type { ReactNode } from 'react'
import { WorkspaceTopBar, type ViewMode, type WorkbenchStatus } from '@/components/workbench/workspace-top-bar'

type WorkspaceShellProps = {
  title: string
  view: ViewMode
  onViewChange: (view: ViewMode) => void
  onToggleThreads: () => void
  status: WorkbenchStatus
  fileViewLabel?: string | null
  /** Below md: single-pane shell — chat becomes a peer view with its own
   *  tab, the composer shows only with the chat view, and the debug pill
   *  is hidden. Panes stay MOUNTED and hide via CSS (the terminal/iframe
   *  state-preservation rule). */
  isMobile?: boolean
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
  status,
  fileViewLabel = null,
  isMobile = false,
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
        status={status}
        fileViewLabel={fileViewLabel}
        showChatTab={isMobile}
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
