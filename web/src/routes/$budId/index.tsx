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

export const Route = createFileRoute('/$budId/')({
  loader: async ({ params }) => {
    // Fetch threads for this bud
    const resp = await fetch(`/api/threads?bud_id=${params.budId}`)

    // On error, throw - let error boundary handle it
    // Don't mask errors by redirecting to /new
    if (!resp.ok) {
      throw new Error('Failed to load threads')
    }

    const threads = (await resp.json()) as Array<{
      thread_id: string
      created_at: string
      last_activity_at?: string | null
    }>

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
  },
  // Never renders - always redirects in loader
  component: () => null,
})
