import { createContext, useContext } from 'react'

export type LayoutContextValue = {
  threadPanelOpen: boolean
  setThreadPanelOpen: (open: boolean) => void
  toggleThreadPanel: () => void
}

export const LayoutContext = createContext<LayoutContextValue | null>(null)

export function useLayout() {
  const context = useContext(LayoutContext)
  if (!context) {
    throw new Error('useLayout must be used within a LayoutProvider')
  }
  return context
}
