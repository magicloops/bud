# Personal data ingestion and agent triggers plan

## Purpose

Implementation planning package for the agreed development slice across Bud service/web, `bud-mobile` and the standalone `bud-ingest` integration. The development implementation spans phases 1–7 and 9–14; see the progress checklist for verified slices. This directory does not describe deployed architecture.

## Files

| File | Purpose |
|---|---|
| [stop-run-follow-up.md](stop-run-follow-up.md) | Explicit Stop completion and single-action interruption recovery |
| [live-validation-handoff.md](live-validation-handoff.md) | Concrete next mobile/web/agent validation steps, current local enablement and remaining full-matrix gates |
| [immediate-permissions.md](immediate-permissions.md) | Immediate mobile/web grant saves, progress and conflict recovery |
| [fixture-catalog.md](fixture-catalog.md) | Shared mobile/service wire bytes, hash verification, behavioral fixture map and explicit coverage limits |
| [implementation-history.md](implementation-history.md) | Preserved chronological implementation notes; not current blocker status |
| [legacy-inventory.md](legacy-inventory.md) | Read-only standalone/local queue inventory and unmapped development-data decision |
| [contact-source-repair.md](contact-source-repair.md) | Complete-snapshot repair, preserved source/history/action identity and compatibility contract |
| [remaining-work-audit.md](remaining-work-audit.md) | Current runtime evidence, matrix coverage limits and full-plan deliverables still open |
| [app-key-handoff.md](app-key-handoff.md) | Selected backend public-key delivery, installation receipt, recovery and mixed-version contract |
| [backend-app-setup.md](backend-app-setup.md) | Standalone backend helper download, public setup metadata, private persistence, queries and recovery |
| [implemented-app-data-api.md](implemented-app-data-api.md) | Mounted human permission, scoped app-query and signed setup routes, expiry and current enablement limits |
| [implemented-contact-api.md](implemented-contact-api.md) | Current owner-scoped contact query/publication API and validation limits |
| [implementation-spec.md](implementation-spec.md) | Parent scope, fixed decisions, ownership, storage/transaction contracts, dependencies and compatibility |
| [phase-0-contracts-and-fixtures.md](phase-0-contracts-and-fixtures.md) | Phase 0: Contracts and fixtures |
| [phase-1-integrated-ingestion.md](phase-1-integrated-ingestion.md) | Phase 1: Integrated ingestion |
| [phase-2-mobile-queue-recovery.md](phase-2-mobile-queue-recovery.md) | Phase 2: Mobile identity, queue and background recovery |
| [phase-3-contacts-capture.md](phase-3-contacts-capture.md) | Phase 3: Contacts capture and scan lifecycle |
| [phase-4-projections-and-queries.md](phase-4-projections-and-queries.md) | Phase 4: Personal-data projections, APIs and agent queries |
| [phase-5-durable-agent-invocations.md](phase-5-durable-agent-invocations.md) | Phase 5: Durable agent admission and execution |
| [phase-6-contact-automations.md](phase-6-contact-automations.md) | Phase 6: Contact automations, bootstrap and client parity |
| [phase-7-approved-app-api-keys.md](phase-7-approved-app-api-keys.md) | Phase 7: Human-approved app query keys |
| [phase-8-validation-and-rollout.md](phase-8-validation-and-rollout.md) | Phase 8: Development integration and rollout |
| [phase-9-data-source-and-sync-experience.md](phase-9-data-source-and-sync-experience.md) | Phase 9: Data source navigation and truthful sync feedback |
| [phase-10-automation-navigation-and-chat.md](phase-10-automation-navigation-and-chat.md) | Phase 10: Independent automation inventory and chat integration |
| [phase-11-agent-managed-automations.md](phase-11-agent-managed-automations.md) | Phase 11: Agent proposals and durable human activation |
| [phase-13-originating-conversation-default.md](phase-13-originating-conversation-default.md) | Phase 13: Agent-created drafts default to their originating conversation, preserving explicit choices |
| [phase-12-expanded-contact-fields.md](phase-12-expanded-contact-fields.md) | Phase 12: Addresses/websites and permission-compatible enrichment |
| [phase-14-automation-deletion-and-chat-status.md](phase-14-automation-deletion-and-chat-status.md) | Phase 14: Terminal automation deletion, cancellation/history and routine chat status removal |
| [progress-checklist.md](progress-checklist.md) | Current implementation, user validation, PR checks and remaining acceptance gates |
| [validation-checklist.md](validation-checklist.md) | Service/mobile/device/concurrency/auth/key/rollout test matrix and evidence template |

## Dependencies and references

- [Agreed design and source findings](../../design/personal-data-ingestion-and-agent-triggers.md).
- [Historical review plan](../personal-data-ingestion-and-agent-triggers.md).
- [Root architecture](../../bud.spec.md), [service](../../service/service.spec.md), [agent](../../service/src/agent/agent.spec.md), [runtime](../../service/src/runtime/runtime.spec.md), [DB](../../service/src/db/db.spec.md), [web](../../web/web.spec.md).
- [Mobile TimelineCore design](../../../bud-mobile/design/initial-spec.md) and [standalone ingest contract](../../../bud-ingest/design/initial-spec.md).
- [Protocol documentation](../../docs/proto.md) and [authorization validation](../init-auth/validation-checklist.md).

## Implementation status and deferred work

The planning package now tracks application/schema implementation in the working tree; no phase acceptance gate is complete. Phase 0 records bounded engineering gates, including protected credential delivery. Phase 8 lists deliberately deferred health, geographic regions, viewer-specific broker, production retention/encryption and shipped queue disposal work. These are explicit follow-ups, not undocumented gaps in the development completion gate.

Phase status paragraphs distinguish implemented code, default-off feature flags
and remaining live acceptance. Phase 6 retains a separately labeled historical
implementation sequence; its old pending statements are not current blockers.

Update this index if phase files change, and keep parent dependencies/progress/validation synchronized as implementation lands.

September 6 feedback extends the plan with phases 9–12; their main code paths
are implemented in the working tree with live acceptance still open. Phase 8 remains the validation gate for both original and extended
scope. Photos, additional trigger types and chat-only activation authority remain
explicit follow-up decisions.

September 7 handoff: user-validated development happy paths are recorded in
[progress](progress-checklist.md); remaining acceptance and deferred deliverables
are mirrored in [TODO.md](../../TODO.md). Historical blocker notes do not override
that current status. PR preparation does not close the phase-8 rollout gate.
