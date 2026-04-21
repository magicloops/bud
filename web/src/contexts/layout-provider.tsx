import { useEffect, useState, type ReactNode } from 'react'
import { LayoutContext } from '@/contexts/layout-context'

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [threadPanelOpen, setThreadPanelOpen] = useState(() => {
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem('threadPanelOpen')
    return stored === null ? true : stored === 'true'
  })

  useEffect(() => {
    localStorage.setItem('threadPanelOpen', String(threadPanelOpen))
  }, [threadPanelOpen])

  const toggleThreadPanel = () => setThreadPanelOpen((open) => !open)

  return (
    <LayoutContext.Provider value={{ threadPanelOpen, setThreadPanelOpen, toggleThreadPanel }}>
      {children}
    </LayoutContext.Provider>
  )
}
