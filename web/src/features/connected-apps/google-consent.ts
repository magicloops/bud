import { apiFetchJson } from '@/lib/transport'
import type { GoogleAccess, GoogleService } from './google-services'

export async function googleConsentUrl(service: GoogleService, access: GoogleAccess, signal: AbortSignal, connectionId?: string, threadId?: string) {
  const { authorization_url } = await apiFetchJson<{ authorization_url: string }>('/api/google/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ selections: [{ service, access }], connection_id: connectionId, thread_id: threadId }),
  })
  return authorization_url
}

// Only the initiating tab/card may use a returned ID to preselect an account.
// The server inventory is still the sole source of access and ownership.
const pendingCardKey = 'bud:google:pending-consent-card'
export function rememberConsentCard(cardKey?: string, target?: string) {
  try {
    if (cardKey) window.sessionStorage.setItem(pendingCardKey, JSON.stringify({ cardKey, target, expires: Date.now() + 10 * 60_000 }))
    else window.sessionStorage.removeItem(pendingCardKey)
  } catch { /* Storage is optional: users can still select an account. */ }
}

function singleParameter(query: URLSearchParams, key: string) {
  const values = query.getAll(key)
  return values.length === 1 ? values[0] : null
}

export function googleCardCallback(cardKey?: string) {
  const query = new URLSearchParams(window.location.search)
  const status = singleParameter(query, 'google')
  const id = singleParameter(query, 'google_connection_id')
  const returned = query.has('google')
  const unbound = { returned, status, connectionId: null }
  try {
    const stored = window.sessionStorage.getItem(pendingCardKey)
    const receipt = stored && JSON.parse(stored)
    if (!receipt || !(receipt.expires > Date.now())) return unbound
    if (!cardKey || receipt.cardKey !== cardKey) return { returned, status: null, connectionId: null }
    if (!returned) {
      // Returning via Back may reload the document instead of restoring its cache.
      window.sessionStorage.removeItem(pendingCardKey)
      return unbound
    }
    const hasAccount = status === 'connected' || status === 'account_already_connected'
    const connectionId = hasAccount && id && id.trim() === id && id.length <= 80 &&
      (!receipt.target || receipt.target === id) ? id : null
    if (receipt.outcome) {
      if (receipt.outcome.status !== status || receipt.outcome.connectionId !== connectionId) {
        return { returned, status: null, connectionId: null }
      }
    } else {
      receipt.outcome = { status, connectionId }
      window.sessionStorage.setItem(pendingCardKey, JSON.stringify(receipt))
    }
    return { returned, status, connectionId }
  } catch { return unbound }
}

export function googleCallbackNotice(status: string | null = singleParameter(new URLSearchParams(window.location.search), 'google')) {
  switch (status) {
    case 'failed': return 'The last Google connection wasn’t completed. You can try again.'
    case 'permissions_required': return 'Google did not grant all the requested access. Check the available permissions below.'
    case 'account_already_connected': return 'That account is already saved in Bud. Select its email to connect, upgrade or reconnect this service.'
    case 'account_mismatch': return 'Google returned a different account. Try again and choose the email you selected in Bud.'
    default: return null
  }
}
