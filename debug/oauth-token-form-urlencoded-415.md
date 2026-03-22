# Debug: oauth-token-form-urlencoded-415

## Environment
- Local macOS development
- Service process running with Fastify + Better Auth
- iOS app performing OAuth code exchange against `POST /api/auth/oauth2/token`

## Repro Steps
1. Complete the hosted Google sign-in flow and return to the app with an authorization code.
2. Have the iOS client submit the token request as `application/x-www-form-urlencoded` to `POST /api/auth/oauth2/token`.
3. Observe the service reject the request before Better Auth handles it.

## Observed
- Fastify receives `POST /api/auth/oauth2/token`.
- The request is sent with `Content-Type: application/x-www-form-urlencoded`.
- Fastify responds with `415 Unsupported Media Type`.
- The logged error is `FST_ERR_CTP_INVALID_MEDIA_TYPE`.

## Expected
- OAuth token requests should be accepted as form-encoded bodies.
- The request should reach Better Auth, which can then return the appropriate OAuth-level response (`200`, `400`, etc.).

## Findings
- `service/src/server.ts` registers Fastify, websocket, SSE, and routes, but does not register any parser for `application/x-www-form-urlencoded`.
- Fastify therefore rejects form-encoded token requests before the `/api/auth/*` route handler can invoke `auth.handler(...)`.
- Our own internal revoke wrapper in `service/src/routes/me.ts` already sends form-encoded requests to Better Auth, which matches the expected OAuth token/revoke transport shape.
- `service/src/auth/auth.ts` is already capable of forwarding form-encoded bodies once Fastify has accepted them.

## Hypotheses
- The current blocker is a server-level Fastify content-type gap, not an OAuth-provider logic bug.
- Registering a raw string parser for `application/x-www-form-urlencoded` will let Better Auth parse token requests normally without forcing the service to pre-interpret OAuth form bodies.

## Proposed Fix
- Add a Fastify content-type parser for `application/x-www-form-urlencoded`.
- Keep the parsed body as the raw string payload so Better Auth receives the original form body unchanged.
- Re-test `POST /api/auth/oauth2/token` and confirm the response is no longer `415`.

## Spec Files Affected
- `bud.spec.md`
- `service/src/src.spec.md`
