import type { ApiAutomationProposal, ApiBootstrapProposal } from '@/lib/api-types'

export function automationReviewOperation(proposal: ApiAutomationProposal | ApiBootstrapProposal) {
  if ('kind' in proposal) return 'Process existing contacts'
  return proposal.review_operation === 'update' ? 'Update existing automation'
    : proposal.review_operation === 'create' ? 'Create automation' : 'Review automation'
}

export function automationReviewDestination(proposal: ApiAutomationProposal | ApiBootstrapProposal) {
  const target = proposal.definition.target
  if (target.mode === 'new_thread') return 'New conversation each time'
  if (target.thread_id === proposal.thread_id) return 'This conversation'
  return `Another conversation: ${proposal.destination_thread_title || target.thread_id}`
}

export function AutomationProposalSummary({ proposal }: { proposal: ApiAutomationProposal | ApiBootstrapProposal }) {
  const definition = proposal.definition
  const bootstrap = 'kind' in proposal ? proposal : null
  return <>
    <p className="font-semibold">{automationReviewOperation(proposal)}</p>
    <h3 className="text-lg font-semibold">{definition.name}</h3>
    <p className="whitespace-pre-wrap">{definition.instruction}</p>
    {bootstrap ? <>
      <p>{bootstrap.member_count} existing contacts · {bootstrap.group_count} invocations · Active revision {bootstrap.revision}.</p>
      <p>{bootstrap.selection.mode === 'batched' ? `Up to ${bootstrap.group_size} contacts per invocation.` : 'One invocation per contact.'} The reviewed contact set is fixed; changed eligibility requires a new review.</p>
      <p>Selection: {bootstrap.selection.search || 'All eligible contacts'} · Maximum {bootstrap.selection.max_contacts} contacts.</p>
      <p>Selected sources: {bootstrap.selection.sources.source_ids.length ? bootstrap.selection.sources.source_ids.join(', ') : 'All permitted contact sources'}.</p>
      {bootstrap.selection.exclude_previously_delivered
        ? <p>Excludes contacts already scheduled for this revision.</p>
        : <p role="note" className="font-semibold">This may repeat previous actions. Approving explicitly allows repeat processing for this contact set.</p>}
    </> : <p>When a new contact is observed. Existing contacts and initial imports are not processed.</p>}
    {proposal.model_resolution && <p className="text-sm">Currently: {proposal.model_resolution.model} · {proposal.model_resolution.reasoning_effort} reasoning</p>}
    {proposal.model_resolution?.warning && <p className="text-sm text-amber-700">{proposal.model_resolution.warning}</p>}
    <dl className="space-y-2 text-sm">
      <div><dt className="font-semibold">Runs on</dt><dd>{definition.bud_id} · {definition.model_mode === 'inherit' ? 'Follows conversation/default model and reasoning' : `${definition.model} · ${definition.reasoning_effort} reasoning`}</dd></div>
      <div><dt className="font-semibold">Conversation</dt><dd>{automationReviewDestination(proposal)}</dd></div>
      <div><dt className="font-semibold">Contact sources</dt><dd>{definition.sources.source_ids.length ? definition.sources.source_ids.join(', ') : 'All permitted contact sources'}</dd></div>
      <div><dt className="font-semibold">Data access</dt><dd>{definition.data_access.scopes.map(scope => scope === 'contacts.read' ? 'Contacts' : 'Location at collected precision').join(' and ')} · {definition.data_access.history_days} days of history</dd></div>
      <div><dt className="font-semibold">Limits</dt><dd>Up to {definition.max_invocations_per_day} runs per 24 hours. Unstarted work expires after {definition.latest_start_seconds / 60} minutes. Waits for the selected Bud and model; retired cloud models use the current default. Offline local models do not switch to cloud.</dd></div>
    </dl>
    <p className="text-sm text-muted-foreground">Review expires {new Date(proposal.expires_at).toLocaleString()}.</p>
  </>
}
