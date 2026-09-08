# Phase 16: Compact inline permission and automation decisions

Status: implemented September 8; builds/recovery tests pass, live interaction acceptance remains open.
Parent: [implementation spec](implementation-spec.md). Follows phases 7 and 11.
Companion: [phase 15 navigation/style](phase-15-data-navigation-and-workspace-style.md).

## Context and objective

Web activation reviews already render in the transcript but embed the entire
review form. Mobile links to a separate automation review screen. App-key requests
send both clients to a full permission view; approval adds a checkbox/toggle before
the actual decision. That toggle is local UI state, not a separate server grant.

Every supported pending request should appear as one compact message in its
requesting conversation, with direct Accept/Deny actions and optional details.
The acceptance click is the explicit human decision. No extra consent toggle,
mandatory navigation, or second confirmation is required.

## Common presentation

Use the same information hierarchy on web and mobile, with platform-native
controls. Keep a short title, a concise consequential summary, action buttons and
View details. Examples are illustrative; actual text comes from the saved request:

- “Allow Contact dashboard to read contact names and emails · 30-day history?”
  Actions: Allow / Deny / View details.
- “Enable Validation contact note · new contacts · this chat · up to 5/day?”
  Add a short summary of the action and that it runs with normal Bud terminal
  access. Actions: Enable / Deny / View details.
- “Process 3 existing contacts · 1 run?” Include repeat-processing intent when
  requested. Actions: Process contacts / Deny / View details.

Use action-specific labels rather than an ambiguous universal Accept. Essential
recipient/data/action scope stays visible without opening details. A brief second
line is preferable to hiding material implications to achieve a literal one-line
layout. Model identity, history/precision and execution limits must be available;
material location access and existing-contact repeats must be explicit inline.
Long arbitrary instructions can use a concise preview with the full exact text
in details; never present an invented benign summary for an unrestricted action.

Details opens an accessible web modal or native sheet with full saved purpose,
fields/history/precision, Bud/model, target, limits and destination as appropriate.
Technical IDs/fingerprints belong in a secondary diagnostic disclosure. Dismissing
it does not approve, decline or abandon the agent invocation. The same decision
state powers chat, inventory and detail; avoid competing timers/mutation owners.

## Decision contract and lifecycle

- Load exact owner-authorized request details and capability before enabling an
  action. Transcript text/model output is not approval authority.
- Preserve request identity, expected version and idempotency key. A click sends
  the existing typed decision endpoint; no extra boolean consent field is needed
  for existing app/agent-proposed automation decisions.
- Remove the app-key consent checkbox/toggle from chat and shared details UI.
  Keep the permission summary and explicit action as the consent surface.
- Pending requests stay outside collapsed agent work, in their original transcript
  position. Resolve duplicates between tool rows, recovered state and old banners.
  A missed stream event or restart restores exactly one actionable request.
- Once resolved, replace controls with a compact Allowed/Denied/Enabled/etc.
  receipt and details link. Do not duplicate the underlying tool result or inject
  new prose into model history solely for presentation.
- Separate permission approval from key installation: “Allowed · Setting up” may
  precede “Ready.” Do not claim success before the server confirms it.
- Disable repeat clicks in flight. Unknown network outcomes retain the identical
  decision for explicit retry; a confirmed conflict/stale/expired/canceled review
  requires refresh/new review, not silently approving its changed replacement.
- Opposite-client decisions reconcile without duplicate continuation. Revocation
  and decline remain available independently of new-issuance capabilities.
- Account/thread switches cancel reads and isolate local state; backgrounding does
  not replay a mutation on reappearance. Older servers keep the detail-link
  fallback when required canonical data/capabilities are unavailable.

## Editing in the details view

“Adjust settings” is optional, not a prerequisite for acceptance. Never modify the
frozen request while submitting approval for its previous version.

Automation draft edits use the existing versioned editor and require a refreshed
proposal before enabling. Existing-contact membership/repeat changes require a
new frozen review. App-key destination or requested-policy changes require a new
request; no existing decision endpoint accepts a changed policy. First implementation
can link to the applicable editor or requesting chat with a clear “requires a new
review” explanation. If direct inline policy editing is added, design the atomic
replacement/cancellation contract as an additive service change first.

Editing the general agent grant is a separate owner-wide permission operation;
keep its existing immediate-save semantics and make its wider scope explicit.
Approving an automation does not automatically grant missing data access.

## Scope boundaries

This covers existing app-data requests, agent-proposed automation activation and
separate existing-contact processing on both clients. Collection permission is
still controlled by iOS Contacts/Location/HealthKit prompts; chat cannot accept
those on the OS's behalf. New agent tools to request a change to the owner-wide
agent grant are a separate service contract, not implied by restyling app review.

Manual automation creation/activation should reuse this presentation where the
saved review contract permits it. Do not remove separate frozen existing-contact
consent or silently start processing old contacts when enabling a rule.

## Ownership and implementation

The authenticated human owns the request, associated thread/Bud and resulting
permission. Reuse existing authorization before detail/decision reads or writes,
existing actor stamps, transactional receipts and durable continuations. New chat
state fields, if required, are additive, owner-scoped and documented in `docs/proto.md`.
No new daemon operation or credential exposure is needed. No schema change is
expected for presentation; any policy-replacement API needs a separately reviewed
schema/transaction contract before implementation.

1. Extract shared request loaders/decision state from full-page review components.
2. Build compact app/activation/existing-contact messages and optional detail UI.
3. Mount them in web/native transcripts with canonical dedupe and resolved state.
4. Reuse in management inventory; remove superseded banners and consent toggles.
5. Add only the additive state metadata required to recover exact chat placement.

Relevant files/specs: web components and tool renderers, thread projections and
Bud route specs; mobile `ChatAppPermissionPrompt`, `ChatTurnView`, proposal review,
app access view and chat state; service personal-data contracts/repositories and
agent-state serialization if changed. Update mobile approval plans and protocol/
auth checklists alongside the implementation.

## Acceptance

- [ ] On web and mobile, Allow/Enable/Deny works from a chat without navigating,
  opening details or flipping a toggle. Details preserves context and focus.
- [ ] The compact message identifies the recipient and consequential scope;
  details shows the exact version that will be approved.
- [ ] Refresh/restart/opposite-client resolution produces one request and one
  continuation, with a readable settled receipt.
- [ ] Double-click, unknown response/retry, stale version, expiry, cancellation,
  account switch and background/reappearance preserve existing decision semantics.
- [ ] Details edits cannot widen or replace an already frozen approval silently.
- [ ] Keyboard/screen-reader/large-text and narrow-screen checks pass. No keys or
  bootstrap credentials enter transcript, view state or diagnostic copy.

Run focused decision/recovery/ownership tests plus web/native interaction checks.
Prior passing fixture counts do not constitute acceptance of this new UI phase.


## Implementation and verification

Web and mobile pending app-data requests now expose Allow/Deny directly and omit
the redundant consent control. Agent-proposed automation and existing-contact
reviews expose Enable/Process contacts/Deny with consequential scope inline.
Exact details use a read-only HTML dialog or native sheet in the same controller;
closing it cannot submit. Automation edits link to the versioned editor and
require a new review. Manual bootstrap selection keeps its separate consent.

Both clients recover app requests from the existing `pending_data_requests`
contract, using original client IDs/timestamps. Canonical results take precedence
over pending overlays. Mobile retains the old details-link fallback only when
an older snapshot lacks placement identity. No new state fields or wire messages.

Request-stable cards retain uncertain decision bodies and block competing actions.
Authoritative resolution reconciles receipts; confirmed failures offer refresh.
Reads and writes remain owner/lifecycle guarded and no mutation replays on mount.

Validation: 195 web unit tests and 3 render tests pass. Local HTTPS iOS simulator
build and 21 focused permission/proposal/recovery tests pass, including new app
request cold recovery, stale runtime suppression and standalone receipt projection.
The physical app has not been rebuilt/installed in this task. Test inline decisions,
details dismissal, opposite-client resolution, lost responses, account switching
and accessibility on device; browser connection is unavailable in this session.
