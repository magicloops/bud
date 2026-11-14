# Debug: Google task access and service revocation

## Environment

Local macOS development worktree; service and web package-local tools. PostgreSQL
fixtures use isolated schemas and Google traffic is synthetic. No real message,
event or file mutation is part of automated validation.

## Reproduction and observations

A read task needs read-only OAuth access; a write task needs full access. The prior
per-action approval implementation added a second decision after consent and a
separate parked invocation. The requested product now uses only the task's OAuth
card, with full-access Connect in Settings and per-service Revoke access.

Combined Google grants can include previously authorized scopes. Therefore scopes
alone cannot preserve a local service revoke or read-only selection. Pending OAuth
callbacks also need invalidation when access is revoked.

## Implementation and review

Remove Google approval hooks/continuations/bootstrap arrays, approval API/UI and
global write policy. Store selected `none|read_only|read_write` per service in the
existing encrypted credential envelope, intersect it with actual scopes on every
call, and clear pending OAuth state under the connection lock on revoke.

Review caught a partial-consent case: selected services with existing access must
also retain that access if a multi-service response omits them. An explicit
read-only selection may cap an existing full grant; other established capability
must not disappear silently. A regression covers this boundary.

Final review reproduced a Calendar path boundary issue: `encodeURIComponent`
leaves literal `.` and `..` unchanged, so `calendar_delete_event` with
`event_id: ".."` prepared `/calendars/primary/events/..`, which `new URL` normalized
to `/calendar/v3/calendars/primary/`. Reject dot-only calendar/event IDs before
request construction. Cover read/write preparation and verify encoded delimiters
remain inside the intended event path at the transport boundary.

## Validation

- Existing invocation worker suite: 17 passed in each original worktree after
  removing the Google-specific parking hook; other human-input flows still pass.
- Final combined validation: 23 Google tests (including PostgreSQL), 17 worker tests,
  and 1 context catalog test; 281 pure web tests and 117 mounted web tests passed.
  Service compilation, web TypeScript/Vite build, and connected-apps ESLint passed.
- After the Calendar dot-segment fix, the combined branch's 23 Google tests pass
  with `BUD_DATA_DB_TEST=1` against isolated PostgreSQL, and service TypeScript
  compilation passes (`pnpm exec tsc --project tsconfig.json --noEmit`).
- Real two-account consent, service revoke, account-switch and write acceptance
  remain in [the auth checklist](../plan/init-auth/validation-checklist.md).

## Migration integration

Main includes `0067_fast_ikaris.sql` and `0068_chief_starbolt.sql`. Retain both and
their generated metadata/backfill statements, then generate
`0069_google_connections.sql` from the combined schema. The old Calendar 0067 name
must not overwrite main's migration history. Local historical Google tables were
already applied separately; do not replay their CREATE TABLE on that database.

## Web validation observation

The package-local command
`node --experimental-strip-types --test 'src/**/*.test.ts'` on the original
all-services worktree reported 274 passing tests and one file-level failure:

```text
Error: Test "tap, remote swipe and local pinch/pan remain distinct; drag cannot click"
at src/features/browser/touch.test.ts:5:1 generated asynchronous activity after
its test ended. This activity created the error
"ReferenceError: requestAnimationFrame is not defined" and would have caused the
test to fail, but instead triggered an uncaughtException event.
```

Investigation: that existing Node test uses the browser touch handler's real
`performance.now()` clock. If its synchronous swipe crosses the 4 ms velocity
sampling threshold under CPU contention, it attempts momentum with the default
browser-only `requestAnimationFrame`. The test otherwise completes below that
threshold. Dedicated momentum tests already inject a deterministic clock. No
Google code or browser touch implementation change is implicated; rerun after
integration without overlapping builds, and if it recurs, fix the test fixture's
clock rather than introducing a browser-runtime fallback.

Settings review also found that reconnect-required connections must keep Revoke
access available for their stored grant even though effective displayed access
is No access. The button now uses the stored per-service access, and a mounted
regression covers immediate revocation from that state.

## Isolated local schema validation

The disposable-database validation helper initially stopped before invoking
Drizzle with this command:

```text
node /tmp/bud-google-schema-validation.cjs push /Users/sp/.codex/worktrees/google-services-policy/bud/service
Error: Server is not loopback
```

PostgreSQL returned `::1/128` from `inet_server_addr()::text`; the helper compared
that CIDR representation to `::1`. Use `host(inet_server_addr())` for the safety
check. The database name and URL host checks still require the disposable local
database. This failure made no schema changes.

Final integrated web suites passed sequentially; the touch timing failure did not
recur and no unrelated touch code was changed.

For manual testing, the existing local development database already contained
`google_connection` but lacked main's new data-source/history tables. Applied only
`0067_fast_ikaris.sql` and `0068_chief_starbolt.sql` in one transaction after
asserting all five new tables were absent. Existing tables, Google credentials
and unrelated file-upload schema were preserved; no broad schema push was used
on the shared development database.

After normalizing the address, `pnpm db:push` completed against a fresh disposable
loopback database using the final combined schema. The proposed SQL contained
only 78 table creations, 142 index creations and 156 foreign-key additions. The
shared development database was not the target of this validation.

Executing `0069_google_connections.sql` in a temporary schema within that database
produced an exact match to the pushed `google_connection` table: all 14 columns
(types, defaults and nullability), six constraints (including the owner key,
auth-user foreign key and checks), and three indexes. The comparison transaction
was rolled back after verification. The disposable database was then removed;
manual testing uses the existing local development database.

## Local PR startup

Started the service with
`DOTENV_CONFIG_PATH=/Users/sp/Documents/bud/service/.env pnpm dev` from this
worktree's `service/`. The `web/` command
`pnpm exec vite --host localhost --port 5173 --strictPort` stopped in the local
package wrapper:

```text
Error: ERR_PNPM_IGNORED_BUILDS
Ignored build scripts: esbuild@0.25.12, esbuild@0.27.1
```

The already-installed Vite dependencies are usable (the production build passed).
Started `node node_modules/vite/bin/vite.js --host localhost --port 5173 --strictPort`
instead and removed the wrapper's generated `pnpm-workspace.yaml` placeholder.
Both server working directories resolve to this PR worktree. `/readyz` returns
200 with database/auth checks `ok`; the web returns 200 and the Google API proxy
correctly returns 401 without a session.

The background automation worker logs `automation_settleDepartures_failed`.
Read-only EXPLAIN identified PostgreSQL 42P01: `relation "place_presence" does
not exist`. The local database also lacks older place/visit dependencies; their
migration chain includes existing-data conversion and index replacement. This
unrelated schema catch-up was not applied during Google startup. Google human-chat
testing does not use the place-presence automation worker.

## Follow-up: complete local startup repair

The user reported the app unusable and the Bud offline. The daemon was not
running; only a surviving terminal holder remained. Verified the retained local
device secret against the local database without exposing it, then started the
existing daemon identity. It authenticated as the same Bud and reattached the
existing terminal; no device claim, ownership or credential changes were needed.

A full catalog comparison found missing migrations 0053–0066, including seven
tables, six columns and a nullability change. Created a private local pg_dump
backup and rehearsed that exact chain on a restored copy. All backfill DML
affected zero rows, and count/hash comparisons across every pre-existing table
proved existing values unchanged. Stopped the service, rechecked the same
conditions, and applied only that chain in one transaction with lock timeouts.
All 83 pre-existing auth/public tables retained their data, including messages,
threads, Google credentials and unrelated file/OpenAI tables. Migration metadata
was not edited and no broad schema push was run. The backup was retained; the
temporary rehearsal database was removed.

Restarted the service with the same local environment. The daemon automatically
reconnected. Browser verification created a fresh "Local PR Smoke Test" chat;
the model returned exactly "Bud test OK" without using tools, and the new terminal
reported Ready/connected. Account Settings opened with all three Google service
sections. The Google account chooser was left to the user; no OAuth grant was
changed during the diagnostic test.
