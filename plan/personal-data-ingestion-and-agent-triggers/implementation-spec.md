# Implementation spec: Personal data ingestion and agent triggers

Status: phases 1–7 implemented in the working tree with partial live validation; phases 9–12 have their main code paths implemented with live acceptance open. Updated 2026-09-06. No full acceptance gate is closed.

See [live validation handoff](live-validation-handoff.md) for the next concrete
client/agent session and remaining evidence boundaries.

## Objective and authority

Connect mobile Contacts and existing location capture to owner-scoped queries, durable contact automations, and generated private apps. A user can configure or approve work in mobile, continue in web, and inspect the same results with both clients closed during execution.

This spec translates the [agreed design](../../design/personal-data-ingestion-and-agent-triggers.md) into implementation boundaries and acceptance gates. The design retains the cross-repo source review and rationale. The [original review plan](../personal-data-ingestion-and-agent-triggers.md) is historical. Track execution in the [progress checklist](progress-checklist.md); record evidence against the [validation checklist](validation-checklist.md). Check the relevant repository instructions and full source files again when implementing: source-review findings are not device-test results.

## Fixed scope

- Main Fastify API and main PostgreSQL host ingestion, queries, matching and execution records. No independent ingest service requirement.
- Observe Apple Contacts; compare with the last successfully persisted snapshot. No Apple Contacts write-back or separate contact editor. Baseline is queryable without live triggers; explicit bounded existing-contact processing is supported.
- Incremental `contact.added` is the only live event subscription initially. It means newly observed, not proven creation or a meeting. Updates and disappearance remain queryable history.
- Use available location evidence immediately. Show an uncertain, timestamped best-effort map pin or no pin. Later annotations cannot repeat completed actions.
- Preserve existing HealthKit producers and ingestion compatibility. Health projections, source-specific fixes, summaries, queries and triggers are later work.
- All agents retain normal Bud terminal access. There is no development automation tool allowlist or extra terminal approval tier. Existing owner authorization and explicit data consent remain mandatory.
- New thread per invocation and opt-in existing thread are supported. Serialize existing-thread execution with human work. Wait for the selected Bud/model; expire visibly without automatic cloud fallback.
- Agent-requested app query keys require human approval in either mobile or web. Future broker access will use the dashboard viewer's identity and consent.
- Development retains signed-out queues, strictly isolated by account/environment. Shipping disposal policy, production retention/encryption, dedicated upload credentials, geographic regions and richer offline recovery are follow-ups.

## Phases and dependency gates

| Phase | Deliverable | Dependencies | Completion gate |
|---|---|---|---|
| [0. Contracts and fixtures](phase-0-contracts-and-fixtures.md) | Shared wire fixtures, source identities, cursor and credential-handoff decisions | None | Contract/recovery cases agreed in executable fixtures |
| [1. Integrated ingestion](phase-1-integrated-ingestion.md) | Authenticated public batch route, raw events, processing jobs | 0 | Real public-origin upload, durable explicit ACK, isolated owners |
| [2. Mobile queue recovery](phase-2-mobile-queue-recovery.md) | Account-bound queues, OAuth, strict ACKs, background recovery | 0; 1 for integration | Failure injection retains or explicitly quarantines data |
| [3. Contacts capture](phase-3-contacts-capture.md) | Atomic scans/diffs and import lifecycle | 2 | Baseline/resync never masquerade as live additions |
| [4. Projections and queries](phase-4-projections-and-queries.md) | Contacts/history/location, shared query authorization and tools | 1; 3 for device gate | Agent and both clients read bounded, owner-scoped evidence |
| [5. Durable invocations](phase-5-durable-agent-invocations.md) | Shared human/automation admission, leases, outcomes and continuations | 0 | Restarts/concurrency cannot silently lose starts or replay uncertain actions |
| [6. Contact automations](phase-6-contact-automations.md) | Rules, bootstrap, delivery, both-client management/history | 3, 4, 5 | Closed-client live and existing-contact workflows pass |
| [7. Approved app keys](phase-7-approved-app-api-keys.md) | Durable permission cards, scoped keys, app setup and revoke | 4, 5; credential handoff gate in 0 | Approve across clients, query from private app, revoke |
| [8. Development rollout](phase-8-validation-and-rollout.md) | Cross-repo integration evidence and compatible rollout | 1–7 | End-to-end matrix passes; deferred work documented |

Phases 2 and 5 can be developed independently after contract work; phase 4 can use fixtures before phase 3 lands. Phase 7 need not wait for live automations, but both phases 6 and 7 are required for the requested outcome. These are reviewable implementation slices, not permission to deploy or merge.

## September 6 product refinement sequence

Preserve phase numbering and phase 8 as the cross-cutting validation/rollout gate.
The next implementation sequence is 9 → 10 → 11 → 12, while remaining phase-8
recovery, background, app-key and cross-client checks continue. This is an
extension of the existing platform, not a replacement scheduler or data store.

| Phase | Deliverable | Dependencies |
|---|---|---|
| [9. Data sources and sync feedback](phase-9-data-source-and-sync-experience.md) | Simple source settings, honest scan/upload/publication progress, troubleshooting separation | 2–4 |
| [10. Automation navigation and chat](phase-10-automation-navigation-and-chat.md) | Independent shared inventory, compact triggered-by attribution, one execution control surface | 5–6 |
| [11. Agent-managed automations](phase-11-agent-managed-automations.md) | Agent drafts/proposals, one human activation card, cross-client durable decisions | 5–6, 10 |
| [12. Expanded contact fields](phase-12-expanded-contact-fields.md) | Addresses/websites, versioned capture and field-consent migration, non-triggering enrichment | 3–4, 7 contracts, 9 |

These phases refine the existing manual client flows. Data sources and
Automations become separate destinations on mobile/web. General navigation does
not imply additional trigger types: only contact additions execute for now.
Health, geographic regions and schedules need their own future trigger contracts.
Agent drafting removes manual setup but does not confer self-approval of standing
work or data access. One human Enable automation review remains the selected
initial behavior; chat-only activation authorization is deferred. Photos and
notes remain excluded; thumbnail storage/model access requires a separate decision.

## Shared ownership and authorization

Personal data belongs to a user, independently of a Bud/thread. A mobile installation is a producer, not a daemon session. Resolve the acting viewer through existing cookie/bearer authentication; never trust envelope `actor.user_id`, query owner IDs, or client-supplied thread/Bud IDs as authorization.

| Surface | Principal and authorization boundary |
|---|---|
| Ingest / installation registration | Authenticated owner; installation and collection epoch must belong to that owner before writes |
| First-party data/rule/approval/history APIs | Viewer; SQL owner filter, ownership-aware target resolution; authorize before stream subscription/replay |
| Agent query tool | Server-derived invocation/thread owner plus active data grant; caller cannot choose a different owner |
| Worker | Stored owner plus current rule/grant/target validation before dispatch; no arbitrary service impersonation |
| App query | Dedicated key authentication plus active grant; approving owner only, query scopes only |
| Human decision/cancel | Viewer owns request/target; persist acting user as well as resource owner |

Unauthenticated first-party requests return `401`; another user's object returns `404`. List queries filter in SQL. New tables carry `tenant_id` and `created_by_user_id`, with non-null owner enforced for personal-data rows; use separate actor/initiator fields for worker activity. New IDs use ULIDs; preserve existing thread/message UUIDs and client event UUIDs. App keys cannot mint keys, approve requests, manage automations or ingest. Add each browser-facing route and stream to the [auth validation checklist](../init-auth/validation-checklist.md).

OS permission, upload consent, agent/LLM data access and app grants are distinct. A mobile permission report is diagnostic, not backend authorization. Both clients expose service-owned consent/grant state; agent tools can request but cannot approve their own access.

## Storage and transaction contracts

Names below are proposed implementation names; maintain these invariants if adapting to existing conventions.

| Records | Required identity / transaction boundary |
|---|---|
| `data_installation`, collection epoch | Owner-bound producer identity, source capabilities, revoked state and reported coverage |
| `data_event`, `data_processing_job` | Unique owner + client event ID; immutable payload hash; new raw event and processor job commit together before ACK |
| `contact_scan`, `contact`, `contact_revision` | Source identity includes installation/store/epoch; generation chain and complete manifest; current projection never ordered by HTTP arrival |
| `location_observation`, `visit`, contact annotation | Evidence references, original observation times and accuracy; annotation updates do not emit another contact-addition action |
| `data_domain_event`, matcher work | Stable source-derived ID; projection and domain-event work commit together; rebuild mode suppresses live actions |
| `data_grant` | Owner, consumer, scopes/fields/precision, bounded access and revocation |
| `automation`, immutable revision, `automation_delivery`, bootstrap request | Frozen policy/evidence; unique rule + revision + domain event; separate idempotent bootstrap identity |
| `agent_invocation`, execution attempts/continuations | Stable admission and turn IDs, one active thread reservation, durable waits/outcomes and lease fence |
| `data_access_request`, `data_api_key` | Frozen requested scope, owner decision, one grant/key per approved request, verification hash and revocation |

Use migrations and constraints to enforce uniqueness, ownership-compatible relationships and due-work indexes. No in-memory-only scheduler or SSE buffer is an execution ledger. Do not reuse the removed legacy `run` table or assume the APNs outbox already has stale-lease recovery.

Receipt publication needs commit-safe ordering: use explicit per-event work and serialized per-owner publication where a cursor is needed. A sequence allocated before transaction commit alone is insufficient. Source scan generation independently orders contact state. Agent delivery snapshots reference immutable data/rule revisions; normal context compaction must not remove the standing instruction or causation record.

## API and client contract conventions

Bud-owned fields are `snake_case`. Version new data contracts; keep the existing v1 batch envelope compatible. Query responses include bounded `items`, opaque `next_cursor` where relevant, and coverage metadata such as `last_received_at`, `latest_occurred_at`, `projection_status` and source availability. Distinguish pending import, empty results, no permission report and stale collection.

Use canonical GET responses for reconnect; SSE only hints that durable state changed. Mutation idempotency keys are owner-scoped. Mutable drafts/settings use a version or ETag with conflict responses; activating a revision and approving a grant are explicit human decisions. A card or settings view on one client must not own the only copy of its pending state.

## Implementation defaults and remaining engineering gates

The following are proposed development defaults, not new product promises: query page 50 / maximum 200; one automated invocation per Bud initially; latest start 24 hours after receipt (explicit bootstrap uses request time); at most 100 automated invocations per owner/day; worker lease 60 seconds with 15-second heartbeats. Reuse existing agent turn limits and expose effective limits in activation/review. Validate these values in phase 0; do not scatter differing constants across clients. Staleness is a latest-start deadline, not permission to interrupt an already-running command blindly.

Phase 0 must settle the exact scan manifest and publication-lock contract, selected-model availability classification, and app-secret handoff/recovery. These are bounded engineering decisions with testable gates, not reasons to reopen agreed product scope. Credential handoff must be demonstrated before calling phase 7 implementation-ready: ordinary persisted tool output or shell input logging cannot safely be called a protected secret channel.

## Documentation and compatibility

Read/update relevant [service](../../service/service.spec.md), [DB](../../service/src/db/db.spec.md), [agent](../../service/src/agent/agent.spec.md), [runtime](../../service/src/runtime/runtime.spec.md), [routes](../../service/src/routes/routes.spec.md), [auth](../../service/src/auth/auth.spec.md), and [web](../../web/web.spec.md) specs when implementing; add child specs for new data/automation folders. Update [protocol docs](../../docs/proto.md) for new SSE or wire shapes, migration specs for schema changes, and mobile TimelineCore/app plans in the sibling repo. No architecture description should claim these features exist before its phase lands.

The default path adds no Bud↔service protocol messages. New service/old daemon uses existing terminal capabilities; old service/new daemon retains existing behavior. Any new secret-handoff device operation requires its own capability gate, old-daemon fallback and both mixed-version tests. Mobile/service capabilities are additive: old envelopes remain ingestible, unsupported new clients retain queues, and projection rebuilds do not replay automations.
