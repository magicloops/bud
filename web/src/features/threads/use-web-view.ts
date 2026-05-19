import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  apiFetch,
  apiFetchJson,
  isApiError,
  readResponseErrorMessage,
} from '@/lib/transport'
import type {
  ApiProxiedSite,
  ApiProxiedSiteListResponse,
  ApiProxyTransport,
  ApiThreadWebView,
  ApiThreadWebViewResponse,
  ApiViewerGrantResponse,
} from '@/lib/api-types'

export type WebViewStatus =
  | 'idle'
  | 'loading'
  | 'creating'
  | 'attaching'
  | 'granting'
  | 'ready'
  | 'error'

export type WebViewOpenInput = {
  targetHost: '127.0.0.1' | 'localhost' | '::1'
  targetPort: number
  path: string
  title?: string
}

type ThreadWebViewAttachmentResponse = {
  thread_id: string
  bud_id: string
  proxied_site_id: string
  selected_path: string | null
  created_at: string
  updated_at: string
}

type UseWebViewArgs = {
  budId: string | null
  threadId: string | null
  onError: (message: string) => void
  shouldAbortForUnauthorized: (response?: Response | null) => boolean
}

export function useWebView({
  budId,
  threadId,
  onError,
  shouldAbortForUnauthorized,
}: UseWebViewArgs) {
  const [sites, setSites] = useState<ApiProxiedSite[]>([])
  const [transport, setTransport] = useState<ApiProxyTransport | null>(null)
  const [websocketTransport, setWebsocketTransport] = useState<ApiProxyTransport | null>(null)
  const [activeWebView, setActiveWebView] = useState<ApiThreadWebView | null>(null)
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const [standaloneUrl, setStandaloneUrl] = useState<string | null>(null)
  const [grantExpiresAt, setGrantExpiresAt] = useState<string | null>(null)
  const [status, setStatus] = useState<WebViewStatus>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const sequenceRef = useRef(0)
  const onErrorRef = useRef(onError)

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  const activeSite = activeWebView?.proxied_site ?? null
  const activePath = activeWebView?.selected_path ?? activeSite?.path ?? '/'

  const applyError = useCallback((error: unknown, fallback: string) => {
    if (isApiError(error, 401)) {
      return
    }
    const message = error instanceof Error ? error.message : fallback
    setStatus('error')
    setErrorMessage(message)
    onErrorRef.current(message)
  }, [])

  const requestViewerGrant = useCallback(async (
    site: ApiProxiedSite,
    path: string,
    sequence: number,
  ) => {
    setStatus('granting')
    setErrorMessage(null)
    const grant = await apiFetchJson<ApiViewerGrantResponse>(
      `/api/proxied-sites/${site.proxied_site_id}/viewer-grants`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalizeProxyPath(path) }),
        redirectOnUnauthorized: false,
      },
    )

    if (sequenceRef.current !== sequence) {
      return grant
    }

    setIframeSrc(grant.bootstrap_url)
    setStandaloneUrl(grant.bootstrap_url)
    setGrantExpiresAt(grant.expires_at)
    setStatus('ready')
    setErrorMessage(null)
    return grant
  }, [])

  const refreshWebViews = useCallback(async () => {
    if (!budId || !threadId) {
      sequenceRef.current += 1
      setSites([])
      setTransport(null)
      setWebsocketTransport(null)
      setActiveWebView(null)
      setIframeSrc(null)
      setStandaloneUrl(null)
      setGrantExpiresAt(null)
      setStatus('idle')
      setErrorMessage(null)
      return
    }

    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    setStatus('loading')
    setErrorMessage(null)
    setIframeSrc(null)
    setStandaloneUrl(null)
    setGrantExpiresAt(null)

    try {
      const [siteList, threadWebView] = await Promise.all([
        apiFetchJson<ApiProxiedSiteListResponse>(
          `/api/buds/${budId}/proxied-sites`,
          { redirectOnUnauthorized: false },
        ),
        apiFetchJson<ApiThreadWebViewResponse>(
          `/api/threads/${threadId}/web-view`,
          { redirectOnUnauthorized: false },
        ),
      ])

      if (sequenceRef.current !== sequence) {
        return
      }

      setSites(siteList.proxied_sites)
      setTransport(siteList.transport)
      setWebsocketTransport(siteList.websocket_transport ?? null)
      setActiveWebView(threadWebView.web_view)

      if (!threadWebView.web_view) {
        setStatus('idle')
        return
      }

      await requestViewerGrant(
        threadWebView.web_view.proxied_site,
        threadWebView.web_view.selected_path ?? threadWebView.web_view.proxied_site.path,
        sequence,
      )
    } catch (error) {
      if (sequenceRef.current !== sequence || isApiError(error, 401)) {
        return
      }
      applyError(error, 'Failed to load web view')
    }
  }, [applyError, budId, requestViewerGrant, threadId])

  useEffect(() => {
    void refreshWebViews()
  }, [refreshWebViews])

  const attachSite = useCallback(async (
    site: ApiProxiedSite,
    path = site.path,
  ) => {
    if (!threadId) {
      const message = 'No thread selected'
      setStatus('error')
      setErrorMessage(message)
      onErrorRef.current(message)
      return null
    }

    setStatus('attaching')
    setErrorMessage(null)
    const attachment = await apiFetchJson<ThreadWebViewAttachmentResponse>(
      `/api/threads/${threadId}/web-view/attach`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proxied_site_id: site.proxied_site_id,
          path: normalizeProxyPath(path),
        }),
        redirectOnUnauthorized: false,
      },
    )

    const nextWebView: ApiThreadWebView = {
      ...attachment,
      proxied_site: site,
    }
    setActiveWebView(nextWebView)
    return nextWebView
  }, [threadId])

  const openLocalApp = useCallback(async (input: WebViewOpenInput) => {
    if (!budId || !threadId) {
      const message = 'No thread selected'
      setStatus('error')
      setErrorMessage(message)
      onErrorRef.current(message)
      return
    }

    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    const path = normalizeProxyPath(input.path)

    try {
      setStatus('creating')
      setErrorMessage(null)
      const site = await apiFetchJson<ApiProxiedSite>(
        `/api/buds/${budId}/proxied-sites`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target_host: input.targetHost,
            target_port: input.targetPort,
            path,
            title: input.title?.trim() || undefined,
            reuse_existing: true,
            source: 'manual',
          }),
          redirectOnUnauthorized: false,
        },
      )
      if (sequenceRef.current !== sequence) {
        return
      }

      setSites((current) => upsertSite(current, site))
      const nextWebView = await attachSite(site, path)
      if (!nextWebView || sequenceRef.current !== sequence) {
        return
      }
      await requestViewerGrant(site, nextWebView.selected_path ?? site.path, sequence)
    } catch (error) {
      if (isApiError(error, 401)) {
        return
      }
      applyError(error, 'Failed to open web view')
    }
  }, [applyError, attachSite, budId, requestViewerGrant, threadId])

  const selectSite = useCallback(async (proxiedSiteId: string) => {
    const site = sites.find((candidate) => candidate.proxied_site_id === proxiedSiteId)
    if (!site) {
      return
    }

    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    try {
      const nextWebView = await attachSite(site, site.path)
      if (!nextWebView || sequenceRef.current !== sequence) {
        return
      }
      await requestViewerGrant(site, nextWebView.selected_path ?? site.path, sequence)
    } catch (error) {
      if (isApiError(error, 401)) {
        return
      }
      applyError(error, 'Failed to attach web view')
    }
  }, [applyError, attachSite, requestViewerGrant, sites])

  const reloadWebView = useCallback(async () => {
    if (!activeSite) {
      return
    }

    await refreshWebViews()
  }, [activeSite, refreshWebViews])

  const openStandaloneWebView = useCallback(async () => {
    if (!activeSite) {
      return
    }

    const popup = typeof window !== 'undefined'
      ? window.open('about:blank', '_blank')
      : null
    if (popup) {
      popup.opener = null
    }

    try {
      const grant = await apiFetchJson<ApiViewerGrantResponse>(
        `/api/proxied-sites/${activeSite.proxied_site_id}/viewer-grants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: normalizeProxyPath(activePath) }),
          redirectOnUnauthorized: false,
        },
      )
      setStandaloneUrl(grant.bootstrap_url)
      if (popup) {
        popup.location.href = grant.bootstrap_url
      } else if (typeof window !== 'undefined') {
        window.open(grant.bootstrap_url, '_blank', 'noopener,noreferrer')
      }
    } catch (error) {
      popup?.close()
      if (isApiError(error, 401)) {
        return
      }
      applyError(error, 'Failed to open web view')
    }
  }, [activePath, activeSite, applyError])

  const detachWebView = useCallback(async () => {
    if (!threadId) {
      return
    }

    const response = await apiFetch(`/api/threads/${threadId}/web-view`, {
      method: 'DELETE',
      redirectOnUnauthorized: false,
    })
    if (shouldAbortForUnauthorized(response)) {
      return
    }
    if (!response.ok) {
      const message = await readResponseErrorMessage(response, `HTTP ${response.status}`)
      setStatus('error')
      setErrorMessage(message)
      onErrorRef.current(message)
      return
    }

    sequenceRef.current += 1
    setActiveWebView(null)
    setIframeSrc(null)
    setStandaloneUrl(null)
    setGrantExpiresAt(null)
    setWebsocketTransport(null)
    setStatus('idle')
    setErrorMessage(null)
  }, [shouldAbortForUnauthorized, threadId])

  return useMemo(() => ({
    activePath,
    activeSite,
    activeWebView,
    detachWebView,
    errorMessage,
    grantExpiresAt,
    iframeSrc,
    openLocalApp,
    openStandaloneWebView,
    refreshWebViews,
    reloadWebView,
    selectSite,
    sites,
    standaloneUrl,
    status,
    transport,
    websocketTransport,
  }), [
    activePath,
    activeSite,
    activeWebView,
    detachWebView,
    errorMessage,
    grantExpiresAt,
    iframeSrc,
    openLocalApp,
    openStandaloneWebView,
    refreshWebViews,
    reloadWebView,
    selectSite,
    sites,
    standaloneUrl,
    status,
    transport,
    websocketTransport,
  ])
}

function normalizeProxyPath(value: string | undefined): string {
  const trimmed = value?.trim() || '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function upsertSite(sites: ApiProxiedSite[], site: ApiProxiedSite): ApiProxiedSite[] {
  const existingIndex = sites.findIndex((candidate) => candidate.proxied_site_id === site.proxied_site_id)
  if (existingIndex === -1) {
    return [site, ...sites]
  }

  return sites.map((candidate, index) => (index === existingIndex ? site : candidate))
}
