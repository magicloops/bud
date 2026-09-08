# Phase 11: Agent-managed automations

Status: implementation in progress; storage, repositories, gated agent tools,
continuations and service recovery implemented. Web/mobile review views and
recovery are connected; startup opt-in wiring is implemented. Live cross-client acceptance and
separate bootstrap review remain open. Dependencies: phases 5–6; phase 10 provides the
shared management destination. Parent: [implementation spec](implementation-spec.md).

## Experience and authority

A user describes the desired automation in chat. The agent prepares the rule,
chooses defaults from the current owned Bud/model and context, and asks only for
missing choices that materially affect behavior. Present one concise review card
with Enable automation; eliminate manual Save draft/navigation/acknowledgment
steps from this path. Keep the advanced editor as a fallback.

Retain the existing explicit-human-activation decision for this phase. A natural
language request permits drafting, not silent activation. Chat-only authorization
or a broader standing management grant is a future policy decision. Agents keep
normal terminal access, but automation tools cannot grant themselves personal-data
access, impersonate a human approval, or silently broaden an active revision.
Existing account data consent and app-key consent remain distinct.

## Tool and repository boundaries

Add bounded tools for list/get/history, create/update draft, request activation
or revision approval, and pause/cancel management in response to user direction.
Finalize tool names during implementation. Reuse the existing repositories and
owner-aware services, not shell commands with copied browser credentials or a
parallel scheduler. Derive actor/owner from the thread/invocation; validate every
Bud, target thread and source through that owner. App query keys never gain
management authority.

Default to the current Bud/model without silent substitution; record the chosen
values. Default to new conversation per invocation, with explicit existing-thread
selection. Choose bounded policy defaults, surface effective limits in review,
and require additional user data permission if needed.

Do not expose an agent-callable raw activation endpoint accepting a forged
`acknowledge_standing_work: true`. Approval must arrive through an authenticated
human decision endpoint and be recorded separately from the agent proposal.
Automation-origin invocations must not autonomously create/activate recursive
standing work; reject management proposals from unattended origins initially.
Define any future delegation policy separately.

## Durable proposal and decision lifecycle

Persist an owner-bound proposal with originating thread/invocation/tool call,
exact draft version, frozen effective rule, expected grant version and decision
state. Server-side binding is authoritative; tools cannot supply the human actor.
Show the same pending proposal in chat and Automations on both clients. Approval
records the human and commits activation once. Denial/cancellation changes no
active rule. Edits, changed permissions, unavailable targets and expired proposals
require refreshed review; do not auto-rebase a person's approval onto new content.

Use owner-scoped idempotency keys and optimistic versions for tool retry and
human decisions. Recover pending proposals after service/client restart; an
opposite-client approval resumes the original tool continuation once. Reuse the
durable permission/question infrastructure where appropriate, but define a new
typed automation decision; generic question skip must never enable standing work.
Approval of a draft revision changes future work only, retaining prior runs and
the activation publication boundary.

Agent-requested processing of existing contacts remains a separately approved,
bounded preview/snapshot operation, with count, rerun semantics and limits shown.
It must not be an implicit side effect of enabling a new-contact automation.
Pause/cancel requests must state whether they affect future starts, queued runs,
or active work, and must not claim to undo completed actions.

## Implementation gates and rollout

Before schema work, specify proposal states/expiry, decision DTOs, actor stamping,
continuation integration and abandonment behavior. Add nullable tenant fields,
non-null owner bindings and foreign keys as required. Generate/apply local and
checked-in migrations for any new records. New tools/cards are capability-gated;
old clients can use the existing editor or open the shared management view, and
unknown proposals cannot accidentally approve work. No daemon wire change needed.

Update agent/tools/runtime, personal-data, DB/migration, route, web component and
mobile DTO/chat specs; update protocol and multi-user auth validation.

## Acceptance

- [ ] Chat request creates a usable reviewed proposal without manually entering identifiers.
- [ ] Approve on the opposite client; exactly one active revision and one resumed continuation.
- [ ] Deny, expiry, cancel, replay and restart cannot activate or duplicate work.
- [ ] Concurrent edits/grant changes invalidate stale approval rather than expanding authority.
- [ ] Cross-owner IDs, app keys and agent self-approval are rejected.
- [ ] Agent-managed rules appear in the same inventory/history as manually created rules.
- [ ] Existing-contact processing remains independently reviewed and deduplicated.

Validation: AM1–AM6 plus A5/T3/T7/K3 principles.

## Selected implementation contract

Use a dedicated `automation_proposal` record, separate from app-data key requests
and generic questions. Fields: ULID `id`, nullable `tenant_id`, non-null
`created_by_user_id`, originating `thread_id`, `bud_id`, `invocation_id`
and tool-call ID (the existing unique action-intent identity), automation ID, frozen automation definition, draft version,
grant version, proposal version, status, created/updated/expiry timestamps,
deciding user/time, decision idempotency key and activated revision. Composite
owner foreign keys bind the rule, thread, invocation and intent. One proposal per
originating action intent prevents tool retries from creating duplicate reviews.
Migration `0033_natural_avengers.sql` implements this storage and was applied
locally. The repository still must enforce immutable snapshots and transitions.

States: `pending` → `approved | declined | canceled | expired | stale`. Terminal
states cannot return to pending. Default expiry is 24 hours; at most 20 pending
proposals per owner and bounded inventory pages of at most 100. Expiry is checked
on reads/decisions and by service-owned maintenance, not only by a mounted card.
A stale rule/grant snapshot yields `stale`, a visible explanation and a resolved
non-approved continuation; the agent must prepare a new review. Failed target
validation never activates a rule.

Agent operations: `automations_list`, `automations_get`, `automations_history`,
`automations_create_draft`, `automations_update_draft`,
`automations_request_activation`, and `automations_pause`. All resolve the owner
and origin from the active invocation, reject automation-origin management, and
use existing repository authorization. Mutation intents must preserve frozen
arguments/idempotency through retries. Creating a draft permits omission of
settings; server defaults use the exact current Bud/model/reasoning, new thread,
all permitted sources, Contacts-only access, history no wider than current grant,
24-hour start deadline and 10 invocations per day. Explicit settings are never
silently replaced. Missing consent does not get auto-granted.

Request activation takes only automation ID and expected draft version. The
server captures the canonical definition and grant version under the owner lock,
binds the fenced tool invocation/intent, persists the proposal, and parks that
continuation. It does not call activation. Human decisions use
`{ decision: approve | decline, expected_version, idempotency_key }`; they cannot
supply a replacement definition, grant, owner or invocation. A human approval
transaction takes the same owner lock, rechecks pending/expiry/version, current
draft and grant, validates targets, calls transaction-scoped activation, stamps
the human decision/active revision and makes the parked continuation eligible
once. Retrying the identical decision returns its original outcome; conflicting
decisions do not change it. Abandoning/canceling the originating run cancels any
pending proposal and must make later approval impossible.

Expose owner-only `/api/automations/proposals` inventory/detail/decision/cancel
routes and an additive `pending_automation_requests` agent-state field. These
routes use the authenticated cookie or mobile bearer viewer, with explicit bearer
precedence; app query keys are not human authentication. SQL filters by owner
before reads, and cross-owner details return 404. Human approval and tool
availability share an additive `automation_proposals` capability requiring
durable mode and enabled automation execution. Existing manual editor remains
available; no daemon protocol upgrade is required.

The review card itself is the explicit decision: one Enable automation action,
with full saved instruction, target, scopes/history and limits available before
submission. No additional acknowledgement checkbox is needed for this typed
proposal path. Decline never changes active revisions. Existing-contact processing
is not included in activation proposals; its agent-requested preview/capture
requires a separate typed review and remains an implementation item in this phase.

`automation-proposal-contracts.ts` and four tests now establish strict payload
boundaries, exact default preservation, explicit target choices and no policy
rebasing in decision bodies. Passing these tests does not prove authorization,
transactionality, persistence or continuation behavior; those gates remain open.

Validation: four contract tests and service build passed
(`/tmp/bud-automation-proposal-contracts.log`, `/tmp/bud-proposal-contract-service-build.log`).
No proposal endpoints or agent tools are enabled by this contracts-only slice.

Storage follow-up: the checked-in migration passes an isolated PostgreSQL test
covering cross-owner rule/context rejection, missing action intent, duplicate
calls/decisions, actor and version/expiry checks, and approved revision linkage.
The schema metadata test and service build also pass
(`/tmp/bud-proposal-storage-build.log`). `db:push` was reviewed and canceled at its
unrelated invocation constraint prompt; only reviewed migration `0033` was applied
locally in one transaction. No deployment. Tools, decisions and continuations
remain unconnected.

Repository follow-up: `AutomationProposals` captures reviews only from a current
fenced human-origin invocation/action intent; duplicate calls return the frozen
proposal. Owner-locked decisions share `Automations.activateInTransaction`, so
activation and the decision receipt commit or roll back together. Draft/grant
changes mark stale reviews; expiry and abandoned/canceled originating invocations
cannot activate. Identical accepted human decisions survive retries and repository
restart, while conflicting decisions fail. Owner-scoped list/get reconcile
pending reviews and bind pagination cursors to owner/filter. The expiry method is
implemented but not scheduled yet. PostgreSQL repository tests pass, including
concurrent approval and injected failure after activation before decision storage
(`/tmp/bud-proposal-repository-tests.log`). No tool/route has exposed this flow yet;
same-transaction runner parking, durable continuation and client review remain open.

Continuation follow-up: the invocation repository now atomically parks proposal
creation with its action/reservation and reclaims resolved reviews under the same
invocation/turn. It reconstructs the original tool result once, defers trailing
undispatched calls for reconsideration, and closes pending proposals on cancel or
review abandonment. The isolated PostgreSQL lifecycle fixture passes, including
parking rollback, service-repository restart, exact model wait reservation,
decision ledger dedupe and non-approval outcomes
(`/tmp/bud-proposal-continuation-test.log`). The agent loop/worker hook, routes,
maintenance and client cards still need connection; this does not complete AM2.

Worker and HTTP follow-up: the worker exposes `parkAutomationProposal`, stops
renewal before releasing the lease and does not finalize a parked review. Eight
worker tests pass. The encapsulated `/api/automations/proposals` route module
implements owner-only list/detail/decision/cancel with bearer precedence, no-store
responses, 4 KiB decision bodies and explicit approval gating after ownership
lookup. Injection tests pass for owner forwarding, foreign/anonymous/app-key
rejection, payload limits and separate decline behavior
(`/tmp/bud-proposal-routes-test.log`). Routes are not mounted yet; shared feature
capability, agent-loop/tool integration, maintenance and client cards remain open.

Service registration follow-up: proposal inventory/detail/decision/cancel routes
are mounted beside manual automation management. `features.automation_proposals`
and approval share the same composition option plus automation-activation gate;
the production caller leaves the new option disabled. Normal registration starts
bounded proposal expiry independently of client presence and drains it through
the personal-data stop handle before pool shutdown. Mounted-route and maintenance
tests pass (`/tmp/bud-proposal-composition-tests.log`). Agent-tool exposure, startup
capability enablement and cross-client UI acceptance remain unfinished.

Agent catalog follow-up: seven canonical management schemas and strict input
parsers now cover list/get/history, create/update draft, request activation and
pause. Draft defaults remain omitted for server resolution; unknown authority
fields are rejected even when null, and pause requires explicit queued/active
cancellation choices. Three focused tests pass. Catalog registration and durable
mutation execution remain pending, so no new agent tool is available yet.

Mutation follow-up: `AutomationManagement` uses current human-origin invocation
ownership, lease/fence and matching action intent for create/update/pause. It
shares transaction-scoped `Automations` methods and stores a frozen JSON receipt
with the rule mutation. Same-lease retries return the receipt; changed arguments
conflict. Defaults preserve exact invocation selection and request bounded access
without granting permission. The isolated PostgreSQL fixture verifies defaults,
concurrent creation retries, edit/pause retries, stale fences, origin rejection
and rollback if the receipt cannot persist (`/tmp/bud-automation-management-tests.log`).
Read-tool execution, parsing/catalog registration and agent-loop dispatch remain
to connect; crash recovery conservatively retains unresolved action review.

Execution-hook follow-up: list/get/history now require a matching live human-origin
tool intent and check invocation ownership/fence before and after the query.
The worker's `executeAutomationTool` supplies immutable server execution context
and dispatches read versus mutation operations. Worker and isolated PostgreSQL
tests pass (`/tmp/bud-automation-execution-hooks-tests.log`). AgentService catalog,
parser and loop integration remain pending; no model can call these tools yet.

Agent-loop follow-up: canonical catalog resolution now has an explicit automation
option, and model-call parsing validates every automation argument. AgentService
requires its separate opt-in setting and durable hooks, records ordinary
management results through the normal transcript/ledger path, and parks activation
reviews before emitting committed metadata. The mock loop fixture verifies no
trailing execution or renewal after parking; parser/catalog and existing app
permission fixtures pass (`/tmp/bud-automation-agent-tests.log`). The service build
passes. Production composition leaves the setting disabled. Replay normalization,
agent-state recovery/contract documentation, startup gating and review cards still
need integration and verification before enablement.

Replay follow-up: recorded automation tool results now survive transcript
normalization. The loader preserves exact decision/result bytes and reconstructs
only the original request arguments during canonical fallback; provider-ledger
replay avoids duplicate tool calls. Tests cover approved, declined, expired,
canceled and stale outcomes, ordinary draft results and deferred pause calls,
alongside the existing conversation-loader suite
(`/tmp/bud-automation-replay-tests.log`). Agent-state recovery and both clients
remain unfinished; these tests do not establish live provider behavior.

State recovery follow-up: authorized thread state now exposes bounded
`pending_automation_requests`. Route tests verify owner/thread forwarding and
zero proposal reads before authentication/ownership succeeds. Web DTOs and
transcript overlays recover the original pending row without an in-memory waiter,
deduplicate refreshes and preserve completed results over stale snapshots.
Explicitly cleared durable arrays suppress obsolete runtime proposals; lifecycle
revisions include proposal identity/version/status for refresh after a decision.
Protocol and folder specs document these additive contracts. Seven service route
tests and 21 web recovery tests pass (`/tmp/bud-automation-state-tests.log`,
`/tmp/bud-automation-web-recovery-tests.log`); service build passes. Human review
cards, mobile integration and live cross-client approval remain unverified and
automation tool enablement remains off.

Web review follow-up: Automations now lists pending agent proposals and supports
an exact `proposal` URL. The shared review component reads the saved definition,
shows instructions, target, sources, data/history and execution limits, and
submits one explicit Enable automation or Decline decision. Unknown mutation
outcomes retain the original body/key; polling recovers opposite-client terminal
decisions. Owner/proposal remounts isolate local decision state. Two server-rendered
summary tests pass with the app JSX configuration. This proves displayed review
content only; interactive browser races, chat placement and mobile review remain
open. No production automation-tool enablement in this slice.

Web chat follow-up: live activation requests refresh durable state and show a
paused human-input status. The registered tool renderer mounts the same review
used by Automations in the timeline, bound to owner/proposal identity. Pending
and completed activation rows remain outside collapsed agent work; completed
rows show their canonical result and a review link without fetching all historical
reviews. Focused projection/recovery tests pass. Mobile parity and interactive
cross-client acceptance remain open; production tools remain disabled.

Mobile review follow-up: typed proposal/decision/snapshot models and an
owner-keyed exact-review view are implemented. Automations lists bounded pending
reviews, and the view displays saved instructions, target, access/history and
limits with one Enable action and separate Decline. Unknown outcomes preserve
the decision version/key; reads poll only while active, with cancellation and
owner guards. The simulator build passes. Chat timeline placement and interactive
cross-client validation remain open; see the mobile
`plan/automation-proposal-review.md` implementation note.

Mobile chat follow-up: the main state DTO/mapper now recovers a pending review
with its original client/call identity and creation time, even when runtime state
is idle. Empty durable arrays suppress stale runtime proposals. Timeline rows
resolve validated proposal IDs from live args or canonical results and link to
the shared review, outside collapsed work. Store-level polling/removal, live
event transitions and opposite-client decision acceptance remain validation gates.

Activation validation follow-up: a known rejected proposal request now records
one ordinary automation error result and completes its existing intent, allowing
the model to correct the draft in the same invocation. The worker resumes
heartbeat renewal after a rejected atomic park. Unknown transaction failures
still use conservative recovery. Twelve focused loop/worker tests and the service
build pass, with an additional timer-driven assertion confirming renewed leases.
See `debug/automation-request-validation-continuation.md`.

Mobile store recovery follow-up: visible polling detects automation-only changes
even when invocation metadata is unchanged, and retries a failed canonical page
read without advancing the applied revision. State-only refreshes remove obsolete
synthetic review rows. Canonical results take precedence over older pending
snapshots; live reviews schedule a durable refresh and remain outside running
work. Simulator store tests cover missed-event appearance/removal, read retry,
state-only removal and canonical precedence. Physical cross-client approval and
live event timing remain acceptance gates; this does not enable production tools.
See `debug/mobile-automation-review-recovery.md` and
`/tmp/bud-mobile-automation-store-tests.log`.

Startup wiring follow-up: strict `AUTOMATION_PROPOSALS_ENABLED=0|1` defaults off
and requires durable mode plus automation execution. The composition root passes
the same value to the agent catalog and human approval/capability routes. Readiness
checks the proposal schema before starting either execution worker. Five startup
tests pass, including isolated PostgreSQL missing/partial/migrated schema checks
and existing admission-mode crash/cutover coverage
(`/tmp/bud-proposal-startup-tests.log`). Environment enablement and live acceptance
are still separate gates; no local or deployed environment flag changed here.
No daemon wire change or upgrade is required.

Existing-contact review follow-up: [the implementation contract](agent-bootstrap-review.md)
now specifies a separate typed parked operation, frozen membership, active-revision
binding, stale-review rules and atomic capture/decision. Initial selection/kind
schemas and tests reject agent-supplied consent or membership and preserve explicit
repeat intent. Repository/storage, tool continuation and both review UIs remain
to implement; the current manual preview remains advisory and is not evidence of
this separate agent flow.
