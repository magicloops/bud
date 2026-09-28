# Debug: Mobile browser visit recovery and privacy

## Environment
2026-09-25; Swift/WKWebView native viewer and shared hosted browser shell, after M1.

## Observed
WK termination/visit refresh failures require Close/reopen. Resume ACK has no
deadline. Bridge checks the frame URL but not WK securityOrigin. Bootstrap accepts
foreign Origin before consuming a one-use grant; empty scoped cookies can fall
through to full-cookie auth. Unredeemed expired grants remain until eight hours.

## Approach
Keep Chrome recovery in the hosted viewer. Native covers immediately, retries
transient credential/network failures within the visit, and replaces expired or
terminated visits once per incident after owner-authorized inventory/grant checks.
Replacement uses an isolated WK store and new visit/viewer IDs with no private
proof/input transfer. Bound ACK waits, validate actual origin and exact identities,
remove unused native Return command, and gate bootstrap Origin before redemption.

Ownership remains workspace → thread → Bud → authenticated user. Native uses
existing bearer inventory/grant routes; embedded content uses only scoped cookies.
No new rows, schema, daemon protocol, automatic takeover or mutation replay.

## Validation
Focused native lifecycle/identity tests, service bootstrap/auth tests, shared shell
bridge tests, builds/typechecks. Physical lock/OTP/real OAuth checks remain M3.

## Validation development notes
- Initial `pnpm exec tsc --noEmit` ran from repo root: `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "tsc" not found`. Reran from service package.
- Initial native test build: `VisitBackend does not conform to BrowserBackend`; fixture declared nonoptional origin while protocol requires optional. Corrected fixture.
- A debug-note append used the mobile working directory and failed with `FileNotFoundError: debug/mobile-browser-m2.md`; corrected to the absolute main-repo path.

- Initial web fixture creation used `web/src/...` from the web package directory and failed with `No such file or directory`; corrected to the absolute path.

Final validation: simulator build and 18 focused native tests passed. Service
`pnpm exec tsc --noEmit` and web `pnpm exec tsc -b` passed. Seven service tests
passed with `BUD_DATA_DB_TEST=1` (isolated PostgreSQL schema), and four mounted web
bridge/viewer tests passed. Physical privacy/input checks remain M3. Full commands
are recorded in the mobile Phase M2 plan. No deployment or migration performed.
