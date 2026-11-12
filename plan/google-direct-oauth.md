# Plan: Direct Google OAuth, Calendar first

## Context and objective

The user chose direct Google OAuth instead of the uncommitted MCP prototype.
Implement Calendar first; Gmail and Drive follow using the same connection.
Reuse the existing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in service/.env.
Those are application credentials, not an existing Calendar user grant.

## Design and ownership

- Bud calls Google's APIs directly; remove the MCP runtime and server requirement.
- One Google connection per authenticated Bud owner, separate from Bud login.
- Cookie-session-bound, expiring single-use state and PKCE; Google OAuth client
  library handles code exchange and refresh. Tokens remain AES-GCM encrypted in
  PostgreSQL with owner/connection/client-ID binding. No tokens in the browser,
  model, logs, or transcript.
- GET /api/google/connection is SQL owner-scoped. POST /api/google/connect and
  DELETE /api/google/connection/:connection_id require viewer and trusted Origin.
  GET /api/google/callback requires the exact initiating owner/session/state.
- Calendar agent tools list calendars, list/get/create/update/delete events and
  query availability. Inputs are validated; fixed Google destinations only.
  Pagination is explicit; output is bounded. Writes never retry automatically.
- Human durable invocations retain ownership/lease checks before dispatch and
  unknown-write needs-review behavior. No scheduled-automation grant.
- Request Calendar scopes now. Gmail and Drive permissions/tools are later phases,
  not advertised as implemented. New rows stamp owner and nullable tenant.
- Disconnect removes local tokens; provider revocation stays an explicit Google
  Account action because the OAuth client is also used for Bud sign-in.

## Specs and contracts

Read/update service source, agent, DB/migrations, connected-apps web and parent
feature/route specs. Replace the old setup guide and mark the MCP plan superseded.
No daemon protocol or SSE envelope changes. A generated migration replaces the
unused local MCP table; preserve existing file-upload tables and unrelated work.

## Validation

Fixture OAuth/Calendar tests: PKCE, session/state/expiry/replay, partial scopes,
per-owner isolation, refresh persistence, disconnect races, schema validation,
HTTP failures, no duplicate writes, parser/replay and durable intent handling.
Apply reviewed schema locally and build service/web. Real Google consent remains
user-driven; never send invitations or mutate a real calendar during fixtures.

## Rollout

Migrate before the matching service/web deployment; no daemon upgrade. Configure
a persistent GOOGLE_TOKEN_ENCRYPTION_KEY, existing Google client credentials, and
GOOGLE_REDIRECT_URI pointing to Bud's /api/google/callback. Add that exact URI to
the existing Google OAuth client and enable Calendar API in its Cloud project.
The user authorized a commit and an empty-body PR on 2026-11-12. Merge remains
a separate decision; Render settings were saved without deploying the feature.

## Implementation status — 2026-11-12

- Calendar OAuth, encrypted persistence, seven API operations, durable agent
  integration and Settings card are implemented. The MCP prototype is backed up
  outside the repo and replaced; no MCP server is required.
- Applied the reviewed additive Calendar SQL locally after canceling db:push's
  unrelated table-renaming proposal. Regenerated the migration as
  0067_google_connections.sql after updating to current main; SQL is unchanged.
- 42 focused tests, service TypeScript compilation and web production build pass.
  Frozen-lockfile validation passes with existing dependency resolutions preserved.
- Existing Google client credentials are reused; the local encryption key and
  HTTP callback configuration are saved in ignored service/.env. The running dev
  service was reloaded; readiness and signed-in Settings were checked.
- Real consent succeeded after callback registration and test-user setup, with a
  Calendar email different from the Bud login. A minimal read returned
  SERVICE_DISABLED: enable Calendar API in the OAuth client's project, then
  complete the read/write test flow. Disabled-service errors now give setup guidance.
- Gmail and Drive remain subsequent phases. The PR uses codex/google-calendar-access.
