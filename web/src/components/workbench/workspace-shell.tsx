import type { ReactNode } from 'react'
import { WorkspaceTopBar, type ViewMode } from '@/components/workbench/workspace-top-bar'

type WorkspaceShellProps = {
  title: string
  view: ViewMode
  onViewChange: (view: ViewMode) => void
  onToggleThreads: () => void
  status: 'idle' | 'dispatching' | 'streaming'
  fileViewLabel?: string | null
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
      />
      <div className="flex flex-1 overflow-hidden">
        {leftPane}
        {rightPane}
      </div>
      {composer}
      {debugPanel}
    </>
  )
}
