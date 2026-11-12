export type CalendarConnectRequest = { provider: 'google_calendar'; thread_id: string }

/** Only canonical Google tool evidence can request consent; never parse chat text. */
export function calendarConnectRequest(payload: Record<string, unknown> | null | undefined): CalendarConnectRequest | null {
  if (payload?.kind !== 'google' || !['google_search_tools', 'google_call'].includes(String(payload.tool))) return null
  const request = payload.connect_request
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const { provider, thread_id } = request as Record<string, unknown>
  return provider === 'google_calendar' && typeof thread_id === 'string' && thread_id.length > 0 && thread_id.length <= 80
    ? { provider, thread_id } : null
}
