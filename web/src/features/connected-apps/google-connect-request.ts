import { GOOGLE_SERVICES, type GoogleAccess, type GoogleService } from './google-services.ts'
export type GoogleConnectRequest = { service: GoogleService; thread_id: string; access: GoogleAccess; connection_id?: string; add_account?: true }

/** Only canonical Google tool evidence can request consent; never parse chat text. */
export function googleConnectRequest(payload: Record<string, unknown> | null | undefined): GoogleConnectRequest | null {
  if (payload?.kind !== 'google' || !['google_search_tools', 'google_call'].includes(String(payload.tool))) return null
  const request = payload.connect_request
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const { provider, thread_id, access, connection_id, add_account } = request as Record<string, unknown>
  if (connection_id !== undefined && (typeof connection_id !== 'string' || !connection_id.trim() || connection_id.length > 80)) return null
  if (add_account !== undefined && (add_account !== true || connection_id !== undefined)) return null
  const service = Object.keys(GOOGLE_SERVICES).find(value => provider === `google_${value}`) as GoogleService | undefined
  return service && typeof thread_id === 'string' && thread_id.length > 0 && thread_id.length <= 80 &&
    (access === 'read_only' || access === 'read_write')
    ? { service, thread_id, access, ...(connection_id ? { connection_id } : {}), ...(add_account ? { add_account } : {}) } : null
}
