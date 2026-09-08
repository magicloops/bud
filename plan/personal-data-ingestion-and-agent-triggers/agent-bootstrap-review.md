# Agent-requested existing-contact review

Implements the separate existing-contact operation required by [phase 11](phase-11-agent-managed-automations.md). Status: frozen review storage, revalidation, human routes, durable continuation and agent tool implemented. Startup enablement, thread-state recovery, web/mobile review and live acceptance remain pending.

## Scope and authority

An agent may request a bounded existing-contact review for an already activated
automation. Enabling standing work never processes existing contacts implicitly.
The request carries the automation ID, expected draft version and selection
criteria; the service resolves the active revision, current grant and owner from
the fenced human-origin invocation. Unattended invocations cannot request this
review. No agent argument supplies acknowledgement, approval or acting user.

Use `automations_request_existing_contacts` as a separate parked tool operation.
It reuses the proposal lifecycle and human decision semantics, with separate
`automation_bootstrap_proposal` storage, `bp_` IDs and human routes. Older
activation-only services must never read these records. Approval captures a bootstrap request;
it must never call automation activation. The existing manual advisory preview
and capture endpoints retain their current semantics.

## Frozen review

Under the owner publication lock, select at most 1000 currently eligible contact
revisions using the existing source/search/history/exclusion selector. Persist
the ordered revision IDs, active automation revision and definition, draft/grant
versions, publication boundary, selection and group size with the parked intent.
The count displayed to the human comes from this stored membership. Batched mode
uses groups of 25; per-contact mode uses one invocation per selected contact.
The review shows count, instruction, exact Bud/model/target, scopes/history,
start deadline, shared daily limit and whether previous actions may repeat.

The selection fingerprint covers these canonical frozen fields and ordered IDs;
it is an internal integrity/revalidation aid, never an authorization credential.
Membership IDs are owner-bound persisted evidence, not accepted in agent input.
Zero matches returns a normal no-work tool result without parking a human review.

## Decision and capture

Human decisions contain only decision, proposal version and retry key. Approval
locks the same owner row and verifies the originating reservation/intent, expiry,
draft/grant/active revision, targets, source availability and exact membership
eligibility. Changed contact revisions, revoked sources or newly excluded prior
deliveries mark the proposal stale. Do not reselect a replacement set, reduce the
count, activate a draft or broaden access on approval. Unrelated new contacts do
not invalidate the frozen selection or join it.

Capture the approved IDs, bootstrap receipt/members/groups and proposal decision
in one transaction; reuse transaction-scoped bootstrap capture rather than a
nested transaction or a second post-decision write. Use the approval-time owner
publication boundary for delayed live-matching suppression, and start the deadline
at approval. A proposal creation boundary is diagnostic only. Same decision retries
return the original receipt, even after members change or processing starts.

`exclude_previously_delivered: false` is a request to present an explicit repeat
warning in the typed review. The human's approval grants that exact repeat option;
the agent cannot forge the manual endpoint's acknowledgement fields. Review
cancellation and decline start no work. Once approved, stopping work uses the
existing bootstrap cancellation path and cannot undo completed actions.

## Implementation and evidence required

- Add separate proposal storage with bounded frozen bootstrap payload and relational
  membership, preserving existing activation rows and mixed-version fail-closed handling.
  Generate/apply a reviewed migration; keep proposal decision receipts immutable.
- Refactor shared snapshot selection/capture into transaction-scoped operations;
  preserve manual endpoint behavior and publication/delivery deduplication.
- Connect the separate tool, parked continuation, owner-only proposal serializers,
  web/mobile shared review and bootstrap receipt/history links. Old clients must
  not render a bootstrap proposal as an activation approval.
- Test cross-owner/origin rejection, count/ID immutability, changed membership,
  concurrent live delivery, repeated actions, decision replay, rollback after
  group creation, cancellation, expiry and restart continuation.
- Demonstrate an opposite-client approval yielding exactly the reviewed members
  and no second activation. Keep this gate separate from activation-review tests.

Impacted specs: personal-data, agent, DB/migrations, protocol, web DTO/renderers,
mobile automation review plan and shared validation checklist. No daemon change.

## Capture transaction foundation

`AutomationBootstrap.captureInTransaction` now shares the caller's transaction;
manual standalone and combined activation capture delegate to this same operation.
The PostgreSQL contact/automation fixture passes with an injected failure after
member/group creation, proving that a failed enclosing decision write can leave
zero queued bootstrap work. Existing retry/publication/cancellation/admission
assertions also pass (`/tmp/bud-bootstrap-transaction-tests.log`). This establishes
atomic composition only; frozen membership and human review are not connected yet.

Frozen membership follow-up: internal freeze/capture operations now bind the
ordered selected contact revisions, active definition/revision, draft/grant
versions and creation boundary. Capture filters the eligibility query to those
IDs, rejects membership changes, and writes the approval-time publication boundary.
Accepted retries return the original receipt before current eligibility checks.
The PostgreSQL fixture covers missing/foreign owner, hidden-member staleness,
exact membership, receipt replay and transaction rollback. Strict internal payload
validation bounds and deduplicates revision IDs. Proposal persistence, fingerprint,
target revalidation in the human decision, zero-match handling, continuation and
UI integration remain pending; no new agent tool is exposed by these methods.

Storage follow-up: migration `0034_bored_butterfly.sql` adds separate bootstrap
proposal and ordered membership tables. Composite owner FKs bind the active rule
revision, invocation context, action, contacts and resulting bootstrap receipt;
state checks require complete human attribution and a receipt for approval. The
storage fixture executes the generated SQL in a rolled-back isolated schema and
tests ownership, member/call dedupe, bounds and decision invariants. Applied locally
in one transaction after canceling db:push's unrelated invocation constraint
prompt. No deployment. Repository transitions, same-rule receipt validation,
continuations and routes remain pending. Keeping storage/routes separate is a
deliberate refinement of the initial shared-kind idea: older activation code has
no opportunity to interpret a new proposal as authority to enable a rule.

Repository follow-up: `AutomationBootstrapProposals` now creates reviews only from
current fenced human-origin tool intents, persists canonical fingerprints and
ordered relational members, and returns no work for empty selections. Typed owner
decisions check the live reservation/action, expiry, versions, evidence integrity
and exact targets before atomic reviewed capture. The stored bootstrap receipt
survives concurrent decisions and retries; decline/cancel/expiry never activate or
capture. Lost action authority cancels a review. The isolated PostgreSQL repository
fixture passes, including a forced decision-write failure after capture proving
rollback, while the service build passes. Runner parking/continuation, HTTP routes,
maintenance scheduling, client review and live acceptance remain to connect.
Evidence: `/tmp/bud-bootstrap-proposal-repository-tests.log` and
`/tmp/bud-bootstrap-proposal-repository-build.log`.

HTTP follow-up: separate `/api/automations/existing-contact-proposals` routes now
provide owner-only inventory/detail/decision/cancel with human bearer/cookie
authentication, no-store and 4 KiB decision limits. Mounted approval and
`features.existing_contact_reviews` require the dedicated composition option plus
enabled automation execution and proposals. The production caller leaves this
option off. Decline/cancel and bounded service-owned expiry remain available;
shutdown drains expiry through the shared personal-data stop handle. Route and
maintenance tests pass (`/tmp/bud-bootstrap-proposal-routes-tests.log`). Startup
enablement, runner parking/continuation and both client UIs remain pending.

Invocation follow-up: repository parking now commits the proposal, frozen members,
waiting action and reservation/lease transition together. No-match requests retain
their running lease. Terminal decisions become claimable after restart and resume
the same turn/client tool ID with one canonical result; trailing undispatched calls
are deferred. Cancellation and abandonment close pending reviews. The fixture
checks injected parking failure, pending recovery, approval, model wait reservation,
ledger dedupe and cancellation before approval. Worker/agent-loop hooks and tools,
thread-state exposure, startup readiness and both clients remain pending.
Validation: `/tmp/bud-bootstrap-continuation-tests.log` and
`/tmp/bud-bootstrap-continuation-build.log`.

Agent-loop follow-up: `automations_request_existing_contacts` now has a strict
selection-only schema and separate opt-in catalog capability. AgentService also
requires its explicit setting and durable bootstrap hook. The worker pauses
renewal for atomic parking and resumes it for no-work or known validation errors.
The loop emits only committed public proposals and returns without dispatching
trailing calls. Empty selections and validation failures persist one ordinary
tool result using the original intent, then continue the model loop. Canonical
replay preserves the saved selection and exact decision without treating it as
activation arguments. Startup still leaves the capability disabled.

Worker/executor, catalog/parser, loop and replay tests pass in
`/tmp/bud-bootstrap-agent-tests.log`; build evidence is
`/tmp/bud-bootstrap-agent-build.log`. These are mocked agent-flow and worker tests;
opposite-client approval and real provider execution remain acceptance gates.

Thread recovery follow-up: durable agent state now exposes owner-only
`pending_bootstrap_requests`, including when issuance is disabled. The web DTO,
lifecycle revision and transcript overlay recover the original client identity,
clear resolved reviews and preserve canonical results over stale snapshots. Both
review kinds stay outside collapsed work. Route and web recovery tests pass in
`/tmp/bud-bootstrap-thread-state-tests.log` and
`/tmp/bud-bootstrap-web-recovery-tests.log`. Web review controls, live SSE handling,
mobile recovery/review and startup enablement remain pending.

Web review follow-up: the shared review component now supports the separate
existing-contact endpoint/capability, checks returned identity/kind, shows the
frozen counts/selection and repeat warning, and preserves immutable decision
retries. Both kinds appear in the owner-keyed Automations inventory with exact
review links. Chat renders pending reviews and handles their committed SSE event;
no-work calls do not enter waiting state. Summary render tests pass in
`/tmp/bud-bootstrap-review-render-tests.log`; web build evidence is
`/tmp/bud-bootstrap-web-review-final-build.log`. Interactive browser verification,
mobile integration, startup readiness and opposite-client live approval remain.

Startup follow-up: strict `AUTOMATION_EXISTING_CONTACT_REVIEWS_ENABLED=0|1`
(default 0) now composes the agent and human approval capability together. It
requires enabled automation proposals and durable automations. Every durable
startup verifies both proposal schemas, including bootstrap membership, before
starting workers; disabling issuance preserves recovery and therefore does not
remove the schema requirement. Isolated PostgreSQL startup tests pass in
`/tmp/bud-bootstrap-startup-tests.log`, with build evidence in
`/tmp/bud-bootstrap-startup-build.log`. The environment is unchanged; mobile and
interactive/cross-client acceptance remain before enablement.

Mobile model foundation: separate bootstrap selection/proposal/snapshot DTOs now
preserve exact revision, counts and repetition policy without activation fields.
Capability and unknown-kind handling are explicit. Review UI and chat/store
integration remain pending; model tests use the iOS simulator and do not prove
live opposite-client approval.

Mobile integration follow-up: the shared review entry point now opens a dedicated
bootstrap review with frozen counts/selection and repeat warning, separate human
endpoint/capability and immutable decision retries. Both kinds appear in the
pending inventory. DTO mapping and store recovery preserve the original tool
identity, clear resolved prompts and protect completed results. Saved bootstrap
results remain outside collapsed work and link to the exact review. Combined
simulator tests are recorded in `/tmp/bud-mobile-bootstrap-recovery-tests-rerun.log`;
physical installation and interactive cross-client acceptance remain outstanding.

Live-test preflight (2026-09-06): local `/healthz` responded successfully; CoreDevice
listed the iPhone as unavailable. Browser skill setup failed while importing its
runtime (`Importing module "node:process" is not allowed in node_repl`), before any
tab inspection. No browser UI or physical-device acceptance is claimed. The user
was asked to reconnect/unlock the phone while phase-12 implementation continues.
