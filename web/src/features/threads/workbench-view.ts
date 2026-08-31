/**
 * Workbench view-mode resolution and persistence
 * (design/responsive-web-layout.md §3.2, decision record #2).
 *
 * The workspace opens chat-first: phones start on the chat peer view,
 * larger screens start with the viewer collapsed (`none`). The last-used
 * WORKBENCH view (terminal | web) is still recorded globally for a future
 * "restore last view"; `chat`, `file`, and `none` are never persisted.
 */

import type { ViewMode } from '@/components/workbench/workspace-top-bar'

export const WORKBENCH_VIEW_STORAGE_KEY = 'bud.workbench.view'

type PersistableView = 'terminal' | 'web'

export function resolveInitialViewMode(
  isMobile: boolean,
  _stored: string | null,
): ViewMode {
  if (isMobile) {
    return 'chat'
  }
  // Chat-first: the workspace opens with the viewer collapsed; the stored
  // view is currently just a record of the last opened viewer (a future
  // "restore last view" can consult it again).
  return 'none'
}

export function persistableWorkbenchView(view: ViewMode): PersistableView | null {
  return view === 'terminal' || view === 'web' ? view : null
}

export function readStoredWorkbenchView(storage: Pick<Storage, 'getItem'> | null): string | null {
  try {
    return storage?.getItem(WORKBENCH_VIEW_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

export function writeStoredWorkbenchView(
  storage: Pick<Storage, 'setItem'> | null,
  view: ViewMode,
): void {
  const persistable = persistableWorkbenchView(view)
  if (!persistable) {
    return
  }
  try {
    storage?.setItem(WORKBENCH_VIEW_STORAGE_KEY, persistable)
  } catch {
    // Storage unavailable (private mode) — view just won't be remembered.
  }
}
