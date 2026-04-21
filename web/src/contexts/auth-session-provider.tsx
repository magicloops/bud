import { useEffect, useState, type ReactNode } from 'react'
import type { ApiCurrentUser } from '@/lib/api'
import { AuthSessionContext } from '@/contexts/auth-session-context'

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
