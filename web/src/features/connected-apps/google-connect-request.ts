import { GOOGLE_SERVICES, type GoogleAccess, type GoogleService } from './google-services.ts'
export type GoogleConnectRequest = { service: GoogleService; thread_id: string; access: GoogleAccess }

/** Only canonical Google tool evidence can request consent; never parse chat text. */
export function googleConnectRequest(payload: Record<string, unknown> | null | undefined): GoogleConnectRequest | null {
  if (payload?.kind !== 'google' || !['google_search_tools', 'google_call'].includes(String(payload.tool))) return null
  const request = payload.connect_request
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const { provider, thread_id, access } = request as Record<string, unknown>
  const service = Object.keys(GOOGLE_SERVICES).find(value => provider === `google_${value}`) as GoogleService | undefined
  return service && typeof thread_id === 'string' && thread_id.length > 0 && thread_id.length <= 80 &&
    (access === 'read_only' || access === 'read_write') ? { service, thread_id, access } : null
}
