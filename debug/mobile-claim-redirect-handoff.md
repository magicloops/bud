# Debug: Mobile Claim Redirect Handoff

## Environment
- OS / arch / versions: macOS (developer workstation), repo date 2026-03-23
- DB connection style: not applicable for the planned v1 fix; expected change is web-only
- LLM mode (real/mocked): not applicable

## Repro Steps
1. Start from an iOS-hosted claim flow using `/devices/claim/$flowId`.
2. If the browser is anonymous, complete login through `/login`.
3. Let the hosted claim page auto-approve the Bud.
4. Observe the post-approval navigation target.

## Observed
- The hosted claim page currently redirects successful claims into the web Bud route `/$budId`.
- The claim route currently sends anonymous users to `/login` using `/devices/claim/${flowId}` and drops any claim-route query params.
- `POST /api/device-auth/flows/:flowId/approve` returns `{ status: "approved", bud_id }` and does not create or return a `thread_id`.

## Expected
- An iOS-started hosted claim should be able to return control to the app after success or terminal failure.
- Login-required claims should preserve any callback-related query params through resume.
- Browser-only claims should keep existing behavior when no mobile callback params are present.

## Hypotheses
- The main gap is in the hosted claim route, not the backend approval endpoint.
- A small helper for parsing and validating claim callback params will reduce route complexity and make fallback behavior safer.
- The correct v1 handoff payload is `flow_id` + `bud_id`, with thread selection remaining an iOS responsibility.

## Proposed Fix
- Add a web helper to parse `source=ios`, validate allowlisted callback URLs, and build success/error callback URLs.
- Update the hosted claim route to preserve the full current claim URL through `/login`.
- Redirect to the validated mobile callback on `approved` / `completed`, with browser-only fallback unchanged.
- Update relevant web/root specs and mobile-claim docs to match the shipped contract.
