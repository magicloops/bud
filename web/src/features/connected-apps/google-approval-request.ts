import { GOOGLE_SERVICES, type GoogleService } from './google-services.ts'

export type GoogleApproval = {
  approval_id: string; thread_id: string; service: GoogleService; tool_name: string
  arguments_json: string; account_email: string
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed'
  expires_at: string; created_at: string; decided_at?: string
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export function parseGoogleApproval(value: unknown): GoogleApproval | null {
  if (!record(value) || typeof value.approval_id !== 'string' || !value.approval_id ||
    typeof value.thread_id !== 'string' || !value.thread_id || typeof value.service !== 'string' ||
    !Object.hasOwn(GOOGLE_SERVICES, value.service) || typeof value.tool_name !== 'string' ||
    typeof value.arguments_json !== 'string' || typeof value.account_email !== 'string' ||
    !['pending', 'approved', 'rejected', 'expired', 'consumed'].includes(String(value.status)) ||
    typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at)) ||
    typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) return null
  try { if (!record(JSON.parse(value.arguments_json))) return null } catch { return null }
  return value as GoogleApproval
}

/** Pending arguments and canonical results are service-stamped tool payloads. */
export function googleApprovalRequest(payload: Record<string, unknown> | null | undefined): GoogleApproval | null {
  if (payload?.tool !== 'google_call') return null
  if (payload.kind === 'google') {
    const result = parseGoogleApproval(payload.approval_request)
    if (result) return result
  }
  const args = record(payload.args) ? payload.args : null
  return parseGoogleApproval(args?.google_approval ?? payload.google_approval)
}
