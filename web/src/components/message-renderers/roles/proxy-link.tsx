import { useState, type MouseEvent, type ReactNode } from 'react'
import { apiFetchJson } from '@/lib/transport'
import { resolveProxyLink } from './proxy-link-resolution'

export function ProxyLink({ href, children }: { href: string; children: ReactNode }) {
  const [error, setError] = useState<string | null>(null)
  const open = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (!/^https?:/i.test(href) || event.button > 1) return
    event.preventDefault()
    setError(null)
    // Reserve the tab synchronously so the browser's popup blocker permits it.
    const popup = window.open('about:blank', '_blank')
    if (!popup) {
      setError('Allow popups to open this link.')
      return
    }
    popup.opener = null
    popup.document.title = 'Opening…'
    popup.document.body.textContent = 'Opening…'
    try {
      const destination = await resolveProxyLink(href, apiFetchJson)
      if (!popup.closed) popup.location.replace(destination)
    } catch {
      popup.close()
      setError('Unable to open this link. Check your connection and access, then try again.')
    }
  }
  return <>
    <a href={href} target="_blank" rel="noopener noreferrer"
      onClick={open} onAuxClick={open}
      className="text-accent underline underline-offset-2 hover:text-accent/80">{children}</a>
    {error && <span role="alert" className="ml-2 text-destructive">{error}</span>}
  </>
}
