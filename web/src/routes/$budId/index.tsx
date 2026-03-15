/**
 * Bud Index Route - redirect-only
 *
 * This route exists solely to redirect users to the appropriate view:
 * - If threads exist: redirect to most recent thread
 * - If no threads: redirect to /new
 *
 * This ensures users always land on meaningful content rather than
 * an empty "new thread" view when threads already exist.
 */

import { createFileRoute, redirect } from '@tanstack/react-router'
import { apiFetchJson, getLoginRedirectValue, isApiError } from '@/lib/api'

const toLoginRedirect = (pathname: string, search = '', hash = '') =>
  redirect({
    to: '/login',
    search: {
      redirect: getLoginRedirectValue(pathname, search, hash),
    },
  })

export const Route = createFileRoute('/$budId/')({
  loader: async ({ params, location }) => {
    try {
      const threads = await apiFetchJson<Array<{
        thread_id: string
        created_at: string
        last_activity_at?: string | null
      }>>(`/api/threads?bud_id=${params.budId}`, { redirectOnUnauthorized: false })

      // No threads - redirect to new thread view
      if (threads.length === 0) {
        throw redirect({ to: '/$budId/new', params: { budId: params.budId } })
      }

      // Find most recent thread (by last_activity_at, fallback to created_at)
      const mostRecent = threads.reduce((prev, curr) => {
        const prevTs = new Date(prev.last_activity_at ?? prev.created_at).getTime()
        const currTs = new Date(curr.last_activity_at ?? curr.created_at).getTime()
        return currTs > prevTs ? curr : prev
      })

      // Redirect to most recent thread
      throw redirect({
        to: '/$budId/$threadId',
        params: { budId: params.budId, threadId: mostRecent.thread_id }
      })
    } catch (error) {
      if (isApiError(error, 401)) {
        throw toLoginRedirect(location.href)
      }
      throw error
    }
  },
  // Never renders - always redirects in loader
  component: () => null,
})
