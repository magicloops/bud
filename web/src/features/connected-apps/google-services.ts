export const GOOGLE_SERVICES = {
  calendar: { name: 'Google Calendar', description: 'View your schedule, check availability, and create or change events.' },
} as const
export type GoogleService = keyof typeof GOOGLE_SERVICES
export type GoogleAccess = 'read_only' | 'read_write'
export type GoogleWritePolicy = 'read_only' | 'ask_before_write'
export type GoogleConnection = {
  connection_id: string; email: string | null; status: string
  write_policy: Record<GoogleService, GoogleWritePolicy>
} & Record<`${GoogleService}_access` | `${GoogleService}_write_access`, boolean>
export type GoogleInventory = { configured: boolean; writes_enabled: boolean; connections: GoogleConnection[] }
export const hasGoogleAccess = (connection: GoogleConnection, service: GoogleService) =>
  ['connected', 'connecting'].includes(connection.status) && connection[`${service}_access`]

export function googleAccessLabel(access: GoogleAccess) {
  return access === 'read_only' ? 'Request read-only access' : 'Allow changes, ask first'
}
