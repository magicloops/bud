import { Link } from '@tanstack/react-router'
import { useAuthSession } from '@/contexts/auth-session-context'
import { AutomationProposalReview } from '@/components/automation-proposal-review'
import type { ToolContentRendererProps } from '../types'

export function AutomationProposalContent({ payload }: ToolContentRendererProps) {
  const { currentUser } = useAuthSession()
  const proposal = payload.proposal && typeof payload.proposal === 'object' && !Array.isArray(payload.proposal)
    ? payload.proposal as Record<string, unknown> : payload
  const id = proposal.proposal_id
  if (typeof id !== 'string' || !/^(ap|bp)_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
    return <p>{typeof payload.summary === 'string' ? payload.summary : 'Automation review unavailable.'}</p>
  }
  if (!currentUser) return null
  if (proposal.status === 'pending') {
    return <AutomationProposalReview key={`${currentUser.user.id}:${id}`} id={id} />
  }
  return <div className="space-y-2">
    <p>{typeof payload.summary === 'string' ? payload.summary : 'Automation review resolved.'}</p>
    <Link className="underline" to="/automations" search={{ proposal: id }}>View automation review</Link>
  </div>
}
