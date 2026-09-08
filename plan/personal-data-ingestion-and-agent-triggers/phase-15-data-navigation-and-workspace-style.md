# Phase 15: Data navigation, chat context and workspace styling

Status: implemented September 8; automated checks pass, visual/live acceptance remains open.
Parent: [implementation spec](implementation-spec.md). Follows phases 9, 10 and 14.
Companion: [phase 16 inline decisions](phase-16-inline-permission-and-automation-decisions.md).

## Context and objective

Settings uses oversized cards, repeated 4px borders and 6–12px offset shadows,
while Data sources and Automations use unrelated plain bordered controls.
`web/src/routes/data.tsx` also combines collection status, permissions and the
entire contact browser. Its App data access disclosure nests another titled card.
The chat has attribution for completed triggers but no useful inventory of rules
targeting that conversation or access available to the agent.

Make these surfaces feel like the current workspace: compact, recognizable Bud
styling, scannable management lists and direct navigation from the conversation.
Keep managing collection/access separate from browsing actual personal records.

## Presentation decisions

- Use the current workspace's colors, typography, controls and spacing as the
  reference. Retain restrained neobrutalist character: modest corner radii,
  strong hierarchy, selective 2px borders/small offset shadows and Bud accents.
  Remove oversized nested cards, heavy repeated shadows and paragraph-sized
  headings from Settings. Do not apply the old Settings style to the new pages.
- Share page header, navigation, section, row and action styles across Settings,
  Data sources, data browsing and Automations. Use existing theme tokens and
  button primitives; introduce only the small shared variants this work needs.
- Match dark mode and narrow layouts. A compact row may wrap on a small viewport;
  do not force horizontal scrolling, truncate essential consent or shrink targets.
- Keep automation deletion at the bottom of its detail view and retain history.

## Information architecture

| Surface | Contents |
|---|---|
| Settings | Account/provider/session settings and consistent links to Data and Automations |
| Data sources | Collection/source status, last received data, agent access, app access and collapsed troubleshooting |
| Browse data | Type navigation with Contacts as the first implemented browser; contact search/detail/history moves here |
| Automations | Independent inventory and review/activity/detail routes, with Bud and conversation context filters |

Suggested routing: preserve `/data` for source management and existing
`/data?request=...` permission links; add `/data/contacts` for contact browsing.
Provide Sources/Browse data navigation within the data area. Reserve a reusable
type-navigation model for Location, Health and Photos without claiming those
browsers or collection features are available. Only show supported working
destinations, or clearly labeled unavailable entries with no fake content.
Existing contact location evidence remains with contact detail.

Source rows show availability/last receipt and a View data action. They do not
embed contact records. Server receipts must not imply the source phone is online
or that web refresh performs a device scan. Collection is controlled by the phone;
agent permission and app permission remain separate concepts.

## Compact app access inventory

One App data access heading owns the list. Each collapsed row contains app title,
canonical access status, optional last-used time and Revoke when applicable.
Provide a disclosure affordance and, when resolvable through authorized site
metadata, an Open app link. Do not construct a public link from an internal ID.

Expanded content contains purpose, scopes/fields, history, location precision,
destination, installation identity and requesting conversation. Pending rows use
the compact decision component from phase 16. Group active/pending access ahead
of historical outcomes while preserving pagination and exact-request links.
Derive displayed access status from request AND key state: approved does not mean
installed, and a revoked key must never appear as active access.

Expansion, Open app and Revoke are separate accessible controls; do not nest
buttons inside a clickable button row or let revocation toggle expansion.

## Context from a chat

Add compact Automations and Data access controls in the conversation header or
its existing contextual menu, outside the composer. Open a lightweight panel with
links to the full management pages and a route back to the same conversation.

- Automations defaults to active rules whose saved execution target is this
  conversation. Offer paused/draft visibility and a separate All for this Bud
  scope. Rules merely created in this chat, but targeting new conversations,
  must not count as enabled here. Attribution/history alone is not inventory.
- Show saved active revision separately from unsaved/draft targets and display
  unavailable/loading states distinctly from zero rules.
- Data access shows source availability and the agent's effective account grant,
  including denied/partial field coverage. Label it “Applies to your Bud agents”:
  today's `agent_data_grant` is owner-wide, not per-Bud or per-thread.
- App grants remain attached to their named backend, not interchangeable with
  agent access. A chat shortcut must not silently widen either grant.

## Ownership, APIs and compatibility

Viewer comes from the authenticated session. Authorize the Bud/thread before any
context read; personal sources/grants remain owned by that viewer. Any new rule
filters or counts must apply owner AND Bud/active-target predicates in SQL before
pagination. Never derive a count from only the first inventory page or fetch
unowned global rows for client filtering. Keep snake_case API fields.

Prefer existing APIs for existing lists/details. If context filtering/summary
needs additive endpoints, document exact shapes in protocol/route specs and add
foreign-user checks to the auth checklist before implementation. This phase does
not introduce per-Bud data grants or a new ownership hierarchy. No new table is
expected; if needed, specify owner/actor stamps and migration first.

Older clients retain existing routes; preserve exact review links. New clients
show a clear unavailable context state against older servers. No daemon changes.

## Implementation and spec updates

1. Extract restrained shared page/list/action presentation and apply to Settings.
2. Split source management from contact browsing; preserve existing deep links.
3. Replace verbose app cards with expandable compact rows.
4. Add owner-scoped chat context queries/filters as needed, then header panels.
5. Apply shared presentation to Automations and phase-16 decision components.

Read/update `web/src/routes/routes.spec.md`, the Bud route spec, components/UI and
workbench specs, API type specs and affected service personal-data/route specs.
Update mobile navigation docs if its source/browser hierarchy is changed for
parity. Phase 16 owns mobile inline review implementation.

## Acceptance

- [ ] Settings, Data sources and Automations visibly match the current workspace
  in light/dark and narrow/desktop layouts, with keyboard focus and usable targets.
- [ ] App data access has one heading; multiple apps are quickly scannable and
  expand independently. Revoked/pending/installing states remain truthful.
- [ ] Contacts have their own browser destination; management does not load or
  render the contact inventory unnecessarily. Existing request links still work.
- [ ] Chat shows correct active-target rules, owner-wide grant scope and unknown
  states; switching Bud/thread/account cannot retain another context's results.
- [ ] Filter/pagination/count tests and two-user authorization tests cover any
  new API; browser navigation/back, expansion and mutation interactions pass.

Visual layout is verified in the browser; source-string tests are not acceptance.
Existing phase-8 recovery/rollout gates remain open. This document adds scope to
the working plan and does not commit, push or change the existing draft PRs.


## Implemented contract and verification

`GET /api/automations?bud_id=<id>&thread_id=<id>&state=enabled`
accepts optional Bud, conversation and enabled/paused/draft state. A conversation
requires a Bud. Unknown keys return 400. Authentication precedes repository
dispatch; a foreign/missing Bud or conversation returns 404. SQL first applies
owner, nondeleted state and active-definition target predicates, then the existing
100-rule owner bound. No pagination/count inferred from client subsets is added.
A rule without an active revision is filtered by its draft.

The response retains `items` and existing rule fields and adds
`context_filter: true` plus `active: { revision, definition } | null` per rule.
New web clients withhold filtered results from older servers without that marker.
Older clients ignore additive fields. No database migration, daemon update,
SSE change or service/daemon deployment ordering requirement.

Management pages share scoped styling/navigation; `/data/contacts` owns browsing.
App rows expand independently; pending and active entries precede historical
entries within the current server page, preserving its cursor. No Open app URL
is fabricated from a site ID. Chat context and full inventory use server filters.

Validation: web production build, 195 unit tests, 3 render tests and focused lint;
service build, route fixtures and PostgreSQL active-target/two-owner tests.
Browser skill setup returned no available browsers on September 8; desktop,
narrow-screen, light/dark, keyboard and interaction acceptance remains unchecked.
