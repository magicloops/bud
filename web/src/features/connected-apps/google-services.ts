export const GOOGLE_SERVICES = {
  calendar: {
    name: 'Google Calendar', shortName: 'Calendar',
    readDescription: 'Read your schedule and check availability.',
    fullDescription: 'Read your schedule and create, change or delete events.',
  },
  gmail: {
    name: 'Gmail', shortName: 'Gmail',
    readDescription: 'Search and read your mail.',
    fullDescription: 'Read mail, manage drafts and labels, and send emails.',
  },
  drive: {
    name: 'Google Drive', shortName: 'Drive',
    readDescription: 'Find and read your files.',
    fullDescription: 'Read files, create files and folders, and organize your Drive.',
  },
} as const
export type GoogleService = keyof typeof GOOGLE_SERVICES
export type GoogleAccess = 'read_only' | 'read_write'
export type GoogleAccessLevel = 'none' | GoogleAccess
export type GoogleConnection = {
  connection_id: string; email: string | null; status: string
  access: Record<GoogleService, GoogleAccessLevel>
  recovery_required?: true
} & Record<`${GoogleService}_access` | `${GoogleService}_write_access`, boolean>
export type GoogleInventory = { configured: boolean; connections: GoogleConnection[] }

export function googleAccess(connection: GoogleConnection | undefined, service: GoogleService): GoogleAccessLevel {
  return connection && ['connected', 'connecting'].includes(connection.status) ? connection.access[service] : 'none'
}

export function hasGoogleAccess(connection: GoogleConnection, service: GoogleService, requested: GoogleAccess) {
  const access = googleAccess(connection, service)
  return access === 'read_write' || (requested === 'read_only' && access === 'read_only')
}

export function googleAccessLabel(access: GoogleAccessLevel) {
  return access === 'read_write' ? 'Full access' : access === 'read_only' ? 'Read access' : 'No access'
}
