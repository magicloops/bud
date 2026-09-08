# Phase 14: Delete automations and simplify chat status

## Objective
Remove routine Queued/Preparing/Running/Completed/Canceled status strips from web
and mobile composers. Preserve actionable offline, retry, failure, expiry and
uncertain-action recovery notices, and keep cancellation available.
Add a confirmed Delete action at the bottom of each saved automation on both
clients, after delivery history.

## Ownership and API
The automation belongs to the authenticated cookie/bearer viewer. App query keys
and agent tool arguments cannot authorize deletion. `POST
/api/automations/:automationId/delete` accepts only `expected_version`.
Owner-filtered SQL resolves the rule before mutation; foreign resources return
404, missing authentication 401, stale versions 409. Existing updater and
cancellation actor columns record the human. No new owner-bearing table.

## Behavior
Under the publication/admission owner lock, transition to terminal `deleted`,
advance version, cancel queued deliveries/bootstrap groups and request active
invocation cancellation through the existing repository. Cancellation cannot undo
effects already performed; uncertain actions retain their review reservation.
Cancel pending bootstrap requests. Retain immutable revisions, execution history
and conversations. List/count/matcher queries exclude deleted rules in SQL.
Historical detail/history remain owner-readable, but no edit, activation or fresh
bootstrap can restore a deleted rule. Dispatch and running permission checkpoints
reject deleted authority. Version changes invalidate pending human reviews.
Deletion retries return the same terminal rule without repeating cancellation.

## Validation
PostgreSQL tests: ownership, stale versions, retries, cancellation, history,
no resurrection and no subsequent matching. HTTP tests: human auth and strict
version body. Client builds and focused status projection coverage. Device UI
acceptance: delete confirmation/cancel, inventory refresh, normal chat without
routine banner, recovery controls still available.

## Rollout and specs
Expand automation state check via generated migration and local reviewed push.
Deploy migration then all service workers before using Delete; do not roll back
to a service that can reactivate deleted rules. Old clients retain pause; new
clients against old services receive an unavailable route without local deletion.
No daemon wire change or daemon upgrade. Update personal-data, DB/migrations,
web route specs and mobile design documentation.

## Implementation evidence — September 7, 2026
- Implemented service deletion/cancellation, stale review transitions, SQL inventory
  and matching filters, and terminal authority checks. Migration
  `0036_magical_ken_ellis.sql` generated/reviewed and applied locally.
- Web and mobile Delete confirmations, retained historical detail and routine
  status suppression implemented. Web cancellation now uses the composer for
  queued/waiting invocations as well.
- Eleven focused service/HTTP/PostgreSQL/metadata tests passed; the expanded
  deletion regression also passed after adding pending review and quota coverage.
- Service, web and physical iPhone Debug builds passed. Updated `chat.bud.app.local`
  installed on the connected phone. Launch attempted with devicectl but denied
  because the phone was locked; manual UI acceptance remains open.
- Local service and HTTPS `/readyz` returned 200. Browser interaction validation
  remains deferred; no existing user automation was deleted during validation.
