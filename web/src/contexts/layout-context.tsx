import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'

type LayoutContextValue = {
  threadPanelOpen: boolean
  setThreadPanelOpen: (open: boolean) => void
  toggleThreadPanel: () => void
}

const LayoutContext = createContext<LayoutContextValue | null>(null)

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

export function useLayout() {
  const context = useContext(LayoutContext)
  if (!context) {
    throw new Error('useLayout must be used within a LayoutProvider')
  }
  return context
}
