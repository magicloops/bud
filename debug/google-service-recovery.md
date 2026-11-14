# Debug: Google integration recovery failures

## Environment and reproduction

Current combined Google-services PR worktree on macOS. Regression tests use
synthetic Google transport and isolated local PostgreSQL schemas. The user's
live Google credentials and grants are not changed by automated checks.

Reported reproduction paths:

1. Change the token encryption key, then open Settings, reconnect or revoke.
2. Remove Bud in Google Account permissions, then connect a different service.
3. Read a Gmail thread whose decoded output exceeds 32 KiB.
4. Fail token refresh several times during a short Google outage.
5. Start Bud with a plain HTTP APP_BASE_URL on a network address.
6. Run Google calls for multiple owners concurrently.

## Observations and causes

- Inventory and locked operations decrypt before allowing recovery; a changed key
  throws `google_credentials_unreadable`. Account disconnect already clears the
  row without decryption but Settings does not expose that escape route.
- Callback scope preservation rejects a new grant that omits previously stored
  services even when those scopes were removed upstream.
- Executor byte-slices serialized JSON at 32 KiB; Gmail threads list older
  messages before newer ones, so output can be invalid JSON and lose the latest.
- OAuth refresh maps all exceptions to `google_reconnect_required`, including
  temporary network/provider errors.
- Default connection construction validates the callback eagerly; non-loopback
  HTTP throws during module import even when Google is not being used.
- One instance-level counter caps locked operations at four for every owner.

## Proposed fix and validation

Implement the focused recovery and result-budget changes in
[the plan](../plan/google-service-recovery.md). Preserve authenticated ownership,
explicit task access and unknown-write-outcome handling. Record regression test
results and any exact build/run failures here after implementation.

## Regression findings

The first transient-refresh regression failed with:

```text
DOTENV_CONFIG_PATH=/Users/sp/Documents/bud/service/.env BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/google/connections.test.ts src/google/calendar.test.ts
connections.test.ts:383: expected refreshAttempts 1, actual 4
```

The Google SDK supplies `retryConfig`; gaxios uses that even when the request
interceptor sets `retry=false`. Explicitly set both `retryConfig.retry` and
`retryConfig.noResponseRetries` to zero. Each explicit attempt now makes one
token request; transient errors preserve credentials rather than forcing consent.

An independent route check also found that lazy validation alone let malformed
callback URLs throw outside the callback handler's guarded block. Validate the
callback before building its return target; invalid configuration returns a
sanitized error and cannot redirect to a non-HTTP scheme.

## Completed validation

- Service: `DOTENV_CONFIG_PATH=/Users/sp/Documents/bud/service/.env BUD_DATA_DB_TEST=1 node --import tsx --test --test-reporter=spec src/google/*.test.ts`
  passed all 33 tests, including the isolated PostgreSQL integration suite.
- Recovery route tests cover unauthenticated requests (401), foreign owners (404),
  untrusted cookie Origins (403), and unchanged target ciphertext after rejected
  mutations. Owner reconnect, service revoke and account clear recover from an
  unreadable key; keyless clearing also works.
- Four explicit transient refresh attempts each make exactly one token request,
  preserve the stored token and access, and dispatch no write. The next successful
  refresh dispatches once. Permanent `invalid_grant` requires reconnection.
- Large Unicode Gmail threads retain the newest message, produce valid JSON below
  32 KiB, report omitted content, and bound follow-up IDs. Existing uncertain-write
  and authorization regressions remain green.
- Service `pnpm build` passed. Web `pnpm test` passed 281 tests and
  `pnpm test:render` passed 121 mounted tests; `pnpm build` passed. Connected-apps
  ESLint and `git diff --check` passed. Vite's existing large-chunk warning remains.
- The local service returned 200 from `/readyz`, with database and auth checks OK
  after hot reload. No live Google credentials/grants were changed for testing.

Matching service/web builds are required. These fixes need no new database
migration or daemon upgrade.

## Follow-up review

Main's migration timestamp now follows the original Google migration. A database
with main's migration applied skips that older SQL. The Google code also holds
a row lock during remote I/O, marks writes before transport, and treats any API
401 as revoked consent. Review found mismatched discovery null defaults, weak
validation feedback, missing mobile consent guidance, cached browser navigation
state, and incorrect or ambiguous Calendar/Drive update fields. Reproduce each
case against the normal provider, executor, transport, or browser entry point
with isolated fixtures. See the [plan](../plan/google-service-recovery.md).

The migration was regenerated after main de6d6f3. On a disposable PostgreSQL
database, applying main's migrations first created its source-request trigger
and left Google absent. The branch migrator then applied 0070 exactly once and
preserved the trigger. A separate empty database using db:push matched the
migration across 14 columns, six constraints and three indexes. The local
shared database already has the Google table but lacks main's source-request
migration. It was inspected read-only.

The full service suite with `DOTENV_CONFIG_PATH=/dev/null BUD_DATA_DB_TEST=0 pnpm test`
reported two default-model expectation failures in the question-continuation and
thread-list tests (`actual gpt-6-luna`, `expected gpt-5.6-luna`). Both the
default and these fixtures come from main. With `DEFAULT_MODEL=gpt-5.6-luna`,
the final suite passed 899 tests, with 54 environment-gated tests skipped.
The separate Google run enabled its PostgreSQL tests and passed all 48.
Full web validation passed 285 pure tests and 125 mounted tests. Both service
and web production builds passed. The mobile fallback was verified through the executor and
transcript replay. OAuth and provider traffic in these tests used fixtures.
