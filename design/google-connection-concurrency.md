# Google connection concurrency

Status: option B built 2026-11-14 (see the plan). Written as a proposal on 2026-11-13. Applies to `service/src/google/connections.ts` on
`prashanth/googleservices` (PR #182) at `3b8fb7c`. "Today" below means that commit.

## Question

How should concurrent work on one user's Google connection be coordinated: agent calls,
token refreshes, the OAuth callback, and disconnect or revoke from Settings?

## Where the branch is today

The first version (`d51c25b`) ran each Google call inside a transaction that held
`SELECT … FOR UPDATE` on the connection row. A pooled database connection and the row
lock were held across the network calls, for up to 45 seconds.

The fix (`3b8fb7c`) no longer holds a database connection during network calls. It
replaced the lock with a lease:

- `withLease` writes `operationExpiresAt` (now + 50 s) into the encrypted credentials in
  a short transaction, runs the Google work outside any transaction, then clears the
  lease in a second write.
- Every write is compare-and-swap on the encrypted envelope, so a stale writer can't
  overwrite a newer grant or a disconnect.
- Anything else that touches the row (`edit`: another call, the OAuth callback,
  disconnect, revoke) polls every 100 ms with `FOR UPDATE NOWAIT` until the lease is
  gone, for up to 51 s, then fails with `google_busy`.
- A per-owner counter in the process allows four calls in flight or waiting.

What is left that isn't great:

1. **One call at a time per account.** A second call waits for the first, including two
   reads that have nothing to do with each other.
2. **Waiting costs database work.** Each waiter runs about ten transactions a second,
   each one decrypting the credentials, for as long as the holder runs.
3. **Disconnect and revoke wait on Google.** A click in Settings can take up to 51 s, or
   fail as busy, because an agent call is in flight.
4. **The OAuth callback waits the same way**, with the user's browser on the redirect.
5. **Lease bookkeeping can turn a success into "outcome unknown".** A write that returns
   in the last five seconds of the lease, or whose lease release fails, is reported as
   unknown although Google confirmed it.
6. **The lease is invisible.** It lives inside the encrypted blob, so it can't be seen or
   cleared from SQL, and it depends on the clocks of the service instances.

## What needs protecting

Only the connection row. Google API calls don't touch it.

| Need | Why |
| --- | --- |
| Row writes don't overwrite each other | A refresh saving new tokens must not undo a disconnect, a revoke or a new grant. |
| Disconnect and revoke take effect promptly | No request should leave the service after the user removed access. A request already sent can't be recalled under any design. |
| OAuth state is used once | A callback must not be replayed. |
| Refreshes don't pile up | Many calls finding an expired token at once should cause one refresh, not many. Efficiency, not correctness (see the assumption below). |

What does not need protecting: the calls themselves. Reads are independent. Writes carry
their own preconditions at Google (Calendar `If-Match`, the Drive version preflight) and
the executor already reports an unconfirmed write as unknown. Calls within one agent turn
are already sequential.

## Options

### A. Keep the lease, fix its edges

Leave the design and repair the list above where possible:

- Move the lease out of the encrypted blob into columns (`lease_until`, `lease_holder`),
  so waiters check it without decrypting and it can be inspected.
- Wait with backoff (100 ms growing to 1 s), or `LISTEN/NOTIFY` on release.
- Let disconnect and revoke skip the lease: they write immediately, and the holder's
  compare-and-swap then fails, which already stops it.
- Don't apply the deadline check after Google has answered, and don't let a failed lease
  release replace a result.

Result: problems 2 to 6 are reduced. Problem 1 stays: calls for one account still run one
at a time, and a slow call still makes the next one wait.

Size: small. Two columns and local changes in `edit` and `withLease`.

### B. No lease: lock-free calls with compare-and-swap (recommended)

Calls stop excluding each other. The row is protected by versioned writes alone.

- **Columns.** `version` (bumped on every write, used for compare-and-swap in place of
  the envelope comparison) and `grant_epoch` (bumped only when authorization changes: a
  new grant, a revoke, a disconnect, or a move to `reconnect_required`).
- **A call** reads the row with a plain select, decrypts, and checks status and access.
  No lock, no lease.
- **Refresh** is single-flight inside the process: calls that find the token expiring
  share one refresh per connection. The result is saved with compare-and-swap on
  `version`. A loser re-reads the row and uses the winner's token.
- **Before each request leaves**, the call re-reads `status` and `grant_epoch` (one
  indexed select, as the envelope check is today). If either changed, it stops. A
  concurrent refresh changes `version` but not `grant_epoch`, so it doesn't stop anyone.
- **Disconnect and revoke** are one short transaction that bumps `grant_epoch`. They
  never wait on Google. In-flight calls stop at their next request.
- **The OAuth callback** consumes the state in a short transaction, exchanges the code
  outside it, and saves with compare-and-swap. If the user disconnected meanwhile, the
  new grant is discarded.
- **The per-owner cap** stays as the only limit on concurrent calls.

Result: all six problems go. Unrelated calls run together. No code path waits on another
path's network work, and nothing polls. The 45 s operation deadline becomes a plain
timeout on the call.

Cost: the concurrency core of `connections.ts` is rewritten (`edit`, `withLease`,
`checkDeadline` go; `call`, `finish`, `disconnect` and `revokeService` change), and the
database tests that exercise the lease are replaced by ones for the compare-and-swap
paths. Migration 0070 gains two columns; the table is not in production yet, so the
migration can be edited in place.

Risk: two service instances can refresh the same token at once. See the assumption below.

Refined while planning (2026-11-14): one column, not two. The encrypted blob holds more
than tokens, so every write is a short read-modify-write on the current row and `version`
isn't needed; `grant_epoch` alone tells a path whether authorization changed while it was
talking to Google. See [the plan](../plan/google-connection-concurrency.md).

### C. B plus a lease on refresh only

As B, but a refresh first claims a short lease (`refresh_lease_until`, a few seconds) with
a single conditional update. Other calls keep using the current access token while it is
still valid, or wait briefly for the refresher.

Result: as B, and at most one refresh at a time across all instances.

Cost: B plus one column, one conditional update, and a short wait path. More to test.

Worth it only if the assumption below turns out false, or for a future provider that
rotates refresh tokens on every use.

### Not proposed: an in-process queue per account

A promise chain per connection in memory would replace the lease with no database work.
It still runs one call at a time, and it stops being correct with a second instance.

## The refresh-token assumption (checked 2026-11-14)

B assumes Google does not replace the refresh token when an access token is refreshed, so
two refreshes at once both succeed and both access tokens work.

Google's documentation supports this but never states it outright:

- The documented response to a refresh request has four fields: `access_token`,
  `expires_in`, `scope` and `token_type`. There is no `refresh_token`
  ([web server apps](https://developers.google.com/identity/protocols/oauth2/web-server),
  "Refresh an access token").
- "Refresh tokens are valid until the user revokes access or the refresh token expires"
  (same page).
- The listed reasons a refresh token stops working are: the user revoked access, six
  months without use, a password change with Gmail scopes, more than 100 live refresh
  tokens for the account and client, time-based access expiring, an admin restricting the
  service, and a Google Cloud session length. Refreshing is not among them
  ([OAuth 2.0 overview](https://developers.google.com/identity/protocols/oauth2),
  "Refresh token expiration").
- Neither page mentions rotation, or says anything about using one refresh token from
  several processes at once or how many access tokens can be live together.

So the assumption holds as far as the documentation goes. What is not documented is
simultaneous use, and `oauth.ts` keeps a replacement refresh token "if Google issued one",
so the code already allows for a case the documentation doesn't describe.

This is enough to build B. Production runs one instance (`render.yaml`:
`numInstances: 1`), where the in-process single-flight means one refresh at a time
regardless. With B, if a refresh ever does return a replacement token, the winner of the
compare-and-swap saves it and a loser re-reads it. The only exposure is two instances
refreshing at once *and* Google replacing the token on one of them; C closes that if a
second instance is ever added.

## Comparison

| | Today | A | B | C |
| --- | --- | --- | --- | --- |
| Database connection held during Google calls | No | No | No | No |
| Unrelated calls for one account run together | No | No | Yes | Yes |
| Disconnect and revoke wait on Google | Up to 51 s | No | No | No |
| OAuth callback waits on an agent call | Up to 51 s | Up to 51 s | No | No |
| Polling while waiting | 10 per second | Backoff | None | Only during a refresh |
| One refresh at a time across instances | Yes | Yes | Per instance | Yes |
| Schema change | None | 2 columns | 1 column | 2 columns |
| Size | Built | Small | Medium | Medium, a little more than B |

## Recommendation

B. The lease protects something that doesn't need protecting (the calls) in order to
protect something that does (the row), and versioned writes protect the row directly.
The refresh-token assumption is supported by Google's documentation (above). Move to C
when a second service instance is added.

## Open questions

1. Decided 2026-11-14: this is stacked on PR #182 and fixed before it merges.
2. Is one account per user (the `created_by_user_id` unique key) expected to stay? More
   than one account doesn't change the choice, only the keys.
