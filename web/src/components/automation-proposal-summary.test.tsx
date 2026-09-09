import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AutomationProposalSummary } from './automation-proposal-summary.tsx'
import type { ApiAutomationProposal, ApiBootstrapProposal } from '../lib/api-types.ts'

const proposal: ApiAutomationProposal = {
  proposal_id: 'ap_review', automation_id: 'auto_rule', invocation_id: 'invocation', thread_id: 'origin',
  bud_id: 'origin-bud', call_id: 'call', draft_version: 2, grant_version: 3, version: 0,
  status: 'pending', activated_revision: null, expires_at: '2026-09-07T00:00:00Z', decided_at: null,
  created_at: '2026-09-06T00:00:00Z', updated_at: '2026-09-06T00:00:00Z',
  definition: { event_type: 'contact.added', name: 'Remember a contact', instruction: 'Write a note.\nLabel uncertain location evidence.',
    bud_id: 'target-bud', model: 'selected-model', reasoning_effort: 'high', sources: { source_ids: [] },
    target: { mode: 'new_thread' }, data_access: { scopes: ['contacts.read'], history_days: 17 },
    latest_start_seconds: 3600, max_invocations_per_day: 5 },
}

test('existing-contact review displays frozen counts, selection and explicit repeat consequences', () => {
  const { draft_version: _draft, activated_revision: _active, ...common } = proposal
  for (const exclude of [true, false]) for (const mode of ['batched', 'per_contact'] as const) {
    const bootstrap: ApiBootstrapProposal = { ...common, proposal_id: 'bp_review', kind: 'existing_contacts',
      revision: 7, member_count: 26, group_size: mode === 'batched' ? 25 : 1,
      group_count: mode === 'batched' ? 2 : 26, bootstrap_id: null,
      selection: { automation_id: 'auto_rule', expected_version: 2, sources: { source_ids: ['selected-source'] },
        search: 'Example', max_contacts: 50, mode, exclude_previously_delivered: exclude } }
    const markup = renderToStaticMarkup(createElement(AutomationProposalSummary, { proposal: bootstrap }))
    for (const text of ['26 existing contacts', 'Active revision 7', 'selected-source', 'Example', 'Maximum 50 contacts',
      'reviewed contact set is fixed', 'target-bud', 'selected-model', '5 runs per 24 hours']) assert.ok(markup.includes(text), text)
    assert.match(markup, mode === 'batched' ? /2 invocations|Up to 25 contacts/ : /26 invocations|One invocation per contact/)
    if (exclude) { assert.match(markup, /Excludes contacts already scheduled/); assert.doesNotMatch(markup, /may repeat previous actions/) }
    else { assert.match(markup, /may repeat previous actions/); assert.match(markup, /Approving explicitly allows repeat processing/) }
    assert.doesNotMatch(markup, /initial imports are not processed|When a new contact is observed/)
  }
})

test('review renders the full saved definition and execution consequences', () => {
  const markup = renderToStaticMarkup(createElement(AutomationProposalSummary, { proposal }))
  for (const text of ['Remember a contact', proposal.definition.instruction, 'target-bud', 'selected-model',
    'high reasoning', 'New conversation each time', 'All permitted contact sources', '17 days of history',
    '5 runs per 24 hours', '60 minutes', 'retired cloud models use the current default', 'initial imports are not processed']) {
    assert.ok(markup.includes(text), `Missing review information: ${text}`)
  }
  assert.doesNotMatch(markup, /checkbox|<form|<script|origin-bud/)
})

test('review preserves an explicit existing thread, selected sources and location precision', () => {
  const markup = renderToStaticMarkup(createElement(AutomationProposalSummary, { proposal: { ...proposal,
    definition: { ...proposal.definition, target: { mode: 'existing_thread', thread_id: 'chosen-thread' },
      sources: { source_ids: ['chosen-source'] }, data_access: { scopes: ['contacts.read', 'location.read'], history_days: 9 } },
  } }))
  assert.match(markup, /Another conversation: chosen-thread/)
  assert.match(markup, /chosen-source/)
  assert.match(markup, /Contacts and Location at collected precision/)
  assert.match(markup, /9 days of history/)
  assert.doesNotMatch(markup, /All permitted contact sources|New conversation each time/)
})


test('review identifies replacements, first activations and cross-thread destinations', () => {
  for (const operation of ['create', 'update', undefined] as const) {
    const markup = renderToStaticMarkup(createElement(AutomationProposalSummary, { proposal: {
      ...proposal, review_operation: operation, destination_thread_title: "Adam’s Contacts",
      definition: { ...proposal.definition, target: { mode: 'existing_thread', thread_id: 'other' } },
    } }))
    assert.match(markup, /Another conversation: Adam’s Contacts/)
    assert.ok(markup.includes(operation === 'update' ? 'Update existing automation' : operation === 'create' ? 'Create automation' : 'Review automation'))
  }
  const markup = renderToStaticMarkup(createElement(AutomationProposalSummary, { proposal: {
    ...proposal, definition: { ...proposal.definition, target: { mode: 'existing_thread', thread_id: proposal.thread_id } },
  } }))
  assert.match(markup, /This conversation/)
  assert.doesNotMatch(markup, /Another conversation/)
})


test('inherited review shows effective model and retirement warning without stale reasoning', () => {
  const markup = renderToStaticMarkup(createElement(AutomationProposalSummary, { proposal: {
    ...proposal, definition: { ...proposal.definition, model_mode: 'inherit' },
    model_resolution: { model: 'gpt-6-astra', reasoning_effort: 'medium', source: 'destination_thread', warning: 'gpt-5.5 unavailable — using gpt-6-astra' },
  } }))
  assert.match(markup, /Follows conversation\/default model and reasoning/)
  assert.match(markup, /Currently: gpt-6-astra/)
  assert.match(markup, /medium reasoning/)
  assert.match(markup, /gpt-5.5 unavailable/)
  assert.doesNotMatch(markup, /high reasoning/)
})
