# Debug: Direct Google OAuth implementation

## Environment and observations

Local macOS, main working tree, PostgreSQL localhost, synthetic OAuth/API fixtures.
No real Calendar grant or event mutation during automated validation.

- `pnpm add google-auth-library@11.3.4` installed then reported
  `ERR_PNPM_IGNORED_BUILDS: esbuild@0.18.20, esbuild@0.25.12, protobufjs@7.5.5`.
  That release requires Node 22 while Bud supports Node 20. Switched to 10.9.1,
  which supports Node >=18, using `pnpm add google-auth-library@10.9.1 --ignore-scripts`.
  Removed only the generated placeholder pnpm-workspace.yaml. No blanket script
  approvals. Removed the MCP SDK with pnpm and ignored install scripts.
- `node service/node_modules/drizzle-kit/bin.cjs generate --config service/drizzle.config.ts --name google_connections`
  from root failed: `No schema files found for path config ['./src/db/schema.ts']`.
  Corrected package cwd and ran `pnpm db:generate --name google_connections`.
- Initial package-local `tsc --project tsconfig.json --noEmit` reported TS7006 /
  TS2560 for a function passed to Gaxios's interceptor object API. Use the
  documented async `resolved` callback instead (TS2322 also requires a Promise).
- `pnpm db:push` proposed unrelated `user_file` or `mcp_connection` table renames.
  Canceled before writes. Applied the reviewed additive generated SQL directly;
  removed the obsolete MCP table after checking it contained zero rows under
  an exclusive lock. It was never deployed; Drizzle's `drop` command removed the
  uncommitted old 0054 migration and generated the replacement metadata.
- `node --import tsx src/server.ts` from service/ exited 1 with
  `Error: No address added out of total 1 resolved errors: [listen EADDRINUSE: address already in use 127.0.0.1:50051]`.
  The original tsx dev watcher already owned the service ports. Reused/reloaded it
  after the .env changes and stopped only the duplicate Vite process started during
  this check. Existing Vite remains on localhost:5173; service readiness returns ok.

## Expected / proposed validation

Calendar connects using the existing Google client credentials; encrypted tokens
remain user-owned and refresh across restarts. Scope failures are explicit. Event
updates/deletes use If-Match; ambiguous writes stop for review. See the
[implementation plan](../plan/google-direct-oauth.md).

## Validation result

42 focused Google/agent/schema/invocation/transcript tests pass (isolated PostgreSQL
enabled with BUD_DATA_DB_TEST=1). Service TypeScript and web production builds pass.
The frozen lockfile passes validation; unrelated peer-resolution churn was removed.
The signed-in Settings page shows the configured Calendar card and Connect button.
GET /api/google/connection through Vite returns 401 without a session. Real Google
consent and Calendar mutations remain pending user testing; no account was connected.

## Real-account API denial — 2026-11-12

The user connected a Google account different from their Bud login and requested
their calendar list. Consent succeeded; the owner-scoped connection is connected
with all three Calendar scopes. A minimal authenticated Calendar GET returned
HTTP 403 with `accessNotConfigured` and `SERVICE_DISABLED`. No account data,
credentials or raw provider error body was logged; no event was mutated.

The app's Google Cloud project must enable Calendar API. Different login and
Calendar emails are supported. Bud currently discards the error reason and maps
every 403 to access denied, causing the agent to suggest an unnecessary reconnect.
Recognize only Google's fixed disabled-service reason codes and return static
setup guidance; keep raw error messages/metadata out of transcripts. Preserve the
HTTP status for existing definite-rejection versus uncertain-write handling.
Update google.spec.md and test modern/legacy, malformed and unknown error bodies.

Validation initially failed in `context-tool-catalog.test.ts` after the local
Google configuration became active. Command from service/:
`BUD_DATA_DB_TEST=1 node --import tsx --test --test-reporter=dot src/google/*.test.ts src/db/schema-metadata.test.ts src/agent/invocation-executor.test.ts src/agent/invocation-worker.test.ts src/agent/context-tool-catalog.test.ts src/agent/transcript-writer.test.ts`.
Error: `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal`
for live versus idle catalogs: idle included google_search_tools/google_call,
while the test's live human fixture omitted googleEnabled. Set the fixture's
human grant to match ServiceInvocationExecutor; keep the production gate intact.

After the correction, all 44 focused tests passed. Package-local
`node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit` and
`git diff --check` passed; the running service remained ready. The disabled-API
error now has static setup guidance and retains HTTP 403, including write calls.

## Chat consent — 2026-11-12

The user confirmed real Calendar listing works after enabling the API. Added
inline chat consent with an encrypted, owner/session-bound return thread; see
[plan](../plan/google-calendar-chat-connect.md). Automated tests use synthetic
Google responses and isolated DB rows; the real connection remains intact.

Validation: 13 Google tests (BUD_DATA_DB_TEST=1), 5 mounted chat tests, 27
projection/streaming regressions, service typecheck and web production build pass.
The build retains its existing large-chunk warning. The service /readyz is healthy.
The disposable HTML preview initially failed with `SyntaxError: The requested
module '/node_modules/.vite/deps/react-dom_client.js' does not provide an export
named 'createRoot'`. Using normal bare React imports allowed Vite's CJS transform;
Chrome then rendered the real ChatTimeline/card correctly. Preview removed after
inspection. Real chat OAuth acceptance remains for a disconnected test account.

## PR preparation and hosted setup — 2026-11-12

Render's bud-service now has the hosted callback and a stable base64 32-byte
encryption key, saved without deployment. Existing Google client credentials were
preserved. The Google Cloud project owner still needs to confirm the exact hosted
callback. No real Calendar events were created or deleted by this setup.

`git fetch origin` failed with `Permission denied (publickey)`; authenticated
HTTPS with the existing gh credential helper succeeded. Updated the feature
branch to main at 8dddc46. Main already owns migrations 0054–0066, so restored its
generated metadata and ran package-local `drizzle-kit generate --name google_connections`.
The result is 0067 with exactly the same additive SQL as the local Calendar 0054.
No journal was hand-edited. The DB fixture and current setup/spec references now
use 0067; the original Google changes remain backed up in the Git stash.

Regenerating the dependency lockfile caused unrelated peer-resolution churn.
Merged the original additive Google dependency entries with current main instead;
both independent https-proxy-agent and i18next additions are preserved.

Final checks on current main: service and web `pnpm build` pass; 45 backend
Google/schema/agent/invocation/transcript tests pass with isolated PostgreSQL
enabled; 28 mounted Calendar-card/timeline/projection tests pass. Frozen-lockfile
installation with scripts disabled passes. The web build retains its existing
large-chunk warning. Real event writes and hosted consent remain acceptance checks.
