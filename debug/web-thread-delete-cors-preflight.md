# Debug: Web Thread Delete CORS Preflight

## Environment
- Package: `service/`
- Browser origin: `http://localhost:5173`
- API origin: `http://localhost:3000`
- UI flow: web thread deletion from the Bud workbench

## Repro Steps
1. Start the service on `http://localhost:3000`.
2. Start the web app on `http://localhost:5173` with direct API traffic to the service origin.
3. Attempt to delete a thread from the web UI.
4. Observe the browser console and network panel.

## Observed
- The browser sends an `OPTIONS` preflight before the cross-origin `DELETE /api/threads/:thread_id` request.
- The preflight response omits `DELETE` from `Access-Control-Allow-Methods`.
- The browser blocks the actual delete request with:
  - `Method DELETE is not allowed by Access-Control-Allow-Methods in preflight response`
  - `net::ERR_FAILED`
- `service/src/server.ts` currently hardcodes `GET,HEAD,POST,OPTIONS` as the service-level CORS method allowlist.

## Expected
- Direct local browser-to-service requests should pass preflight for all browser-facing API methods currently used by the product surface.
- Thread deletion should succeed when the origin is trusted and the user is authorized.

## Hypotheses
- The service-level CORS method allowlist predates the newer `DELETE` and `PATCH` routes.
- Any direct local browser call using methods outside `GET,HEAD,POST,OPTIONS` will fail preflight even when the route itself is valid.

## Proposed Fix
- Expand the service-level CORS method allowlist in `service/src/server.ts` to include the current browser-facing `DELETE` and `PATCH` methods.
- Add a focused server regression test that performs a real trusted-origin `OPTIONS` preflight and asserts the returned allow-methods header includes the full current set.
- Update the relevant service spec to document that the direct local-dev CORS surface covers the active browser API methods.
