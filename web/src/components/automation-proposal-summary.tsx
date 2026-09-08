import type { ApiAutomationProposal, ApiBootstrapProposal } from '@/lib/api-types'

export function AutomationProposalSummary({ proposal }: { proposal: ApiAutomationProposal | ApiBootstrapProposal }) {
  const definition = proposal.definition
  const bootstrap = 'kind' in proposal ? proposal : null
  return <>
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
    <dl className="space-y-2 text-sm">
      <div><dt className="font-semibold">Runs on</dt><dd>{definition.bud_id} · {definition.model} · {definition.reasoning_effort} reasoning</dd></div>
      <div><dt className="font-semibold">Conversation</dt><dd>{definition.target.mode === 'new_thread' ? 'New conversation each time' : `Existing conversation: ${definition.target.thread_id}`}</dd></div>
      <div><dt className="font-semibold">Contact sources</dt><dd>{definition.sources.source_ids.length ? definition.sources.source_ids.join(', ') : 'All permitted contact sources'}</dd></div>
      <div><dt className="font-semibold">Data access</dt><dd>{definition.data_access.scopes.map(scope => scope === 'contacts.read' ? 'Contacts' : 'Location at collected precision').join(' and ')} · {definition.data_access.history_days} days of history</dd></div>
      <div><dt className="font-semibold">Limits</dt><dd>Up to {definition.max_invocations_per_day} runs per 24 hours. Unstarted work expires after {definition.latest_start_seconds / 60} minutes. Waits for the selected Bud and model; no automatic fallback.</dd></div>
    </dl>
    <p className="text-sm text-muted-foreground">Review expires {new Date(proposal.expires_at).toLocaleString()}.</p>
  </>
}
