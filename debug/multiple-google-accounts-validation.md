# Multiple Google accounts validation

Validation uses Node 22, pnpm, isolated local PostgreSQL databases, synthetic Google responses for write and failure tests, and two real Google accounts for read-only acceptance. The branch builds on the Google services changes in PR 182 and the concurrency changes in PR 185.

## Updated PR 182: `8c197cf` (November 17)

- **Database upgrade:** Applied PR 182's migrations through `0071`, seeded an existing Google connection and an active Drive write lease, then applied `0072`. Both survived. A second migrate made no changes. A separate fresh database built with `db:push` had the same owner/subject unique constraint and Drive lease primary key. The Google-enabled service refused to start on `0071` and returned HTTP 200 from `/readyz` after `0072`.
- **Shared Drive files:** Two connected accounts addressed the same file by canonical ID and alias. Only one write reached the simulated provider; unrelated files remained writable. Revoking the first account between the version check and dispatch sent no write and allowed the other account to update that same version. A lost provider response blocked an immediate second mutation; a definite rejection released the file. The independent two-process stress check passed eight rounds.
- **Service:** All 83 Google, migration and schema tests passed on PostgreSQL 17 with no skips. Four parallel repeats passed all 44 connection tests each. The full service suite passed 1,010 tests with database and WSS tests enabled and `DEFAULT_MODEL=gpt-5.6-luna`. Without that override, two unrelated fixtures expect the older model; both failures reproduced on unmodified PR 182. Service and web production builds passed.
- **Account routing and browser:** Repeated the loopback check using real Better Auth sessions and PostgreSQL with a simulated Google provider: 36 HTTP requests and 22 agent calls covered account selection across Gmail, Calendar and Drive, isolation between Bud users, callback replay and targeted revocation. All 425 web tests and all eight Chrome scenario groups passed. No browser errors.
- **Provider coverage:** This pass used simulated Google responses to control concurrent writes and failure timing. The earlier live sign-in and six successful read-only identity checks are recorded below; they were not repeated after the rebase.

## Earlier validation on the PR 185 base

The earlier migration run exercised a full upgrade and a fresh schema push. Existing grant epochs and refresh leases are included in the migration regression.

### Automated checks

- From `service/`, run `BUD_DATA_DB_TEST=1 node --import tsx --test src/google/*.test.ts src/db/google-accounts-migration.test.ts src/db/schema-metadata.test.ts` against local PostgreSQL. All 80 tests passed, with no skips. The suite exercises selection, verified account IDs on callback, wrong-account reconnects, simultaneous grants and revocation during a blocked Google exchange. Four parallel runs of the 41 connection tests also passed in independent PostgreSQL schemas.
- Both production builds passed. In `web/`, `pnpm test` passed 285 unit tests and `pnpm test:render` passed 140 mounted tests, including account selection and checking the returning consent card against live inventory.
- The standard service test run with database tests enabled had two failures. Both reproduced on the unmodified PR 185 head. The question-continuation and thread-list fixtures expect `gpt-5.6-luna`, while the service defaults to `gpt-6-luna`. A second run used the model expected by those fixtures and an ephemeral local TLS certificate to exercise the WSS test, with database tests enabled. All 1,007 tests passed with no skips.

### Additional integration checks

- A loopback Fastify server used the normal Google routes, signed Better Auth session cookies, real SQL ownership lookups and the agent executor. Two Bud owners connected two simulated Google accounts. Across 36 HTTP requests and 22 agent invocations, the test verified expected account identities for all three services, wrong-session callback rejection, independent revocation, restart persistence and the absence of additional Bud login identities.
- A paused refresh returning `invalid_grant` after successful reconnect incorrectly invalidated the replacement grant in 12 of 12 reproductions. A second test paused a Calendar write while a concurrent refresh narrowed the account to read-only. The write reached the simulated provider in 8 of 8 reproductions. The same reproductions passed after the fixes. Regression tests now enforce that a failed refresh can affect only its own grant epoch and that dispatch checks the latest provider scopes.
- A four-replica stress run handled 216 chooser callbacks, including 162 duplicates. All 36 foreign-owner or wrong-subject attempts were denied. All 72 callbacks paused at Google failed to restore a revoked account. Retrying left no temporary rows.
- A targeted consent callback that omitted a refresh token could save the old token while Google was rotating it. This reproduced four times. After the fix, all four reconnects preserved the new token. The callback waits outside the transaction and applies the original exchange result after the rotation.
- Native Chrome Back restored a removed account in Settings from its page cache. Browser tests also exposed ambiguous callback query parameters and reuse of an Add receipt with a different account ID. After the fixes, all eight Chrome scenario groups passed over loopback HTTP, including native cache restoration. The browser made eight consent requests, two targeted deletes and 40 inventory requests with zero browser errors.

### Live Google acceptance

Both designated accounts completed Google’s real consent screen on localhost with read-only access to Gmail, Calendar and Drive. For each saved connection, the Gmail profile email, primary Calendar identity and Drive user email matched the identity returned by OAuth. All six checks matched across two distinct Google subjects.

The first run scheduled six reads concurrently and hit the existing four-call limit twice. The sequential rerun passed all six through the same grants. Live checks accessed identity fields only. Message, event and file writes were exercised against the synthetic provider. The test server was stopped and the temporary database containing the encrypted test grants was removed.
