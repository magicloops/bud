# Plan: Google connection concurrency without a lease

Status: built 2026-11-14 on `google-connection-concurrency`. See "As built" at the end.

## Context

- Design and options: [design/google-connection-concurrency.md](../design/google-connection-concurrency.md)
  (option B, chosen 2026-11-14).
- Stacked on PR #182 (`prashanth/googleservices` at `3b8fb7c`) and merged into it before
  #182 merges. Branch: `google-connection-concurrency`, PR base `prashanth/googleservices`.
- Related spec files: `service/src/google/google.spec.md`, `service/src/db/db.spec.md`,
  `service/drizzle/migrations/migrations.spec.md`.
- Code: `service/src/google/connections.ts` (all of the change), `credentials.ts` (one
  field), `service/src/db/schema.ts` (one column). `agent-executor.ts`, `routes.ts`,
  `oauth.ts`, `http.ts` and the web app are not changed.

## Objective

Calls for one Google account stop waiting on each other, and nothing waits on another
path's network work. The 50-second operation lease, its polling and its deadline checks
are removed.

Acceptance:

1. Two calls for the same account run at the same time.
2. Disconnect and revoke return without waiting for an in-flight call, and that call sends
   no further request to Google.
3. The OAuth callback doesn't wait for an in-flight call.
4. Several calls that find the access token expiring cause one refresh.
5. No database connection, transaction or row lock is held during a request to Google.
   (Already true at `3b8fb7c`; must stay true.)
6. A write Google confirmed is never reported as "outcome unknown" because of
   bookkeeping after the response.
7. Existing behaviour is unchanged: callback binding and replay protection, partial
   consent, the 401 refresh-and-retry, unknown-outcome handling for writes, unreadable
   credential recovery, the per-owner cap of four.

## Design / Approach

One refinement to the design doc's option B, found while scoping: one column, not two.
The doc proposed a `version` column for compare-and-swap writes. The encrypted blob holds
more than tokens (the PKCE verifier, the pending selections, per-service access), so a
writer that overwrites it from a stale copy could drop another path's fields even when
the swap succeeds on retry. Every write is therefore a short read-modify-write on the
current row, which makes a version unnecessary.

### The rule

No network call happens inside `edit`. Work that needs Google runs between edits, and an
edit that follows network work first checks that authorization hasn't changed.

### Pieces

1. **`grant_epoch`** (`integer not null default 0` on `google_connection`). Bumped when
   authorization changes: a completed grant, `revokeService`, `disconnect`, a move to
   `reconnect_required`, and `begin` when the OAuth client changed (it clears the tokens).
   Not bumped by a token refresh, by `begin` otherwise, or by consuming OAuth state.

2. **`edit(owner, id, change)`** becomes one short transaction: `SELECT … FOR UPDATE`
   with a local `lock_timeout` of 2 s, decrypt, `change`, save. A lock timeout maps to
   `google_busy` (retryable). The lease check, the `NOWAIT` polling loop and the
   51-second deadline go. Row locks are now only ever held for local work, so waits are
   short.

3. **`read(owner, id)`**: a plain select and decrypt, no lock. Returns the snapshot and
   its `grant_epoch`.

4. **`call`**
   - `read`, then the existing status, client and access checks.
   - If the access token is missing or expires within 60 s: `refreshShared` (below).
   - Before each request (preflight and dispatch), after the existing `beforeDispatch`
     checks: select `grant_epoch`. If it differs from the snapshot's, `read` again and
     repeat the status and access checks; continue with the new tokens only if they pass.
     This replaces the envelope comparison.
   - On a 401: `refreshShared` with the rejected access token, then one retry, as today.
   - On `google_reconnect_required`: `edit` that sets `reconnect_required`, clears the
     pending flow and bumps the epoch, skipped if the epoch already changed.
   - Timeout: the caller's signal combined with `AbortSignal.timeout(45_000)`.
     `checkDeadline` goes, including the check after Google has answered.
   - The `onDispatchChange` reporting and the per-owner cap are unchanged. The cap now
     limits calls running together, not calls queued.

5. **`refreshShared(owner, id, rejectedAccessToken?)`**: one refresh per connection per
   process (a map of in-flight promises).
   - `read`. If the row already holds a usable access token that isn't the rejected one,
     return it without calling Google.
   - Call `oauth.refresh` outside any transaction.
   - `edit`: if the epoch changed since the `read`, discard the result and fail with
     `google_connection_changed`; otherwise set the tokens (and granted scopes when the
     response carries a scope) on the current row and save. A replacement refresh token,
     if Google issues one, is saved here before any caller uses the new access token.

6. **`finish`** (OAuth callback)
   - `edit` 1: validate state, session and expiry; clear the flow; restore the previous
     status; take the verifier and selections. Remember the epoch.
   - Exchange the code outside any transaction, under a 45 s timeout.
   - `edit` 2: if the epoch changed (the user disconnected or revoked meanwhile), discard
     the grant and fail the callback. Otherwise apply the grant and bump the epoch. If a
     newer connect flow started meanwhile (status is `connecting` again), keep that flow:
     store the tokens and set its `previousStatus` to `connected`, since
     `google_connection_flow_check` forbids `connected` with flow fields set.

7. **`begin`, `disconnect`, `revokeService`**: unchanged in what they do; they run on the
   new `edit`, so they no longer wait for a call, and they bump the epoch as listed in 1.

8. **Removed**: `withLease`, `checkDeadline`, `OPERATION_MS`/`RELEASE_GRACE_MS`/`LEASE_MS`
   as lease constants, `operationExpiresAt` in `GoogleCredentials`, the envelope argument
   to `save`. A stored blob that still has `operationExpiresAt` (a developer's local
   database) is read normally and the field is dropped on the next save.

### Risks and mitigations

- **Two service instances refreshing at once.** Each would call Google; both tokens work
  as far as Google documents (design doc, "The refresh-token assumption"). Production
  runs one instance. If a second is added, add the refresh-only lease (design option C).
- **A request already sent can't be recalled.** A disconnect stops the next request, not
  the one in the air. Same as today.
- **A refresh result discarded after a revoke** costs one extra refresh later. Accepted.
- **Lock timeout under load.** `edit` can now fail with `google_busy` after 2 s if the row
  is locked that long. Nothing holds it for longer than a local decrypt and update, so
  this indicates a database problem, and the result is retryable.

## Steps

One PR. The lease is removed in a single commit so no intermediate state mixes the two
schemes.

1. Schema: add `grant_epoch` to `googleConnectionTable`; regenerate migration 0070 on the
   branch (the table is not in production; local databases take it with `pnpm db:push`).
2. `connections.ts`: `edit`, `read`, `refreshShared`, then `call`, `finish`, and the
   epoch bumps in `begin`/`disconnect`/`revokeService`; remove the lease.
3. Tests (below).
4. Specs and docs (below).

## Spec Files to Update

- [ ] `service/src/google/google.spec.md`: the three places that describe the owner lock
      or operation lease (credential clearing, the executor's "human invocation lease"
      wording where it means this lease, and service revocation).
- [ ] `service/src/db/db.spec.md`: `google_connection.grant_epoch`.
- [ ] `service/drizzle/migrations/migrations.spec.md`: 0070 includes the column.
- [ ] `design/google-connection-concurrency.md`: mark B built, with the one-column
      refinement.
- [ ] `plan/google-service-recovery.md`: its concurrency line, if it still describes the
      lease.

## Impacted Contracts

- [ ] WSS protocol: none
- [ ] SSE events: none
- [x] DB schema: one column on `google_connection`, in migration 0070
- [ ] Agent tools: none. Error codes are unchanged (`google_busy`,
      `google_operation_timed_out`, `google_connection_changed` keep their meanings)
- [ ] Web UI: none

## Test Plan

`service/src/google/connections.test.ts` (needs `BUD_DATA_DB_TEST=1` and a database with
migration 0070).

Replace the lease tests:

| Today | Becomes |
| --- | --- |
| "slow provider operations release a one-client SQL pool; a different replica can wait beyond five seconds" | A second call for the same account completes while the first is still waiting on Google, on a one-client pool. |
| "a resumed stale replica cannot send, restore credentials, or overwrite a newly connected account" | A call paused across a disconnect and reconnect sends nothing with the old tokens and writes nothing over the new grant (epoch check). |
| "a stalled PostgreSQL row lock leaves the single application pool client available" | A held row lock makes `edit` fail with `google_busy` after the lock timeout and frees the client. |
| "a valid exchange delivered after the deadline consumes its state and preserves the prior grant" | Same outcome, driven by the 45 s timeout. |

Keep, adapted where they touch the lease: the callback binding/replay/partial-consent
suite, unreadable credentials, transient refresh failures, the 401 single refresh, the
rotated refresh token, the Drive preflight cases, "pending OAuth exchange … cannot
resurrect a cleared account", the per-owner cap.

Add:

1. Disconnect during an in-flight call returns at once; the call's next request is not
   sent and the call fails with reconnect required.
2. Revoke of the service during an in-flight call: the same, with permissions required.
   Revoke of a different service: the call continues.
3. Five calls with an expired token cause one refresh request.
4. A refresh that completes after a disconnect saves nothing.
5. A refresh that completes after `begin` keeps the pending flow's verifier and state.
6. A callback that completes after a disconnect is discarded.
7. A callback that completes after a newer `begin` keeps the newer flow pending and
   stores the grant.
8. A 401 on two concurrent calls causes one forced refresh; both retry once.
9. A write confirmed by Google just before the timeout is returned as a success.

Also run: `pnpm exec tsc --noEmit`, `agent.test.ts`, `calendar.test.ts`,
`services.test.ts`, `config.test.ts`, and the full service suite once.

## Rollout

- Merged into `prashanth/googleservices`, then shipped with PR #182. No separate deploy.
- Migration 0070 as regenerated; anyone who applied the earlier 0070 locally runs
  `pnpm db:push`.
- No web or phone change, no deploy ordering beyond #182's own.

## Out of scope

- A connect card on the phone (today the agent sends phone users a link to the web chat).
- The refresh-only lease (design option C).
- More than one Google account per user.

## As built

Differences from the scope above:

- **`edit` keeps `FOR UPDATE NOWAIT` with a bounded retry** (every 50 ms for 2 s), not a
  2 s `lock_timeout`. A lock timeout would hold a pool client while waiting, which the
  existing suite guards against with a one-client pool. The outcome is the same: retryable
  `google_busy` after 2 s.
- **A changed epoch always stops the call.** The scope said a call would continue when
  access still stood after the change. It doesn't: after a disconnect and reconnect the
  account can be a different one, and the request was prepared for the old grant. The call
  reports the missing access when access is gone, and otherwise retryable
  `google_connection_changed`. So revoking Gmail during a Calendar call fails that call
  once, retryably.
- **The operation timeout is a constructor argument** (default 45 s) so the deadline test
  doesn't wait 45 s.
- **A late exchange is no longer discarded for being late.** The old test advanced the
  clock after a successful exchange and expected a timeout; with no lease there is nothing
  a late success conflicts with. The replacement test cuts the exchange off at the
  deadline.
- **Marking `reconnect_required` is best effort.** If that edit fails the error still
  reaches the caller, and the next call finds out the same way.
- `plan/google-service-recovery.md` is left as written; it records the earlier work.

Tests: `connections.test.ts` passes 20 (was 13) against a temporary schema in the local
database; the other Google suites pass 35; the full service suite passes 899 with the 54
database-gated tests skipped; `tsc --noEmit` is clean; `drizzle-kit generate` reports no
schema changes against the edited 0070 snapshot. Not run: the database-gated tests outside
`src/google`, and anything against real Google.

## Refresh lease across instances (design option C, 2026-11-14)

Added on the same branch because the service is expected to run on more than one instance.
Without it, two instances that both find the token expired each ask Google, and if Google
ever hands out a replacement refresh token to one of them the other's save could lose it.

- `refresh_lease_until` (nullable timestamp) on `google_connection`, in migration 0070.
- `refreshOnce` claims it in an `edit` before asking Google: 30 s from the database's
  clock (`now()` is read in the edit's own select, so instances agree). The token request
  is cut off at 20 s, so the lease only ever expires on an instance that died.
- An instance that finds a live lease waits, polling every 250 ms, until the tokens
  appear or the lease ends; it gives up as retryable `google_busy` after the 45 s
  operation limit. If the stored token still has five seconds of life and wasn't the one
  Google rejected, it is used at once and nothing waits.
- The holder clears the lease when it saves the tokens, when the refresh fails, and when
  its result is discarded for a changed epoch. It clears only its own lease (matched by
  value). Disconnect clears it with the credentials.
- An `edit` that changes nothing no longer writes the row (`Snapshot.unchanged`); the
  polling relies on this.
- Calls still never wait on each other. The per-process sharing of one attempt stays in
  front of the lease.

Not changed: the per-owner cap of four is still per process, so N instances allow 4N.

Tests added (two `GoogleConnections` objects on one database stand for two instances):
one refresh request for two instances; a lease left by a dead instance delays the next
refresh only until it ends; a failed refresh gives the lease back; a token with life left
is used during another instance's refresh; a call rejected with 401 during another
instance's refresh waits for that instance's token. `connections.test.ts` passes 25.
