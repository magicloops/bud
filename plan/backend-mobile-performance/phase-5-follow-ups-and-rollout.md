# Phase 5: Small Follow-ups and Rollout Closeout

**Status:** Service changes and mobile handoff implemented; coordinated deployment and native/proxy validation pending.
**Parent:** [Implementation spec](implementation-spec.md).

## Mark-read summary

Extend `POST /api/threads/:thread_id/read` to return the existing fields plus
`summary: { unseen_thread_count, updated_at }`. Reuse the same owner-filtered SQL
aggregate in the standalone summary route. Preserve attention/watermark comparison
semantics and deleted-thread filtering; avoid loading every thread into memory.

Make watermark advancement atomic under concurrent requests with an appropriate
conditional upsert/row lock, not a prior read followed by an unconditional write.
Return the actual stored watermark and whether this request advanced it. Read the
summary after that write, including for stale/idempotent requests. The timestamp
is snapshot time, not a revision or guarantee against subsequent writes.

Test out-of-order concurrent reads, equal message timestamps with the canonical ID
tie-break, stale/idempotent requests, foreign/cross-thread message IDs, and two-user
counts. Mobile/web remove the follow-up summary GET where they use the new response.
Update messages/me routes, query helpers, thread/routes/DB specs as applicable and
the auth checklist. No schema change is expected unless query evidence needs an index.

## OAuth discovery freshness

Set a documented one-hour freshness window on the controlled issuer's discovery
metadata at the actual response boundary, preserving intentional stale-error policy.
Inspect provider-generated headers and proxy behavior so an override is not silently
lost. Keep signing-key/JWKS and token-response cache policies independent.

Clients cache by issuer/environment, honor freshness and perform at most one
metadata refetch on a relevant endpoint/configuration error before surfacing it.
Do not retry credential rejection in a discovery loop. Test the actual route headers,
issuer endpoint values and recovery from changed metadata. Update auth specs and
mobile handoff; no token TTL or revocation behavior changes in this phase.

## Final acceptance and handoff

1. Run the [validation matrix](validation-checklist.md), recording commands,
   versions, migrations, environments and failures rather than checking boxes from
   unit tests alone. Compare Phase 0 workloads and quantify remaining limitations.
2. Publish final request/response and SSE fixtures for web/mobile, including errors,
   old rows, retries, checkpoint mismatch and resync. Keep protocol/spec docs aligned.
3. Record the minimum supported service, web and mobile builds for each contract.
   Deploy additive service/schema work before consumers; coordinate breaking tool
   serialization and list changes with all deployed clients. No daemon update is
   expected unless implementation expands scope through a separate decision.
4. Record temporary bridges and remove them once their named consumers upgrade.
   Preserve messages history and targeted state recovery. Verify old per-Bud stream
   use has stopped before removing its route/listeners.
5. Exercise service restart and rollback. Preserve admitted invocations, receipt
   keys and migration data; clients recover lost process-local stream epochs with
   fresh snapshots. Do not describe schema rollback as automatic data deletion.

R7, R8, durable deltas/resume and tool detail projections remain excluded. Their
reconsideration criteria are in the parent spec. Completing these phases does not
depend on implementing them.
