/**
 * Workbench view-mode resolution and persistence
 * (design/responsive-web-layout.md §3.2, decision record #2).
 *
 * The last-used WORKBENCH view (terminal | web) is persisted globally so
 * tablets/desktops restore the user's working context. `chat` is only a
 * peer view below the md breakpoint (phones start there); `file` is
 * transient and never persisted.
 */

import type { ViewMode } from '@/components/workbench/workspace-top-bar'

export const WORKBENCH_VIEW_STORAGE_KEY = 'bud.workbench.view'

type PersistableView = 'terminal' | 'web'

export function resolveInitialViewMode(
  isMobile: boolean,
  stored: string | null,
): ViewMode {
  if (isMobile) {
    return 'chat'
  }
  return stored === 'web' ? 'web' : 'terminal'
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
