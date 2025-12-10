import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

type BudStatus = 'online' | 'offline'

type BudStatusContextValue = {
  statuses: Record<string, BudStatus>
  updateStatus: (budId: string, status: BudStatus) => void
}

const BudStatusContext = createContext<BudStatusContextValue | null>(null)

export function BudStatusProvider({ children }: { children: ReactNode }) {
  const [statuses, setStatuses] = useState<Record<string, BudStatus>>({})

  const updateStatus = useCallback((budId: string, status: BudStatus) => {
    setStatuses((prev) => {
      if (prev[budId] === status) return prev
      return { ...prev, [budId]: status }
    })
  }, [])

  return (
    <BudStatusContext.Provider value={{ statuses, updateStatus }}>
      {children}
    </BudStatusContext.Provider>
  )
}

export function useBudStatus() {
  const context = useContext(BudStatusContext)
  if (!context) {
    throw new Error('useBudStatus must be used within a BudStatusProvider')
  }
  return context
}
