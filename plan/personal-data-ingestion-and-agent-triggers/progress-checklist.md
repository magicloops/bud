# Implementation progress

## Current handoff — September 7, 2026

The development feature is implemented through phases 1–7 and 9–14, including
agent-managed reviews, originating-conversation defaults, deletion, single-action
Stop, and the mobile viewer follow-up. Phase 8 remains the integration and rollout
gate. This is development evidence, not production acceptance.

User testing confirmed contact queries, improved Sync now feedback, agent-created
automations, automation deletion/UI cleanup, private contact-app queries, denial
of unauthenticated public access, and revocation blocking subsequent queries.
Mobile preview testing covered navigation, reduced bounce, floating controls and
the larger drag-dismiss area. The latest stable named-loading fix built and was
installed; its specific visual retest is still outstanding.

The remaining conditions of the six phase-8 demonstrations are still open:
opposite-client conflict/denial/recovery, existing-contact cutover and retry,
selected-Bud/model offline and dispatch-crash recovery, physical background and
account-switch cases, signed-in second-user isolation, complete credential-channel
audit, operational measurements, and deployment/mixed-version evidence. Passing
a happy path does not establish these conditions.

Track actionable follow-ups in [TODO.md](../../TODO.md), with exact scenarios in
[the validation matrix](validation-checklist.md). Health enhancements, regions,
the viewer-authenticated broker, production retention/encryption and shipped
queue disposal remain deliberately deferred. Keep existing HealthKit code.

Current local development has the feature flags enabled and an unlocked iPhone
has been used successfully. Earlier disabled-flag, unavailable-phone and blocked
acceptance notes below describe historical observations, not current blockers.
Browser/desktop automation tooling remains deferred; user device observations
are recorded separately from automated tests.

## Implementation and remaining gates

| Phases | Implemented | Remaining evidence |
|---|---|---|
| 0–1 | Shared contracts/fixtures, main-API ingestion, immutable dedupe and explicit ACK | Mixed-version and deployment verification |
| 2–3 | Account/environment queues, strict ACK/retry/recovery, contact snapshot/diff, first-link suppression and source repair | Physical background/lock/kill/storage/permission/account-switch matrix |
| 4 | Owner-scoped contact/history/location queries and agent grants | Full second-user and evidence-viewing matrix |
| 5–6 | Durable admission, exact-model execution, review/cancel recovery, contact rules and bounded existing-contact processing | Dispatch crash/reconnect/expiry, frozen cutover/retry and cross-client cases |
| 7 | Human-approved backend app keys, protected installation, scoped queries and revoke | Denied/interrupted setup, opposite-client review and complete secret-channel audit |
| 8 | Additive migrations, feature gates, local inventory and regression fixtures | Deployment/drain/rollback, remote legacy inventory and operational measurements |
| 9–12 | Honest sync feedback, independent Automations, agent proposals, addresses/websites and field permissions | Remaining UX/AM/CF matrix conditions, including enrichment without duplicate actions |
| 13–14 | Originating-chat default with explicit target override, automation deletion/history and compact chat status | Explicit default/override/concurrency and cancellation recovery acceptance |
| Mobile viewer | Full-screen preview, Back, Liquid Glass controls, top-edge drag, edge-to-edge background and stable named loading | Accessibility, rotation/keyboard, viewport modes and latest loading-label retest |

## Verification for PR preparation

- Service build passed. 151 selected service tests passed with PostgreSQL tests
  enabled: personal-data, invocation, automation, app-permission, startup,
  OpenAI tool schemas and conversation loading. No failures or skips.
- Web production build passed; 194 web tests passed. Vite reports its existing
  large-bundle warning.
- Local HTTPS iOS simulator build/test passed: 146 selected tests covering chat,
  auth, personal data, automation review, app permissions and viewer contracts.
- All 31 TimelineCore package tests passed.
- An additional 60 changed-route/model/restart regression tests passed.
- `pnpm db:generate` reports no schema changes beyond checked-in migrations.
- Prior physical-device builds/installations and user observations above are
  separate evidence; simulator fixtures do not prove background delivery.

Local logs: `/tmp/bud-pr-service-tests.log`, `/tmp/bud-pr-service-build.log`,
`/tmp/bud-pr-web-tests.log`, `/tmp/bud-pr-web-build.log`,
`/tmp/bud-pr-mobile-tests.log`, `/tmp/bud-pr-timeline-tests.log`.
These are local artifacts, not checked-in test reports.

## Enablement and rollout

Migrations span `0024_true_luminals.sql` through `0036_magical_ken_ellis.sql`.
Apply reviewed additive migrations before feature enablement. Staging migration
application remains unverified. `AGENT_INVOCATION_MODE=durable` enables shared
execution; `AUTOMATIONS_ENABLED=1` and `APP_DATA_KEYS_ENABLED=1` require durable
mode. Activation/existing-contact reviews have their own capability gates.
Product defaults remain off; the ignored local development environment enables
the features. Drain legacy runs before switching execution modes.

Deploy compatible service ingestion/capability discovery before mobile. Existing
terminal contracts support this slice without a daemon upgrade; mixed-version
and rollback demonstrations remain required. Preserve acknowledged events and
queues during rollback. No deployment or merge is included in PR preparation.

[Phase 8](phase-8-validation-and-rollout.md) owns the acceptance gate;
[historical implementation notes](implementation-history.md) and
[the remaining-work audit](remaining-work-audit.md) retain earlier observations.
