import { redirect } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { ApiCurrentUser } from '@/lib/api-types'
import { getLoginRedirectValue, redirectToLogin } from '@/lib/auth-redirect'

export const toLoginRedirect = (pathname: string, search = '', hash = '') =>
  redirect({
    to: '/login',
    search: {
      redirect: getLoginRedirectValue(pathname, search, hash),
    },
  })

export const useRequireAuthenticatedUser = (currentUser: ApiCurrentUser | null) => {
  useEffect(() => {
    if (!currentUser) {
      redirectToLogin()
    }
  }, [currentUser])

  return currentUser
}
