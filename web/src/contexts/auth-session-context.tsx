import { createContext, useContext } from 'react'
import type { ApiCurrentUser } from '@/lib/api-types'

export type AuthSessionContextValue = {
  currentUser: ApiCurrentUser | null
  isAuthenticated: boolean
  setCurrentUser: (user: ApiCurrentUser | null) => void
}

export const AuthSessionContext = createContext<AuthSessionContextValue | null>(null)

export function useAuthSession() {
  const context = useContext(AuthSessionContext)
  if (!context) {
    throw new Error('useAuthSession must be used within an AuthSessionProvider')
  }
  return context
}
