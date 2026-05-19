import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ExternalLink,
  Loader2,
  Monitor,
  Play,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Unplug,
  WifiOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ApiProxiedSite, ApiProxyTransport } from '@/lib/api-types'
import { cn } from '@/lib/utils'
import type { WebViewOpenInput, WebViewStatus } from '@/features/threads/use-web-view'

type WebViewPaneProps = {
  activePath: string
  activeSite: ApiProxiedSite | null
  errorMessage: string | null
  iframeSrc: string | null
  onDetach: () => void
  onOpenLocalApp: (input: WebViewOpenInput) => void
  onOpenStandalone: () => void
  onReload: () => void
  onSelectSite: (proxiedSiteId: string) => void
  sites: ApiProxiedSite[]
  status: WebViewStatus
  transport: ApiProxyTransport | null
  websocketTransport: ApiProxyTransport | null
}

const loadingStatuses = new Set<WebViewStatus>(['loading', 'creating', 'attaching', 'granting'])

export function WebViewPane({
  activePath,
  activeSite,
  errorMessage,
  iframeSrc,
  onDetach,
  onOpenLocalApp,
  onOpenStandalone,
  onReload,
  onSelectSite,
  sites,
  status,
  transport,
  websocketTransport,
}: WebViewPaneProps) {
  const [targetHost, setTargetHost] = useState<WebViewOpenInput['targetHost']>('localhost')
  const [targetPort, setTargetPort] = useState('5173')
  const [targetPath, setTargetPath] = useState('/')
  const [title, setTitle] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [controlsOpen, setControlsOpen] = useState(false)
  const syncedSiteSignatureRef = useRef<string | null>(null)

  const isLoading = loadingStatuses.has(status)
  const displayError = localError ?? errorMessage
  const transportAvailable = transport?.available ?? activeSite?.transport?.available ?? true
  const activeWebSocketTransport = activeSite?.websocket_transport ?? websocketTransport
  const websocketUnavailable =
    Boolean(activeSite) &&
    transportAvailable &&
    activeWebSocketTransport !== null &&
    activeWebSocketTransport.available === false
  const activeSiteUnavailable = activeSite?.state === 'disabled' || activeSite?.state === 'expired'
  const iframeUrl = !activeSiteUnavailable && transportAvailable ? iframeSrc : null
  const activeTitle = activeSite
    ? `${activeSite.display_name} · ${activeSite.target_host}:${activeSite.target_port}${activePath}`
    : 'Web view'

  const selectedSiteId = activeSite?.proxied_site_id ?? ''
  const visibleSites = useMemo(
    () => sites.filter((site) => site.enabled && site.state === 'ready'),
    [sites],
  )

  useEffect(() => {
    const activeSiteSignature = activeSite
      ? [
          activeSite.proxied_site_id,
          activeSite.target_host,
          activeSite.target_port,
          activePath || activeSite.path,
        ].join('|')
      : null

    if (syncedSiteSignatureRef.current === activeSiteSignature) {
      return
    }

    syncedSiteSignatureRef.current = activeSiteSignature
    setLocalError(null)

    if (!activeSite) {
      setTargetHost('localhost')
      setTargetPort('5173')
      setTargetPath('/')
      setTitle('')
      return
    }

    setTargetHost(toWebViewTargetHost(activeSite.target_host))
    setTargetPort(String(activeSite.target_port))
    setTargetPath(normalizeFormPath(activePath || activeSite.path))
    setTitle('')
  }, [activePath, activeSite])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsedPort = Number(targetPort)
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setLocalError('Port must be between 1 and 65535')
      return
    }

    setLocalError(null)
    onOpenLocalApp({
      targetHost,
      targetPort: parsedPort,
      path: targetPath,
      title,
    })
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b-2 border-black bg-background px-3">
        <div className="flex min-w-0 items-center gap-2 font-mono">
          <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="truncate text-sm font-semibold">{activeTitle}</p>
          {isLoading && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => setControlsOpen((open) => !open)}
            title="Web view settings"
            aria-label="Web view settings"
            aria-expanded={controlsOpen}
            aria-controls="web-view-controls"
            className={cn(
              'h-8 w-8 cursor-pointer rounded-md bg-transparent text-foreground hover:bg-black/10 dark:hover:bg-white/10',
              controlsOpen && 'bg-black/10 dark:bg-white/10',
            )}
          >
            <Settings2 className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={onReload}
            disabled={!activeSite || isLoading}
            title="Reload web view"
            className="h-8 w-8 cursor-pointer rounded-md bg-transparent text-foreground hover:bg-black/10 dark:hover:bg-white/10"
          >
            <RefreshCw className={cn('h-4 w-4', status === 'granting' && 'animate-spin')} />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={onOpenStandalone}
            disabled={!activeSite || isLoading}
            title="Open standalone"
            className="h-8 w-8 cursor-pointer rounded-md bg-transparent text-foreground hover:bg-black/10 dark:hover:bg-white/10"
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={onDetach}
            disabled={!activeSite || isLoading}
            title="Detach web view"
            className="h-8 w-8 cursor-pointer rounded-md bg-transparent text-foreground hover:bg-black/10 dark:hover:bg-white/10"
          >
            <Unplug className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {controlsOpen && (
        <div
          id="web-view-controls"
          className="flex shrink-0 flex-wrap items-end gap-2 border-b-2 border-black bg-muted/20 p-3"
        >
          {visibleSites.length > 0 && (
            <label className="flex min-w-[180px] flex-1 flex-col gap-1 font-mono text-xs font-semibold uppercase text-muted-foreground">
              Site
              <select
                value={selectedSiteId}
                onChange={(event) => onSelectSite(event.target.value)}
                disabled={isLoading}
                className="h-9 rounded-md border-2 border-black bg-background px-2 text-sm normal-case text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="" disabled>
                  Select
                </option>
                {visibleSites.map((site) => (
                  <option key={site.proxied_site_id} value={site.proxied_site_id}>
                    {site.display_name} ({site.target_port})
                  </option>
                ))}
              </select>
            </label>
          )}
          <form onSubmit={handleSubmit} className="flex flex-1 flex-wrap items-end gap-2">
            <label className="flex w-28 flex-col gap-1 font-mono text-xs font-semibold uppercase text-muted-foreground">
              Host
              <select
                value={targetHost}
                onChange={(event) => setTargetHost(event.target.value as WebViewOpenInput['targetHost'])}
                disabled={isLoading}
                className="h-9 rounded-md border-2 border-black bg-background px-2 text-sm normal-case text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="localhost">localhost</option>
                <option value="127.0.0.1">127.0.0.1</option>
                <option value="::1">::1</option>
              </select>
            </label>
            <label className="flex w-24 flex-col gap-1 font-mono text-xs font-semibold uppercase text-muted-foreground">
              Port
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={targetPort}
                onChange={(event) => setTargetPort(event.target.value)}
                disabled={isLoading}
                className="h-9 rounded-md border-2 border-black bg-background px-2 text-sm normal-case text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="flex min-w-[110px] flex-1 flex-col gap-1 font-mono text-xs font-semibold uppercase text-muted-foreground">
              Path
              <input
                type="text"
                value={targetPath}
                onChange={(event) => setTargetPath(event.target.value)}
                disabled={isLoading}
                className="h-9 rounded-md border-2 border-black bg-background px-2 text-sm normal-case text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="flex min-w-[120px] flex-1 flex-col gap-1 font-mono text-xs font-semibold uppercase text-muted-foreground">
              Name
              <input
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={isLoading}
                className="h-9 rounded-md border-2 border-black bg-background px-2 text-sm normal-case text-foreground outline-none focus:ring-2 focus:ring-ring"
                placeholder={`Local app ${targetPort || ''}`.trim()}
              />
            </label>
            <Button
              type="submit"
              size="sm"
              disabled={isLoading || !transportAvailable}
              className="h-9 rounded-md border-2 border-black font-mono"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Open
            </Button>
          </form>
        </div>
      )}

      {displayError && (
        <div className="shrink-0 border-b-2 border-black bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
          {displayError}
        </div>
      )}

      {activeSiteUnavailable && (
        <WebViewStatusBanner
          tone="error"
          message={activeSite.state === 'expired' ? 'This proxied site has expired' : 'This proxied site is disabled'}
        />
      )}

      {!transportAvailable && (
        <WebViewStatusBanner
          tone="error"
          message={proxyTransportMessage(transport ?? activeSite?.transport ?? null, 'http')}
        />
      )}

      {websocketUnavailable && (
        <WebViewStatusBanner
          tone="warning"
          message={proxyTransportMessage(activeWebSocketTransport, 'websocket')}
        />
      )}

      <div className="relative min-h-0 flex-1 bg-white">
        {activeSite && (
          <div className="pointer-events-none absolute right-3 top-3 z-10">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onOpenStandalone}
              disabled={isLoading}
              className="pointer-events-auto h-8 rounded-md border-2 border-black bg-background font-mono text-xs shadow-[2px_2px_0px_rgba(0,0,0,1)]"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in new tab
            </Button>
          </div>
        )}
        {iframeUrl ? (
          <iframe
            key={iframeUrl}
            title={activeSite?.display_name ?? 'Bud web view'}
            src={iframeUrl}
            className="h-full w-full border-0 bg-white"
            referrerPolicy="no-referrer"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
          />
        ) : (
          <WebViewStateMessage
            message={
              activeSiteUnavailable
                ? activeSite?.state === 'expired'
                  ? 'This proxied site has expired'
                  : 'This proxied site is disabled'
                : !transportAvailable
                  ? proxyTransportMessage(transport ?? activeSite?.transport ?? null, 'http')
                  : null
            }
            status={status}
            transportAvailable={transportAvailable}
          />
        )}
      </div>
    </div>
  )
}

function WebViewStateMessage({
  message,
  status,
  transportAvailable,
}: {
  message: string | null
  status: WebViewStatus
  transportAvailable: boolean
}) {
  const copy = (() => {
    if (message) {
      return message
    }
    if (!transportAvailable) {
      return 'Bud proxy transport unavailable'
    }
    if (status === 'loading') {
      return 'Loading web view'
    }
    if (status === 'creating') {
      return 'Opening local server'
    }
    if (status === 'attaching') {
      return 'Attaching web view'
    }
    if (status === 'granting') {
      return 'Authorizing web view'
    }
    if (status === 'error') {
      return 'Unable to open web view'
    }
    return 'No web view selected'
  })()

  return (
    <div className="flex h-full min-h-[240px] items-center justify-center p-4 text-center">
      <div className="rounded-lg border-3 border-black bg-card px-5 py-4 shadow-[4px_4px_0px_rgba(0,0,0,1)]">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border-2 border-black bg-background">
          {loadingStatuses.has(status) ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Monitor className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <p className="font-mono text-sm font-semibold">{copy}</p>
      </div>
    </div>
  )
}

function WebViewStatusBanner({
  message,
  tone,
}: {
  message: string
  tone: 'warning' | 'error'
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-b-2 border-black px-3 py-2 font-mono text-xs',
        tone === 'error'
          ? 'bg-destructive/10 text-destructive'
          : 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-100',
      )}
    >
      {tone === 'error' ? <WifiOff className="h-3.5 w-3.5 shrink-0" /> : <ShieldAlert className="h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0">{message}</span>
    </div>
  )
}

function proxyTransportMessage(
  transport: ApiProxyTransport | null,
  kind: 'http' | 'websocket',
): string {
  if (!transport) {
    return kind === 'websocket'
      ? 'WebSocket/HMR status is unavailable'
      : 'Bud proxy transport status is unavailable'
  }
  if (transport.available) {
    return kind === 'websocket'
      ? 'WebSocket/HMR is available'
      : 'Bud proxy transport is available'
  }
  if (transport.code === 'DATA_PLANE_UNAVAILABLE') {
    return kind === 'websocket'
      ? 'Bud is offline, so WebSocket/HMR is unavailable'
      : 'Bud is offline, so this proxied site cannot be reached'
  }
  if (transport.code === 'STREAM_FAMILY_UNSUPPORTED') {
    return kind === 'websocket'
      ? 'Static HTTP preview is available, but this Bud does not support WebSocket/HMR proxying'
      : 'This Bud does not support web proxying'
  }
  if (transport.code === 'TRANSPORT_DEGRADED') {
    return transport.message ?? 'Bud proxy transport is degraded'
  }
  return transport.message ?? (
    kind === 'websocket'
      ? 'WebSocket/HMR is unavailable'
      : 'Bud proxy transport is unavailable'
  )
}

function toWebViewTargetHost(value: ApiProxiedSite['target_host']): WebViewOpenInput['targetHost'] {
  if (value === '127.0.0.1' || value === 'localhost' || value === '::1') {
    return value
  }
  return 'localhost'
}

function normalizeFormPath(value: string | null | undefined): string {
  const trimmed = value?.trim() || '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}
