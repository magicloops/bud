import type { ApiProxiedSite, ApiViewerGrantResponse } from '@/lib/api-types'

export type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>

// Resolve at click time: older transcript links need not match today's attachment.
export async function resolveProxyLink(href: string, apiFetchJson: JsonRequest): Promise<string> {
  const url = new URL(href)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return href
  let site: ApiProxiedSite
  try {
    site = await apiFetchJson<ApiProxiedSite>(
      `/api/proxied-sites/resolve?endpoint_host=${encodeURIComponent(url.hostname)}`,
    )
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 404) return href
    throw error
  }
  const grant = await apiFetchJson<ApiViewerGrantResponse>(
    `/api/proxied-sites/${site.proxied_site_id}/viewer-grants`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: `${url.pathname}${url.search}${url.hash}` }),
    },
  )
  return grant.bootstrap_url
}
