# Plan: Google access for the requested task

## Context

Combine Calendar, Gmail and Drive into one PR against current main, superseding
PR180 and the former stacked PR182 diff. PR182 becomes the combined PR. The user chose a task-based OAuth card: reads request read-only
access, writes request full access, and Settings Connect requests full access.
Related specs: [Google](../service/src/google/google.spec.md),
[agent](../service/src/agent/agent.spec.md),
[database](../service/src/db/db.spec.md),
[connected apps](../web/src/features/connected-apps/connected-apps.spec.md).

## Objective

The agent presents the Google consent card for the exact access its current task
requires. Once connected, normal requested operations run without an additional
approval card. Settings can revoke each service independently.

## Design and ownership

- Discovery states required service/access; executable tools determine their own
  read/write requirement. OAuth callbacks never execute the task.
- Actual Google scopes and encrypted selected service access jointly authorize
  calls. Incremental consent cannot silently re-enable a locally revoked service.
- Owner-filtered SQL protects inventory, connect and service/account revocation.
  Browser cookie writes require a trusted Origin. Return threads and Buds are
  authorized before consent and on callback; state binds owner/session and PKCE.
- Per-service revoke stores `none` under the existing connection lock and clears
  pending OAuth state. Other services retain access; the last service revoke or
  account disconnect removes saved credentials. Upstream Google revocation stays
  separate because the client is shared with sign-in.
- Remove per-action approval persistence/UI/endpoints and global write-policy
  controls. Keep human-only invocation ownership/lease checks, fixed provider
  destinations, bounded output and no automatic retry of unknown writes.

## Specs and contracts

Update the specs above, [protocol](../docs/proto.md), API/setup docs and
[auth checklist](./init-auth/validation-checklist.md). The existing tool result
adds `connect_request.access`; service revoke adds an owner-scoped DELETE route.
No daemon message or additional table is required for access selection.

## Validation

Run service compilation, focused Google/worker tests with synthetic transport and
isolated PostgreSQL, mounted card/settings tests, and web build. Cover exact
read/full requests, partial/canceled upgrades, scope enforcement, foreign-owner
and Origin denial, revocation during pending consent/refresh, account switching
and uncertain writes. Real Google writes remain manual acceptance with test data.

## Consolidation and rollout

Preserve current main using a three-way application of the final combined diff
from common base 8dddc46b onto current main, then place the single final commit on
`prashanth/googleservices`. Keep main's migrations 0067/0068 and
regenerate the Google connection migration as `0069_google_connections.sql` using
Drizzle; never edit generated journal/snapshot metadata manually. Verify its delta
is only the additive connection table. Deploy migration before matching service/web;
no daemon upgrade. Retarget PR182 from `prashanth/googleservices` to `main` and close PR180 as superseded.
Do not merge the combined PR into main.
