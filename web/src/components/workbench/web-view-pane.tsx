import { useMemo, useState, type FormEvent } from 'react'
import {
  ExternalLink,
  Loader2,
  Monitor,
  Play,
  RefreshCw,
  Unplug,
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
}: WebViewPaneProps) {
  const [targetHost, setTargetHost] = useState<WebViewOpenInput['targetHost']>('localhost')
  const [targetPort, setTargetPort] = useState('5173')
  const [targetPath, setTargetPath] = useState('/')
  const [title, setTitle] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const isLoading = loadingStatuses.has(status)
  const displayError = localError ?? errorMessage
  const transportAvailable = transport?.available ?? activeSite?.transport?.available ?? true
  const activeTitle = activeSite
    ? `${activeSite.display_name} · ${activeSite.target_host}:${activeSite.target_port}${activePath}`
    : 'Web view'

  const selectedSiteId = activeSite?.proxied_site_id ?? ''
  const visibleSites = useMemo(
    () => sites.filter((site) => site.enabled && site.state === 'ready'),
    [sites],
  )

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

      <div className="flex shrink-0 flex-wrap items-end gap-2 border-b-2 border-black bg-muted/20 p-3">
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

      {displayError && (
        <div className="shrink-0 border-b-2 border-black bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
          {displayError}
        </div>
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
        {iframeSrc ? (
          <iframe
            key={iframeSrc}
            title={activeSite?.display_name ?? 'Bud web view'}
            src={iframeSrc}
            className="h-full w-full border-0 bg-white"
            referrerPolicy="no-referrer"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
          />
        ) : (
          <WebViewStateMessage status={status} transportAvailable={transportAvailable} />
        )}
      </div>
    </div>
  )
}

function WebViewStateMessage({
  status,
  transportAvailable,
}: {
  status: WebViewStatus
  transportAvailable: boolean
}) {
  const copy = (() => {
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
