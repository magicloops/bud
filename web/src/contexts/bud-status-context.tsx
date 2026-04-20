import { createContext, useContext } from 'react'

export type BudStatus = 'online' | 'offline'

export type BudStatusContextValue = {
  statuses: Record<string, BudStatus>
  updateStatus: (budId: string, status: BudStatus) => void
}

export const BudStatusContext = createContext<BudStatusContextValue | null>(null)

export function useBudStatus() {
  const context = useContext(BudStatusContext)
  if (!context) {
    throw new Error('useBudStatus must be used within a BudStatusProvider')
  }
  return context
}
