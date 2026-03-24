# Cloudflare Front Door Runbook

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)  
**Phase**: [phase-3-render-services-and-routing.md](./phase-3-render-services-and-routing.md)  
**Blueprint**: [../../render.yaml](../../render.yaml)

---

## Purpose

`render.yaml` defines the Render-hosted workloads, but it does not create the single public origin the current Bud browser/auth model expects.

For the prototype deployment, the recommended front door is:

- Cloudflare on the public hostname
- Render static site as the default origin for app traffic
- Render web service as the origin for API, auth, SSE, health, and Bud WebSocket traffic

This keeps the edge setup lightweight while preserving the current same-origin browser/auth contract.

This runbook should be read as:

- the default way to stand up the Render staging environment
- not proof that Render is the final production platform choice

## Render Origins

After the Blueprint is synced, Render will provision three resources:

- `bud-web`
- `bud-service`
- `bud-postgres`

Use the generated `.onrender.com` hostnames as origin targets behind Cloudflare:

- web origin: `https://<bud-web>.onrender.com`
- service origin: `https://<bud-service>.onrender.com`

Do not treat the direct Render hostnames as the public mobile/browser contract. The public contract should stay on one hostname such as `https://bud.example.com`.

## Public Routing Contract

The public hostname must route:

- `/api/*` -> `bud-service`
- `/.well-known/*` -> `bud-service`
- `/ws` -> `bud-service`
- `/readyz` -> `bud-service`
- `/healthz` -> `bud-service`
- everything else -> `bud-web`

## Recommended Cloudflare Shape

Use Cloudflare proxied DNS plus one path-based Origin Rule.

This is the lightest setup that still keeps:

- one public origin
- no extra app/container just for routing
- WebSocket and SSE traffic on the backend origin instead of the static site origin

If Phase 4 validation shows that Cloudflare Origin Rules are insufficient for Bud's SSE or `/ws` behavior, the next fallback should be either:

- a small Cloudflare Worker proxy for the Render staging environment, or
- moving the proven one-origin topology to a provider with a cleaner native edge-routing story, such as AWS

It should not be a browser/API domain split.

## Required Inputs

Before wiring Cloudflare, collect:

- public hostname, for example `bud.example.com`
- `bud-web` Render hostname
- `bud-service` Render hostname
- provider callback URLs that will move to the public hostname
- final service env values:
  - `APP_BASE_URL`
  - `BETTER_AUTH_URL`
  - `API_AUDIENCE`
  - `BETTER_AUTH_TRUSTED_ORIGINS`

## Cloudflare Setup

### 1. Create the default DNS origin

Create a proxied DNS record for the public hostname that points at the web origin.

Example:

- `bud.example.com` -> `bud-web.onrender.com` (proxied)

This makes the static app the default destination for unmatched paths.

### 2. Add the service path Origin Rule

Create one Cloudflare Origin Rule that matches Bud's service-owned paths:

```txt
(starts_with(http.request.uri.path, "/api/")) or
(starts_with(http.request.uri.path, "/.well-known/")) or
(http.request.uri.path eq "/ws") or
(http.request.uri.path eq "/readyz") or
(http.request.uri.path eq "/healthz")
```

For matching requests, override both:

- DNS record -> `bud-service.onrender.com`
- HTTP `Host` header -> `bud-service.onrender.com`

Leave all other paths on the default web origin.

### 3. Add a cache bypass rule for service paths

Add a Cloudflare Cache Rule using the same expression and set it to bypass cache.

The service-owned routes include:

- auth metadata and callback flows
- authenticated REST APIs
- long-lived SSE streams
- Bud WebSocket traffic

These paths must not be cached at the edge.

### 4. Keep WebSockets enabled

Ensure Cloudflare WebSockets support stays enabled for the zone.

Bud daemon traffic on `wss://bud.example.com/ws` depends on this.

### 5. Avoid extra edge features on service paths

Do not add edge behaviors on the service-matched paths that could alter or buffer responses, including:

- cache rules other than bypass
- HTML rewrites
- response transformations
- ad hoc auth products in front of `/api/*` or `/ws`

The prototype needs those routes to pass through cleanly.

## Render Service Env Bundle

Set the Bud service env vars to the final public origin, not the raw Render hostnames.

If the public hostname is `https://bud.example.com`, set:

- `APP_BASE_URL=https://bud.example.com`
- `BETTER_AUTH_URL=https://bud.example.com`
- `API_AUDIENCE=https://bud.example.com/api`
- `BETTER_AUTH_TRUSTED_ORIGINS=https://bud.example.com`

Provider callbacks should also move to the public origin:

- `https://bud.example.com/api/auth/callback/github`
- `https://bud.example.com/api/auth/callback/google`

Bud daemons should use:

- `BUD_SERVER_URL=wss://bud.example.com/ws`

## Deploy Order

1. Sync [../../render.yaml](../../render.yaml) to Render and create `bud-postgres`, `bud-service`, and `bud-web`.
2. Fill the `sync: false` service env vars in Render with the public-origin values and provider secrets.
3. Deploy `bud-service` and verify the direct origin responds on `/readyz`.
4. Deploy `bud-web` and verify the direct origin serves the SPA.
5. Create the Cloudflare proxied DNS record pointing the public hostname at `bud-web`.
6. Add the service-path Origin Rule and cache-bypass rule.
7. Update OAuth provider callback URLs to the public hostname.
8. Validate the public hostname against [validation-checklist.md](./validation-checklist.md).

## Agent Provider Note

`render.yaml` intentionally does not hardcode a model selection because the current codebase defaults to `claude-opus-4-5`.

Before validating agent flows, make the provider choice explicit in Render:

- if using Anthropic, provide `ANTHROPIC_API_KEY`
- if using OpenAI, provide `OPENAI_API_KEY` and set `DEFAULT_MODEL` or `OPENAI_MODEL` to an OpenAI model before the first agent test

Otherwise the deployed service can have provider/model drift even if the app deploy itself succeeds.

## Database Access Note

The Blueprint sets `bud-postgres` to internal-only access via `ipAllowList: []`.

That is appropriate for the prototype environment because:

- the service connects over Render's internal network
- migrations run from the service `preDeployCommand`
- mobile/browser testing does not need public database access

If the team later needs direct psql or admin-tool access from outside Render, widen DB ingress intentionally instead of making it part of the default prototype footprint.

## Rollback Entry Points

- If the backend deploy is unhealthy, roll back `bud-service` in Render first. The public Cloudflare rule can stay in place.
- If path routing is wrong, disable or edit the Cloudflare Origin Rule without redeploying either Render service.
- If the public origin is broken and rapid diagnosis matters more than cleanliness, temporarily test against the direct `bud-web.onrender.com` and `bud-service.onrender.com` origins to isolate whether the failure is in Render or the edge layer.

## Exit Condition

This runbook is complete when:

- the public hostname routes app and service traffic exactly as listed above
- provider callbacks and Bud daemon traffic use that same hostname
- Phase 4 validation confirms `/api/*`, `/.well-known/*`, SSE, and `/ws` all behave correctly through Cloudflare

---

*Last Updated: 2026-03-23*
