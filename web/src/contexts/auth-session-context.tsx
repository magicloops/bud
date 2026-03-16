import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { ApiCurrentUser } from '@/lib/api'

type AuthSessionContextValue = {
  currentUser: ApiCurrentUser | null
  isAuthenticated: boolean
  setCurrentUser: (user: ApiCurrentUser | null) => void
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null)

export function AuthSessionProvider({
  children,
  initialCurrentUser,
}: {
  children: ReactNode
  initialCurrentUser: ApiCurrentUser | null
}) {
  const [currentUser, setCurrentUser] = useState<ApiCurrentUser | null>(initialCurrentUser)

  useEffect(() => {
    setCurrentUser(initialCurrentUser)
  }, [initialCurrentUser])

  return (
    <AuthSessionContext.Provider
      value={{
        currentUser,
        isAuthenticated: currentUser !== null,
        setCurrentUser,
      }}
    >
      {children}
    </AuthSessionContext.Provider>
  )
}

export function useAuthSession() {
  const context = useContext(AuthSessionContext)
  if (!context) {
    throw new Error('useAuthSession must be used within an AuthSessionProvider')
  }
  return context
}
