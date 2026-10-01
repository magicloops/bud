import { useEffect, useRef, useState } from 'react'
import { apiFetchJson, createAuthEventSource, isApiError } from '../../lib/transport'
import type { ApiThread, ApiThreadListPage } from '../../lib/api-types'
import { ThreadListWindow, type ThreadListPatch } from './thread-list-state'

export function useThreadList(budId: string) {
  const [threads, setThreads] = useState<ApiThread[]>([])
  const [loading, setLoading] = useState(true)
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [limit, setLimit] = useState(50)
  const [pageBoundary, setPageBoundary] = useState<{ cursor: string; row: ApiThread } | null>(null)
  const refreshRef = useRef<() => void>(() => {})
  const olderRef = useRef<() => void>(() => {})
  useEffect(() => {
    let stopped = false, ready = false, reading = false, dirty = false, generation = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    let expectedEpoch: string | null = null
    let advanceAfterRead = false
    let lastFrameAt = Date.now()
    setLoading(true)
    const window = new ThreadListWindow(budId, limit, pageBoundary?.row)
    const { source, checkUnauthorized } = createAuthEventSource('/api/me/thread-list/stream')
    const refresh = async () => {
      dirty = true
      if (stopped || !ready || reading) return
      reading = true
      const current = generation
      controller = new AbortController()
      window.begin()
      try {
        dirty = false
        const page = await apiFetchJson<ApiThreadListPage>(`/api/threads?bud_id=${encodeURIComponent(budId)}&limit=${limit}${pageBoundary ? `&cursor=${encodeURIComponent(pageBoundary.cursor)}` : ''}`, { signal: controller.signal })
        if (stopped || current !== generation) return
        if (page.feed_checkpoint.epoch !== expectedEpoch) throw new Error('thread_list_epoch_changed')
        const refill = window.snapshot(page)
        if (refill) dirty = true
        setThreads([...window.rows]); setHasMore(page.page.has_more); setError(null); setLoading(false)
        if (advanceAfterRead && !dirty && page.page.next_cursor && page.threads.length) {
          advanceAfterRead = false
          setPageBoundary({ cursor: page.page.next_cursor, row: page.threads.at(-1)! })
        }
      } catch (error) {
        if (stopped || current !== generation) return
        setError('Could not refresh conversations.'); setLoading(false)
        if (isApiError(error, 401) || isApiError(error, 404)) { stopped = true; source.close(); setThreads([]) }
        else retry = setTimeout(() => void refresh(), 3000)
      } finally {
        reading = false
        if (dirty && !stopped && ready) void refresh()
      }
    }
    refreshRef.current = () => { void refresh() }
    olderRef.current = () => { advanceAfterRead = true; void refresh() }
    source.addEventListener('ready', event => {
      if (stopped) return
      lastFrameAt = Date.now()
      generation++; controller?.abort(); ready = true
      expectedEpoch = JSON.parse(event.data).epoch
      clearTimeout(retry); void refresh()
    })
    for (const event of ['upsert', 'remove'] as const) source.addEventListener(event, message => {
      if (stopped || !ready) return
      lastFrameAt = Date.now()
      try {
        const patch = { ...JSON.parse(message.data), event } as ThreadListPatch
        const refill = window.patch(patch)
        if (!reading) setThreads([...window.rows])
        if (refill) void refresh()
      } catch { void refresh() }
    })
    source.addEventListener('resync_required', () => {
      generation++; controller?.abort(); ready = false
      // Server closes after this frame; EventSource reconnect receives a new ready.
    })
    source.onerror = () => { generation++; controller?.abort(); ready = false; void checkUnauthorized() }
    source.addEventListener('heartbeat', () => { lastFrameAt = Date.now() })
    const health = setInterval(() => {
      if (!stopped && Date.now() - lastFrameAt > 45_000) {
        stopped = true; controller?.abort(); source.close(); setConnectionAttempt(value => value + 1)
      }
    }, 15_000)
    const foreground = () => { if (document.visibilityState === 'visible') void refresh() }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', foreground)
    return () => { stopped = true; clearInterval(health); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', foreground); controller?.abort(); clearTimeout(retry); source.close(); refreshRef.current = () => {}; olderRef.current = () => {} }
  }, [budId, limit, pageBoundary, connectionAttempt])
  useEffect(() => { setPageBoundary(null); setLimit(50); setThreads([]) }, [budId])
  return { threads, setThreads, error, hasMore, loading,
    loadMore: () => limit < 200 ? setLimit(value => Math.min(200, value + 50)) : olderRef.current(),
    canLoadMore: hasMore, showLatest: pageBoundary ? () => setPageBoundary(null) : undefined,
    refresh: () => refreshRef.current() }
}
