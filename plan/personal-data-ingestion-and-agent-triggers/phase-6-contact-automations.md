# Phase 6: Contact automations, bootstrap and client parity

Status: live delivery, bounded bootstrap, guarded activation, dispatch authority and mobile/web management implemented. Scheduling is connected behind `AUTOMATIONS_ENABLED=1`, requiring durable invocation mode; default is off. Live execution, recovery and cross-client acceptance remain open. Dependencies: phases 3, 4 and 5. Parent: [implementation spec](implementation-spec.md).

## Rules and activation

Add service-owned drafts, immutable revisions, enabled/paused state, grants, deliveries and bootstrap requests. A revision contains event kind (`contact.added` only), source filter, instruction, selected Bud/model, target policy, data grants, freshness and execution limits. New-thread and explicitly selected existing-thread policies are supported. Resolve target ownership on write and again before dispatch.

Expose shared `/api/automations` create/list/detail/update and explicit activate/pause actions, plus bounded delivery/history queries. Use optimistic revision checks; a stale client gets a conflict and canonical state. Model-assisted drafting cannot silently activate a rule. Activation presents effective instruction, data access, Bud/model, target and limits, then records the human decision. This is consent to standing work, not an added terminal restriction.

## Matching and execution

Consume durable domain-event work, not HTTP arrival or in-memory SSE. Match deterministically before invoking an LLM. In an idempotent transaction, record a delivery with rule revision, evidence IDs, causation, grants, target/model and dedupe key `(automation_id, revision, domain_event_id)`. Reserve or associate its invocation once; retry cannot create another conversation for the same delivery. New-thread allocation is idempotent and stamped with the owner.

Only incremental events published after activation are live eligible. Baseline/access-change/resync/rebuild are suppressed. Rule edits apply prospectively and do not replay history. Avoid an LLM call for every raw sample. Record suppression/expiry/failure reasons and bound attempts/daily work. Recheck active policy, ownership/grants and selected Bud/model at dispatch.

Pause prevents new starts; queued deliveries remain visible and can resume only while fresh. Provide separate cancel-pending and cancel-active choices. Revoked grants or deleted/inaccessible targets invalidate pending work. Active terminal cancellation follows the durable invocation contract and may require review for already-dispatched actions.

## Explicit existing-contact processing

`POST /api/automations/:id/bootstrap` requires a human-confirmed bounded filter/count and owner-scoped idempotency key. Freeze the source/contact revision set and a publication boundary in the same owner-serialized transaction used by activation. Materialize bootstrap membership and use bounded groups rather than an unbounded prompt; default to paginated/batched agent work, with per-contact mode explicit when needed.

For combined activate + process-existing, events at/before the captured boundary belong to the selected bootstrap snapshot; later publications belong to live matching. Capture membership before releasing the boundary lock so concurrent additions are neither skipped nor duplicated. For a later bootstrap on an already-live rule, default to excluding contacts already delivered for the requested revision/boundary; an explicit rerun gets a new request ID and clearly states that it may repeat work. Retrying the same bootstrap, relinking Contacts or rebuilding projections cannot reissue it.

Expose preview count, progress, bounded pages/groups, cancellation and individual outcomes. A historical bootstrap receipt has its own deadline; it is not rejected merely because a contact existed long ago. Updates after snapshot capture are available through queries, but do not silently change the frozen job input.

## Both-client experience

Mobile and web must both support draft/edit/activate, source/target/model/grant selection, process existing, pause/cancel, and delivery history with links to attributed transcripts. Either client can continue pending questions/permissions and see canonical results after reconnect. Only OS permission/sensor setup is mobile-only.

Show queued, waiting-for-Bud/model, waiting-for-user, expired, failed and needs-review states distinctly. Trigger inputs identify the rule, observed contact time and evidence; uncertain map annotations use phase-4 semantics. Optional APNs may point to durable results, with sensitive previews suppressed; neither automation nor approval recovery depends on push delivery.

## Acceptance

- [ ] T-series first-link suppression, incremental addition, bootstrap cutover and idempotent rerun tests pass.
- [ ] Configure on mobile/manage on web and reverse; execution succeeds with both clients closed.
- [ ] Existing-thread work queues without overwriting interactive work; new-thread retries allocate only one thread.
- [ ] Offline Bud/model waits, visibly expires and never substitutes; normal terminal tools remain available.
- [ ] Pause/revoke/delete, concurrent edits and limits are enforced server-side.

Update automation/data/agent/runtime/DB/routes specs, mobile/web feature docs, protocol docs for actual streams and auth checklist. Keep activation disabled until the full phase-5 recovery gate and both-client flows pass.

## Current integration boundary

The service connects matching, live admission and bootstrap admission to a bounded
worker. Mobile and web expose draft/edit/activation, preview/capture, receipt and
group progress, pause/cancel and conversation links. Current policy and owner
checks run at admission and dispatch; query scopes intersect the immutable rule
revision with current grants. PostgreSQL/Fastify/worker tests cover these paths.
Execution with both clients closed and opposite-client editing remain unverified.

## Historical admission implementation evidence

The entries below preserve the implementation sequence. Statements that a later
component was pending describe that entry’s time, not the current integration
boundary above. Use the [progress checklist](progress-checklist.md) for current
commands and remaining work.

The admission repository serializes on the publication owner lock, validates current grant version/scopes/history, owned targets and active source evidence, and atomically creates or selects a thread and associates one invocation. Pause defers fresh work; expiry and invalid authority produce visible terminal outcomes. Rolling 24-hour admission counts enforce owner and rule work limits. PostgreSQL fixtures verify concurrent dedupe, pause/expiry, revoked grants, bounded work and rollback of caller-owned thread/input/invocation writes. Neither matching nor admission is scheduled yet: dispatch-time policy rechecks, bootstrap, management mutations and both clients remain required.

Dispatch checkpoints now validate same-owner delivery association, immutable target/model, current grant and source lineage. Paused preflight uses retry wait; pause alone does not interrupt running work. Twelve focused executor/worker/PostgreSQL tests pass. Atomic pause versus start ordering, per-revision query bounds, management mutations, bootstrap and client flows still precede enabling scheduling.

Pause repository and final start now share the owner lock. Pause supports distinct cancel-pending/cancel-active decisions, preserving running reservations until acknowledgement. Tests verify a pause between claim and start defers execution, and pending-only cancellation leaves a started invocation intact. HTTP mutation and both-client controls remain pending; scheduling stays disabled.

Shared create, update and pause endpoints are now mounted with real PostgreSQL/Fastify ownership, conflict and retry tests. Activation remains repository-only pending UI consent and the remaining execution gates. Client authoring and bootstrap still need implementation.

Web `/automations` now provides draft authoring with owned selectors, optimistic saves, immutable uncertain-create retries, pause choices and delivery conversation links. Source inventory and invocation history projections are owner-scoped and tested against PostgreSQL. Browser/device interactions, mobile authoring, activation consent and bootstrap remain open.

Automation agent queries now enforce the rule revision scope/history ceiling intersected with current account permissions. The executor resolves its internal turn and rechecks the invocation fence after reading; stale/canceled results are withheld. Nine adapter/executor tests plus the PostgreSQL lifecycle fixture pass. Mobile authoring, activation consent, bootstrap and full execution validation remain open.

Mobile automation DTOs and list/editor/history screens are implemented against the shared APIs with owner/task guards, stable creation retry payloads and explicit pause choices. Saved model selection changes only on user choice. Simulator validation is running; activation, bootstrap, delivery-to-chat navigation and real cross-client interaction remain open.

Mobile release simulator build and three automation contract tests passed. Editor actions now reset to load before awaiting so navigation cannot resubmit a save/pause. Final incremental simulator build pending at this entry; live interaction and remaining activation/bootstrap gates are not complete.

Final incremental mobile simulator build succeeded after the navigation fix (`/tmp/bud-mobile-automation-final-build.log`). No live-device/cross-client gate is claimed by these build and DTO checks.

Shared activation endpoint and both-client consent review are implemented, gated off in server composition. Reviews display saved instruction, target/model, sources, scope/history and limits, and send explicit acknowledgement with observed rule/grant versions. Service tests cover ownership, missing consent, stale versions and capability gating; web build passed. Mobile delivery history now links through existing authenticated chat navigation. Final mobile consent DTO test run is pending at this entry. Bootstrap and real execution/client gates remain unfinished.

Final activation validation passed: service/web builds, four service route/repository tests, and all four mobile AutomationContractTests (`/tmp/bud-mobile-activation-final-tests.log`). Live cross-client consent/navigation and full execution gates remain open.

Bootstrap snapshot capture now freezes bounded membership under the owner publication lock, with stable retries, explicit rerun consent, current source/grant filters and default prior-work exclusion. Delayed matching suppresses selected contacts at or before the captured boundary. Owner-scoped receipt/member pages preserve frozen revision IDs and bind cursors to the request. Migration `0030_stormy_prima.sql` is generated, reviewed and applied locally. PostgreSQL lifecycle and metadata tests pass. Bootstrap execution, cancellation, combined activation, HTTP/client flows and integrated validation remain open.

Combined activation and bootstrap now use one database transaction/publication lock. PostgreSQL tests verify failed snapshot capture rolls back activation, concurrent retries return one receipt, and later publications remain live eligible. Shared gated POST endpoints and owner-scoped receipt/member GET endpoints are mounted; Fastify/PostgreSQL ownership and strict-body tests pass. Group execution, cancellation/preview, client controls and scheduling remain open.

Durable bootstrap groups and transactional admission are implemented. Each group freezes its evidence IDs and creates one invocation/thread with explicit historical-work attribution. Shared rolling daily budgets count both live and bootstrap invocations under the owner lock. Migration `0031_next_veda.sql` includes existing-membership backfill and is applied locally. PostgreSQL tests verify owner rejection, concurrent admission dedupe, shared budgets and one thread per group; service build and metadata checks pass. Bootstrap dispatch authority, cancellation/aggregate progress, client controls and scheduling remain pending.

Bootstrap dispatch and data-query ceilings are connected, including the final owner-locked pause/start boundary, immutable model/revision, current grant and all frozen group members. Shared cancellation endpoint cancels queued groups and requests cancellation of admitted invocations; running reservations remain until acknowledgement. Focused PostgreSQL/worker/route validation covers these boundaries. Aggregate progress, preview/client controls, pause-wide bootstrap cancellation and scheduling remain pending.

Rule pause now applies queued/active cancellation choices to bootstrap groups and associated invocations as well as live deliveries. Bootstrap progress endpoint derives effective group states/counts and bounded conversation-linked pages from canonical invocations; request cancellation is distinct from settled execution. PostgreSQL tests cover pagination, cancellation acknowledgement and queued-versus-active pause behavior. Bootstrap preview, both-client controls, scheduling and full integration gates remain pending.

Read-only preview and cross-device receipt listing are implemented. Preview shares capture filters and validates rule/grant versions for draft or active revision; it does not reserve contacts or approve work. PostgreSQL tests verify no persistence, draft non-activation, ownership and bounded list pages. Corrected the Drizzle read-only transaction option and verified build/tests. Client bootstrap controls and scheduling remain unfinished.

Web existing-contact controls are implemented: bounded source/search/count/group filters, draft/active preview, separate processing/rerun/standing-work consent, immutable uncertain-request retry, request history, group progress and cancellation with conversation links. Web build passed. Browser plugin initialization failed because its runtime imports a disallowed `node:process` module; live interaction remains unverified. Mobile bootstrap controls and scheduling remain unfinished.

Mobile bootstrap controls are implemented with shared preview/capture/history/progress/cancel APIs, owner/task guards, frozen retry payloads and separate execution/rerun/standing-work acknowledgements. Simulator build and expanded contract tests are running; live mobile/web interaction and scheduling validation remain unfinished.

Mobile Release simulator build passed with bootstrap controls. Expanded automation contract tests are running. Fixed default rerun exclusion after parent cancellation: already-admitted groups remain excluded even when their receipt is canceled, while canceled unadmitted groups can be selected later. PostgreSQL regression passes; see `debug/bootstrap-canceled-request-dedupe.md`.

Bootstrap mobile validation passed: Release simulator build and expanded AutomationContractTests (`/tmp/bud-mobile-bootstrap-tests.log`). Service cancellation/dedupe regression and service build also passed. Live mobile/web navigation, consent, account-switch and background execution validation remain open.

Automation worker and server composition are connected behind strict `AUTOMATIONS_ENABLED=1`, requiring durable invocation mode. Default remains disabled and no running environment was enabled. At most 25 serial rounds per poll service matching, live admission and bootstrap admission; failures cannot starve another queue within a round. Shutdown drains current admission before invocation/database teardown. Seven lifecycle/configuration/routes tests and a PostgreSQL publication→polling→invocation fixture pass; service build passes. Full live-model/recovery/cross-client gates remain required before integrated enablement.

## Product refinement follow-ups

[Phase 10](phase-10-automation-navigation-and-chat.md) makes Automations independent
of Contacts on both clients. [Phase 11](phase-11-agent-managed-automations.md) adds
agent-driven creation/management and one human review action. These supersede the
manual form as the primary creation experience, retaining the editor as fallback.
Shared repositories, immutable revisions, owner authorization, prospective
activation and separately approved existing-contact work remain authoritative.
One live new-thread invocation succeeded locally; see the progress checklist.
