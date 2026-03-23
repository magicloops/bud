# Render Deployment Review And Topology Options

## Context

Bud now has three externally relevant runtime surfaces:

- `web/`: a Vite-built React SPA with hosted auth pages at `/login`, `/auth/mobile`, and `/auth/mobile/consent`
- `service/`: a Fastify service that owns `/api/*`, `/.well-known/*`, SSE streams, and the Bud daemon WebSocket endpoint at `/ws`
- `bud/`: a daemon that connects to `/ws` and also calls `/api/device-auth/*` during the claim/bootstrap flow

This document reviews the current codebase for deployment readiness on Render and outlines cloud-agnostic deployment options for production.

It now distinguishes between:

- a Render-hosted staging environment we can stand up quickly for mobile iteration
- a longer-term production platform choice, which remains open

## Executive Summary

The current codebase is deployable to a production-like environment, but only under a specific shape:

- the `web` app should be treated as a static site
- the `service` should be treated as a single public web service
- browser traffic should stay same-origin for `web` + auth + API paths
- the `service` should remain single-instance for now

The cleanest near-term model is:

1. Deploy `web` and `service` as separate services.
2. Put a single public domain in front of them.
3. Route `/api/*`, `/.well-known/*`, and `/ws` to `service`.
4. Route everything else to `web`.

Cloudflare is a reasonable way to do that on top of Render for staging. The same pattern also maps cleanly to AWS, GCP, or other providers with an edge/router layer.

The main update after reviewing Render's generic multi-service guidance is:

- Render is still a reasonable place to run Bud's first public staging environment
- Render's generic multi-service pattern is not Bud's target browser architecture
- if we want the cleanest long-term production story for one public origin with path-based routing, AWS is currently the cleaner default than trying to stretch Render into that role

## What The Codebase Assumes Today

### 1. The browser flow is same-origin in practice

The current browser setup is intentionally same-origin during local development:

- `web/.env.example` recommends leaving `VITE_API_BASE_URL` unset and proxying `/api/*` plus `/.well-known/*` through Vite.
- `service/.env.example` treats `APP_BASE_URL` and `BETTER_AUTH_URL` as the public app/auth origin.
- `web/src/lib/auth-client.ts` points Better Auth at an absolute `/api/auth` URL derived from the browser-visible origin.
- hosted auth pages live in `web`, while OAuth metadata, callbacks, token exchange, and `/api/me` live in `service`.

There is a partial cross-origin client mode via `VITE_API_BASE_URL`, but the backend is not yet set up as a general browser-facing cross-origin API.

### 2. The backend is stateful per instance

The service is not currently horizontally scalable:

- Bud daemon connections are stored in an in-memory `sessions = new Map<string, SessionTracker>()` in `service/src/ws/gateway.ts`.
- SSE replay buffers are stored in in-memory `Map`s in `service/src/runtime/event-bus.ts`.
- run state, Bud online/offline state, and terminal routing all depend on the current process owning the Bud's live WebSocket connection.

This means a second `service` instance would not share:

- Bud connection ownership
- agent/terminal SSE replay buffers
- in-flight run routing state

Sticky sessions do not solve this, because the Bud daemon and the browser are different clients. A browser request can still land on an instance that does not own the Bud connection it needs to talk to.

### 3. Long-lived connections are part of the core product

Bud depends heavily on:

- browser SSE for agent and terminal streams
- long-lived Bud daemon WebSocket connections on `/ws`

That makes proxy and edge behavior part of the deployment design, not an implementation detail.

### 4. The Bud daemon assumes its HTTP bootstrap API shares origin with its WS endpoint

The daemon derives its HTTP API base from `BUD_SERVER_URL` for the device-claim bootstrap flow (`/api/device-auth/start` and `/api/device-auth/poll`).

That means:

- whatever public origin the daemon uses for `/ws` must also expose the device-auth HTTP routes
- a topology that splits Bud WebSocket traffic and Bud bootstrap HTTP traffic across unrelated public origins will break onboarding unless the daemon is changed

### 5. The web app itself is static-hostable

The current `web` app is a Vite SPA with no SSR or server-rendered runtime. That makes it a good fit for:

- Render Static Site
- S3 + CloudFront
- GCS + Cloud CDN
- Cloudflare Pages
- any generic static CDN host

## Deployment Gaps And Risks

### 1. Split-domain browser deployment is not ready yet

A topology like:

- `app.example.com` for `web`
- `api.example.com` for `service`

looks attractive operationally, but the current browser stack is not production-ready for it.

Why:

- there is no general Fastify CORS setup for Bud's browser APIs
- auth today is modeled around same-origin hosted pages plus same-origin `/api/auth/*`
- SSE uses cookie credentials and `EventSource(..., { withCredentials: true })` only when `VITE_API_BASE_URL` is cross-origin, but the server side does not yet show the full CORS/cookie hardening needed for this to work reliably in production
- `BETTER_AUTH_TRUSTED_ORIGINS` is not a substitute for full browser CORS behavior

Conclusion:

- separate domains are fine for native/mobile clients
- separate browser/API domains should be treated as a follow-up project, not the default production deployment shape today

### 2. Horizontal service scaling is unsafe right now

Running multiple `service` instances behind a load balancer will create correctness problems:

- browser requests may hit an instance that does not own the Bud connection
- SSE subscribers may connect to an instance with no replay buffer for their thread/session
- Bud online/offline state is only locally known
- in-flight agent/run behavior becomes instance-local

Conclusion:

- scale `service` vertically first
- do not scale it horizontally until Bud connection routing and event distribution are moved to shared infrastructure

### 3. Edge/proxy buffering can break SSE

The protocol docs already state:

- SSE responses must disable proxy buffering

This matters if you put Cloudflare, nginx, Caddy, an AWS load balancer stack, or any other proxy layer in front of `service`.

Conclusion:

- any front door must preserve streaming behavior for `/api/threads/:id/agent/stream` and `/api/threads/:id/terminal/stream`
- this needs explicit validation in staging, not just functional API tests

### 4. Health checks are too shallow for real readiness

`service/src/server.ts` exposes `/healthz`, but it only returns static process metadata. It does not verify:

- database connectivity
- auth schema availability
- ability to serve Bud traffic

Render explicitly recommends operation-critical health checks such as a simple DB query.

Conclusion:

- `/healthz` is okay as a liveness endpoint
- production should add a readiness endpoint, or strengthen the existing health check, before using it as the deploy gate

### 5. Deploy automation is incomplete

There is currently no checked-in deployment manifest such as:

- `render.yaml`
- `Dockerfile`
- `Procfile`

There is also no checked-in deploy pipeline for:

- database migrations
- environment grouping
- root-directory/build-filter setup for monorepo deploys

Conclusion:

- the repo is not yet "push button deploy" ready for Render
- a `render.yaml` should be part of the follow-up implementation tranche

### 6. Database migration strategy needs a production decision

Current repo reality:

- local development still centers on `pnpm db:push`
- several docs explicitly say production should use checked-in migrations via `pnpm db:migrate`
- auth-schema bootstrapping has had enough complexity that migration parity has been a recurring concern

For deployment, this matters because `db:push` should not become the production migration path.

Conclusion:

- do not run `db:push` automatically in production
- for the first Render prototype, use either:
  - a manual migration step, or
  - a `preDeployCommand` running `pnpm db:migrate`, but only after re-validating clean-database parity for the auth schema

### 7. Documentation and env guidance currently drift

The repo has conflicting public-origin guidance:

- `service/.env.example`, `service/README.md`, and `web/README.md` all point toward the `5173` public-origin proxy model
- the root `README.md` still describes a `3000`-origin Better Auth callback setup

This is not a code bug, but it is a deployment risk because provider callback URLs and auth origins must be exact in production.

Conclusion:

- the env model should be normalized before production rollout

### 8. Node/runtime pinning is incomplete

The repo docs say the Vite 7 web toolchain needs Node `20.19+` or `22.12+`, but:

- `web/package.json` has no `engines` field
- there is no root `.node-version` or `.nvmrc`

Conclusion:

- Render deploy config should pin `NODE_VERSION`
- otherwise the web build may drift onto an incompatible default image/runtime

### 9. Database connection budgeting may bite small plans

The service uses two Postgres pools:

- main app pool: `service/src/db/client.ts`
- auth pool: `service/src/auth/auth.ts`

Both default to `PG_POOL_MAX=10`, which means the service can open roughly 20 DB connections per instance before considering admin tools or migration commands.

Conclusion:

- budget DB connections explicitly for small managed Postgres plans
- if the backend stays single-instance, this is manageable, but it should be documented

### 10. Some production-hardening items are still explicitly TODOs

Notable examples already called out in specs:

- no rate limiting on WebSocket messages
- `DEV_BUD_TOKEN_BYPASS` exists and must stay unset in production

These are not blockers for a prototype deployment, but they are real production hardening gaps.

## Render-Specific Notes

### What already fits Render well

- `service` already binds `HOST` and `PORT`, so it matches Render's web-service model
- `web` is a static Vite app, which matches Render Static Site well
- Render supports inbound WebSocket connections on web services
- Render supports monorepo root directories and build filters
- Render supports `preDeployCommand` in `render.yaml`

These traits make Render a good staging host for Bud's prototype environment.

### What needs explicit setup on Render

For `web`:

- root directory: `web`
- build command: `pnpm install && pnpm build`
- publish directory: `dist`
- SPA rewrite: `/* -> /index.html`

For `service`:

- root directory: `service`
- build command: `pnpm install && pnpm build`
- start command: `pnpm start`
- health check path: `/healthz` initially, with a follow-up to strengthen readiness
- explicit `NODE_VERSION`

For the monorepo:

- separate build filters so `web` changes do not redeploy `service`, and vice versa

For the database:

- use managed Postgres from Render or an external provider
- keep it on a private/internal connection path where possible

### Render's generic multi-service guidance does not match Bud's browser model

Render's multi-service architecture guide presents the common pattern of:

- frontend at one public URL
- backend at a different public URL
- frontend configured with the backend's public URL via environment variables

That is a valid Render pattern for many apps, but it is not the right default for Bud today.

Why it does not fit:

- Bud's browser and hosted-auth flow are same-origin in practice
- Bud wants `/api/auth/*`, `/.well-known/*`, `/api/*`, and `/ws` under one public hostname
- the Bud daemon also derives its claim/bootstrap HTTP origin from its configured WebSocket origin
- adopting the generic Render pattern would push us toward split public frontend/backend domains, which Bud is not production-ready for today

Conclusion:

- do not treat Render's generic multi-service guide as Bud's target topology
- treat it as evidence that Render supports separate services, not evidence that Render solves Bud's one-origin routing requirements by itself

### Render-specific same-domain note

Render's static-site rewrites can target a full public URL, which suggests a possible Render-only routing pattern where the static site rewrites `/api/*` or `/.well-known/*` to a backend service URL.

However, the docs do not clearly establish whether this is the right mechanism for:

- WebSocket upgrade traffic on `/ws`
- long-lived SSE streams
- proxy-buffering-sensitive routes

Inference:

- this is worth testing in a sandbox
- it should not be the default architecture for Bud without validation

## Cloud-Agnostic Topology Options

### Option A: One public domain, edge-routed to separate web and service

Shape:

- `web` hosted as static assets/CDN
- `service` hosted as a public app service
- an edge/router layer sends:
  - `/api/*` -> `service`
  - `/.well-known/*` -> `service`
  - `/ws` -> `service`
  - everything else -> `web`

Examples:

- Cloudflare in front of Render
- CloudFront + ALB / ECS / EC2 on AWS
- Google Cloud HTTPS Load Balancer + backend services
- any ingress/reverse-proxy layer that supports path routing, WebSockets, and unbuffered SSE

Pros:

- best match for the current same-origin browser/auth model
- lets `web` and `service` deploy independently
- keeps future scaling options open
- keeps one clean public origin for browser and hosted auth flows

Cons:

- adds an edge/router layer
- SSE buffering and timeout settings must be validated carefully

Fit for Bud today:

- best overall fit
- the right default for Render staging
- also the shape that maps most cleanly to AWS production if we move off Render later

### Option B: Single combined app service serving web and API together

Shape:

- one deployable unit serves static web assets and the Fastify backend from the same origin

Ways to do it:

- make `service` serve the built `web` assets
- or build a custom Docker image with a reverse proxy plus both app components

Pros:

- simplest domain/origin story
- no external edge split required

Cons:

- not how the repo is structured today
- loses independent scaling/deploys
- requires packaging work before deployment

Fit for Bud today:

- viable if the highest priority is shipping quickly with the fewest moving pieces
- less aligned with the desired long-term separation between `web` and `service`

### Option C: Split public domains (`app.` and `api.`)

Shape:

- `web` at `app.example.com`
- `service` at `api.example.com`

Pros:

- simple infra layout
- easy to reason about operationally
- natural fit for provider-native multi-service hosting

Cons:

- current browser auth/API flow is not production-ready for this
- needs explicit CORS + cookie + Better Auth cross-origin work
- adds more callback/origin configuration complexity

Fit for Bud today:

- good future option
- not the recommended first production deployment shape for the browser app

### Option D: Render-only static-site rewrite front door

Shape:

- `web` as Render Static Site
- rewrite selected paths to the Render-hosted backend service

Pros:

- potentially simple if it works end to end
- no third-party edge layer required

Cons:

- unvalidated for Bud's `/ws` and long-lived SSE needs
- documentation is not strong enough to treat this as proven

Fit for Bud today:

- experimental option only

## Recommended Prototype / Staging Deployment

### Recommended shape

Use Option A.

- Deploy `web` as a static site.
- Deploy `service` as a single Render web service.
- Deploy Postgres as managed Postgres.
- Put one public domain in front of both services with path-based routing.
- Keep `service` single-instance.

### Why this is the right default

It is the best balance of:

- simple operational model
- compatibility with the current auth/browser architecture
- clean path to future scaling
- separation of web and backend deploy units

### Staging vs production posture

For Bud today, this recommendation splits into two platform decisions:

- **Staging / prototype**: Render is acceptable and still the fastest path to a real HTTPS environment for mobile testing.
- **Production**: keep the provider choice open until after staging validation. If we want a cleaner first-class path-routing edge story with fewer provider-specific workarounds, AWS is currently the leading candidate.

This is not because AWS fixes Bud's single-instance backend constraint. It does not.

It is because AWS has a more explicit native path-routing story for:

- one hostname
- multiple origins/backends
- WebSocket-capable paths
- a static frontend plus an API/backend split

That makes AWS a cleaner production successor once the staging environment proves the current Bud contracts end to end.

### Public routing contract

Recommended public routing:

- `/api/*` -> `service`
- `/.well-known/*` -> `service`
- `/ws` -> `service`
- `/healthz` -> `service`
- everything else -> `web`

Optional:

- route a future `/readyz` to `service` as the real deploy-gate endpoint

### Env model for this topology

If the single public origin is `https://app.example.com`:

- `APP_BASE_URL=https://app.example.com`
- `BETTER_AUTH_URL=https://app.example.com`
- `API_AUDIENCE=https://app.example.com/api`
- browser app can leave `VITE_API_BASE_URL` unset because traffic is same-origin
- Bud daemon can use `BUD_SERVER_URL=wss://app.example.com/ws`

This keeps:

- browser auth same-origin
- Better Auth callbacks same-origin
- daemon bootstrap HTTP routes derivable from the daemon's WS URL

### Service scaling rule

For the first production deployment:

- run exactly one `service` instance
- scale vertically, not horizontally

Do not scale horizontally until Bud routing and event distribution move out of process-local memory.

### Migration rule

For the first deployment:

- do not run `db:push` in production
- prefer a manual migration step unless `pnpm db:migrate` is revalidated for a clean production bootstrap

After migration parity is confirmed:

- move schema application into Render `preDeployCommand`

## Production Successor Note

If the team decides Render is only a staging host, the cleanest production successor is currently:

- static web assets behind CloudFront
- service behind an ALB or equivalent app origin
- one CloudFront distribution with path-based behaviors for `/api/*`, `/.well-known/*`, `/ws`, and app routes

That maps closely to Bud's desired one-origin model without requiring the frontend to proxy backend traffic.

It does not change the existing backend constraints:

- `service` should still remain single-instance until Bud connection and SSE state move out of process-local memory
- split browser/API domains are still a follow-up project, not the default production browser shape

## Follow-Up Implementation Work

Before or alongside the first real deployment, the next engineering tranche should do the following:

1. Add a `render.yaml` that declares:
   - one static site for `web`
   - one web service for `service`
   - Postgres
   - root directories
   - build filters
   - `NODE_VERSION`
2. Add a real readiness endpoint with a DB check.
3. Normalize README/env documentation around production public origins.
4. Decide whether the public front door is:
   - Cloudflare in front of Render, or
   - another edge/router layer
5. Document a hard rule that `service` stays single-instance until distributed session/event infrastructure exists.
6. If split-domain browser deployment remains desirable, scope a follow-up project for:
   - CORS
   - cookie policy
   - Better Auth cross-origin behavior
   - SSE credential semantics

## Bottom Line

For Bud's current codebase, the simplest robust production-like deployment is not "one Render service for everything," not "Render's generic split frontend/backend URL pattern," and not "separate browser/API domains."

It is:

- separate `web` and `service` deploy units
- one public domain
- path-based routing at the edge
- one backend instance

That gives us a production-like staging setup on Render without forcing the browser/auth model into a topology it is not yet ready to support, while keeping AWS or another edge-friendly provider open for production.

## References

- [Render Multi-Service Architectures](https://render.com/docs/multi-service-architecture)
- [Render Blueprint YAML Reference](https://render.com/docs/blueprint-spec)
- [Render Monorepo Support](https://render.com/docs/monorepo-support)
- [Render Default Environment Variables](https://render.com/docs/environment-variables)
- [Render Health Checks](https://render.com/docs/health-checks)
- [Render WebSockets](https://render.com/docs/websocket)
- [Render Private Services](https://render.com/docs/private-services)
- [Render Static Site Redirects And Rewrites](https://render.com/docs/redirects-rewrites)
- [Render Custom Domains](https://render.com/docs/custom-domains)
- [Amazon CloudFront Cache Behavior Settings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html)
- [Amazon CloudFront WebSocket Support](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html)
