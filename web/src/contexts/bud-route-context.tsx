import { createContext, useContext } from 'react'
import type { ThreadSummary } from '@/components/workbench/thread-panel'
import type { ApiThread } from '@/lib/api-types'

export type BudRouteContextValue = {
  threads: ThreadSummary[]
  upsertThreadSummary: (thread: ApiThread | ThreadSummary) => void
  patchThreadSummary: (threadId: string, patch: Partial<ThreadSummary>) => void
  removeThreadSummary: (threadId: string) => void
}

export const BudRouteContext = createContext<BudRouteContextValue | null>(null)

export function useBudRouteContext(): BudRouteContextValue {
  const context = useContext(BudRouteContext)
  if (!context) {
    throw new Error('useBudRouteContext must be used within /$budId')
  }
  return context
}
