# Phase 1: Authority contract and database

Status: implemented locally; automated checks passed; remaining acceptance below. Parent: [plan](README.md).

## Objective

Define one temporary override contract, remove durable orphaned private locks,
and make expiration/automatic return truthful in storage and agent history.

## Work

- [x] Inventory all readers/writers of resource `control_state`, `private_content`,
  control receipts, workspace control epochs, handoff kind/status and recovery tickets.
- [x] Replace persistent `paused`/`human_private` semantics with agent-default
  authority plus a nullable current override. Remove `private_content` as an
  independent sticky authority source. Retained private_content is an internal disclosure fence during cleanup; it never
  grants authority and automatic reconciliation clears it without user action.
- [x] Prefer extending `browser_resource` over a new session subsystem: override
  ID, initiating workspace, authenticated viewer binding, lease deadline and
  carrier/service lifetime binding. Exact column names are settled with the wire
  contract before code. Existing owner/tenant/resource constraints remain.
- [x] Use the DB record for service admission/compare-and-set, with a daemon-local
  monotonic lease for execution. Do not retain conflicting authoritative controller
  maps. Any in-memory coordination only serializes work or caches verified state.
- [x] Separate authority from execution readiness/transition receipt. Agent-default
  after expiry does not prove a disconnected daemon has drained old CDP work.
  Reuse existing request/epoch fields where possible; no durable manual pause.
- [x] Define idempotent end for one override, conditional renewal only before expiry,
  and rejection of input/renewal for an ended or superseded ID. Duplicate end never
  affects a newer override; an expired unknown ID grants no new authority.
- [x] Update handoff storage/result mapping to distinguish waiting on human task,
  waiting on active override, and terminal continuation reason. Automatic expiry
  has a system reason and null human-return actor; explicit end records the real
  initiating actor. No fabricated “user completed task” result.
- [x] Update browser notification triggers: acquisition/end/expiry/readiness changes
  invalidate metadata; routine renewals do not trigger image/inventory refresh storms.
- [x] Write reviewed migration/backfill for existing sticky pauses and pending waits.
  Do not blindly mark all waits successful. Reconcile old runtime fences before
  executing new agent work; cancel deleted/canceled contexts and preserve genuine
  unanswered human tasks. Do not reset profiles, sign-ins or thread content.

## Protocol deliverable

Document exact acquire/renew/end/status and daemon reconciliation shapes in
`docs/proto.md`, all Bud fields snake_case. Acquisition is explicit only. A lease
is tied to one generation, override ID and authenticated viewer; socket presence,
mobile grant renewal and ordinary inventory reads cannot acquire/renew it.

Define the shared 6s/2s constants, deadline comparison, delayed-message rejection,
service-restart policy (invalidate old overrides), and daemon boot reconciliation.
Status exposes `agent|human` authority, whether this viewer controls, and separate
runtime availability. Transitional readiness is not another ownership mode.

## Database validation and rollout

- [x] Update schema.ts, run package-local `pnpm db:push`, inspect proposed SQL.
- [x] Generate checked-in Drizzle migration with `pnpm db:generate`; include custom
  trigger/data SQL through the supported workflow, never manual journal edits.
- [x] Test fresh and upgraded schemas: FK/owner scope, new checks, same-ID renew/end
  races, newer override rejection, automatic actor stamping and notification counts.
- [x] Update DB and migration specs; record exact migration in final rollout doc.

Reviewed SQL has been applied locally; no deployed database was changed. The migration ships only in the
coordinated cutover, with old controllers/workers quiesced (Phase 5).

## Recorded evidence

See [Phase 5 implementation record](phase-5-validation-and-cutover.md#implementation-record) for commands/results and outstanding physical checks. Broader acceptance boxes above remain open where the full scenario has not been run.
