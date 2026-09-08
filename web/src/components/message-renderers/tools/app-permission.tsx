import { Link } from '@tanstack/react-router'
import { useAuthSession } from '@/contexts/auth-session-context'
import { AppDataPermissions } from '@/components/app-data-permissions'
import type { ToolContentRendererProps } from '../types'

export function AppPermissionContent({ payload }: ToolContentRendererProps) {
  const { currentUser } = useAuthSession()
  const request = payload.request && typeof payload.request === 'object' ? payload.request as Record<string, unknown> : payload
  const id = request.request_id
  if (!currentUser || typeof id !== 'string' || !/^dar_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return <p>{typeof payload.summary === 'string' ? payload.summary : 'Data permission request unavailable.'}</p>
  if (request.status === 'pending') return <div className="settings-surface"><AppDataPermissions key={`${currentUser.user.id}:${id}`} requestId={id} inline /></div>
  return <div className="space-y-2"><p>{typeof payload.summary === 'string' ? payload.summary : `Data access ${request.status ?? 'resolved'}.`}</p><Link to="/data" search={{ request: id }}>View permission</Link></div>
}
