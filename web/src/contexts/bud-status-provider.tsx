import { useCallback, useState, type ReactNode } from 'react'
import { BudStatusContext, type BudStatus } from '@/contexts/bud-status-context'

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
