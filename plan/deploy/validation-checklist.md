# Prototype Render Staging Deployment Validation Checklist

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)

Use this checklist as the release gate for the prototype mobile-testing environment and the place where the post-validation platform decision gets written down.

---

## 1. Deployment Shape

- [ ] `web` is deployed separately from `service`.
- [ ] `service` is deployed as exactly one instance.
- [ ] the database is persistent and reachable from `service`.
- [ ] one public origin fronts browser routes, auth routes, API routes, and `/ws`.
- [ ] the public routing contract is in effect:
  - `/api/*` -> `service`
  - `/.well-known/*` -> `service`
  - `/ws` -> `service`
  - everything else -> `web`

## 2. Public Auth Contract

- [ ] `/login` loads from the public origin.
- [ ] `/auth/mobile` loads from the public origin.
- [ ] `/auth/mobile/consent` loads when consent is required.
- [ ] `/api/auth/.well-known/openid-configuration` resolves from the public origin.
- [ ] authorization-server metadata resolves from the public origin.
- [ ] the public issuer matches the expected deployed value.
- [ ] the API audience/resource matches the expected deployed value.
- [ ] GitHub callback configuration matches the deployed public origin.
- [ ] Google callback configuration matches the deployed public origin.

## 3. Browser App Contract

- [ ] the web app loads from the public origin.
- [ ] client-side routing works for non-API routes.
- [ ] browser sign-in succeeds.
- [ ] `/api/me` returns the expected normalized current-user payload after sign-in.
- [ ] auth redirects stay on the intended public origin.

## 4. Bud Daemon Contract

- [ ] `BUD_SERVER_URL` points at the deployed public `/ws` origin.
- [ ] Bud device-auth start succeeds.
- [ ] the claim URL resolves in the browser.
- [ ] claim approval succeeds.
- [ ] Bud retrieves the approved secret via `/api/device-auth/poll`.
- [ ] Bud reconnects successfully over `/ws`.
- [ ] a claimed Bud appears in the web UI under the expected signed-in user.

## 5. Streaming And Realtime Contract

- [ ] `/api/threads/:thread_id/agent/stream` delivers live SSE frames in the deployed environment.
- [ ] `/api/threads/:thread_id/terminal/stream` delivers live SSE frames in the deployed environment.
- [ ] SSE streams are not visibly buffered by the public front door.
- [ ] SSE reconnect behavior still works after transient disconnects.
- [ ] Bud daemon WebSocket traffic on `/ws` survives normal usage without unexpected disconnect churn.

## 6. Service Readiness And DB

- [ ] the chosen health/readiness endpoint passes in the deployed environment.
- [ ] the deployed environment did not use `db:push`.
- [ ] the chosen migration path completed successfully.
- [ ] DB pool sizing is appropriate for the selected hosted database plan.
- [ ] dev-only bypass values are not enabled in deployment config.

## 7. Mobile Bundle Publication

- [ ] the mobile team has one published app/public base URL.
- [ ] the mobile team has one published issuer/discovery URL.
- [ ] the mobile team has one published API audience/resource value.
- [ ] any environment-specific callback or provider-facing values are documented.
- [ ] known prototype limitations are written down next to the environment bundle.

## 8. Rollback Readiness

- [ ] the team knows how to revert the public origin/callback configuration.
- [ ] the team knows how to roll back the current deploy.
- [ ] the team knows whether schema rollback is supported or whether rollback is forward-fix only.
- [ ] the team knows how to disable or pause mobile use of the environment if validation fails after rollout.

## 9. Platform Decision

- [ ] the team has written down whether Render remains staging-only or continues toward production use.
- [ ] if Render remains staging-only, the intended production successor is named explicitly.
- [ ] if AWS is the current production candidate, the team agrees the target shape is still one public origin with path-based routing rather than split browser/API domains.

---

## Sign-Off

- [ ] Deployment contract accepted
- [ ] Service readiness accepted
- [ ] Public-origin auth contract accepted
- [ ] Bud claim/bootstrap accepted
- [ ] SSE and `/ws` behavior accepted
- [ ] Mobile environment bundle published
- [ ] Platform decision recorded

---

*Last Updated: 2026-03-23*
