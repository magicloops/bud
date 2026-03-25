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
- a small Cloudflare Worker attached only to Bud's service-owned paths
- Render web service as the Worker target for API, auth, SSE, health, and Bud WebSocket traffic

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

Use Cloudflare proxied DNS plus one small Worker attached only to Bud's service-owned paths.

This is the lightest setup that still keeps:

- one public origin
- no extra app/container just for routing
- WebSocket and SSE traffic on the backend origin instead of the static site origin
- static app traffic off the Worker path, keeping staging cost and latency lower

This shape is now the default because Cloudflare's host-header and DNS-record Origin Rule overrides are Enterprise-only, while a route-scoped Worker works on lower-tier plans and still preserves Bud's same-origin browser/auth contract.

If Phase 4 validation shows that the Worker path is insufficient for Bud's SSE or `/ws` behavior, the next fallback should be either:

- moving the proven one-origin topology to a provider with a cleaner native edge-routing story, such as AWS, or
- combining web+service behind a single app server or reverse proxy for staging

It should not be a browser/API domain split.

## Required Inputs

Before wiring Cloudflare, collect:

- confirmation that `bud.dev` is active on Cloudflare
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

### 0. Ensure the zone is actually on Cloudflare

If `bud.dev` is not already active on Cloudflare, add the zone to Cloudflare first and update the domain's nameservers in Squarespace before doing any hostname-level routing work.

Before changing nameservers:

- recreate any existing `A`, `CNAME`, `MX`, `TXT`, DKIM, SPF, or verification records in Cloudflare
- confirm the existing `bud.dev` DNS footprint so staging cutover does not break mail or unrelated subdomains

Cloudflare cannot apply Worker routes or proxied DNS behavior to `staging.bud.dev` until the parent zone is actually active there.

### 1. Attach the public hostname to `bud-web` in Render

Add the public hostname, for example `staging.bud.dev`, as a custom domain on `bud-web`.

Do not attach the same public hostname to `bud-service`.

In the default Worker-based shape:

- `bud-web` owns the public hostname at Render
- the Worker forwards service-owned paths to the raw `bud-service.onrender.com` origin

This keeps the default app traffic simple and avoids trying to make one Render custom domain belong to two services.

### 2. Create the default DNS origin

Create a proxied DNS record for the public hostname that points at the web origin.

Example:

- `bud.example.com` -> `bud-web.onrender.com` (proxied)

This makes the static app the default destination for unmatched paths.

If Cloudflare already has an `AAAA` record for the same hostname, remove it. Render's custom-domain guidance assumes IPv4-only origin routing.

### 3. Create the service-path Worker

Create a Worker whose only job is to forward Bud's service-owned paths to the Render service origin without buffering or rewriting the response body.

Worker environment:

- `SERVICE_ORIGIN=https://<bud-service>.onrender.com`

Recommended Worker code:

```js
const SERVICE_PREFIXES = ['/api/', '/.well-known/']
const SERVICE_EXACT_PATHS = new Set(['/ws', '/readyz', '/healthz'])

function isServicePath(pathname) {
  return SERVICE_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || SERVICE_EXACT_PATHS.has(pathname)
}

function forwardedPort(url) {
  if (url.port) {
    return url.port
  }
  return url.protocol === 'https:' ? '443' : '80'
}

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url)

    if (!isServicePath(incomingUrl.pathname)) {
      return fetch(request)
    }

    const serviceOrigin = new URL(env.SERVICE_ORIGIN)
    const upstreamUrl = new URL(request.url)
    upstreamUrl.protocol = serviceOrigin.protocol
    upstreamUrl.hostname = serviceOrigin.hostname
    upstreamUrl.port = serviceOrigin.port

    const headers = new Headers(request.headers)
    headers.delete('host')
    headers.set('x-forwarded-host', incomingUrl.host)
    headers.set('x-forwarded-proto', incomingUrl.protocol.replace(':', ''))
    headers.set('x-forwarded-port', forwardedPort(incomingUrl))
    headers.set('x-bud-edge-router', 'cloudflare-worker')

    const upstreamRequest = new Request(upstreamUrl.toString(), {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    })

    return fetch(upstreamRequest, { cache: 'no-store' })
  },
}
```

Notes:

- `cache: 'no-store'` keeps service subrequests off Cloudflare cache.
- The Worker preserves `x-forwarded-host` and `x-forwarded-proto` so Bud's auth layer can keep advertising `https://staging.bud.dev` even though the upstream request is sent to `bud-service.onrender.com`.
- The Worker returns the upstream response directly, which is the desired behavior for SSE.
- For `/ws`, the Worker should not inspect frames or terminate the WebSocket. It should only proxy the successful upgrade response from Render.

### 4. Attach the Worker only to service-owned routes

Add the Worker to these Cloudflare route patterns:

- `staging.bud.dev/api/*`
- `staging.bud.dev/.well-known/*`
- `staging.bud.dev/ws*`
- `staging.bud.dev/readyz*`
- `staging.bud.dev/healthz*`

Use the exact public hostname for the environment.

Notes:

- The wildcard on `/ws*`, `/readyz*`, and `/healthz*` is intentional because Cloudflare route matching includes query strings.
- Do not attach the Worker to `staging.bud.dev/*` unless you intentionally want all app traffic to pay the Worker hop.
- With the route-scoped approach, ordinary page loads and static assets continue to go directly from Cloudflare to `bud-web`.

### 5. Keep WebSockets enabled

Ensure Cloudflare WebSockets support stays enabled for the zone.

Bud daemon traffic on `wss://bud.example.com/ws` depends on this.

### 6. Avoid extra edge features on service paths

Do not add edge behaviors on the service-matched paths that could alter or buffer responses, including:

- cache rules that override the Worker's `no-store` service fetches
- HTML rewrites
- response transformations
- ad hoc auth products in front of `/api/*`, `/.well-known/*`, or `/ws`

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
5. Add the public hostname to `bud-web` in Render.
6. Ensure `bud.dev` is active on Cloudflare and existing DNS records are recreated there if nameservers are changing.
7. Create the Cloudflare proxied DNS record pointing the public hostname at `bud-web`.
8. Deploy the Cloudflare Worker with `SERVICE_ORIGIN=https://<bud-service>.onrender.com`.
9. Attach the Worker to the service-path route patterns.
10. Update OAuth provider callback URLs to the public hostname.
11. Validate the public hostname against [validation-checklist.md](./validation-checklist.md).

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

- If the backend deploy is unhealthy, roll back `bud-service` in Render first. The public Cloudflare DNS + Worker entrypoint can stay in place.
- If path routing is wrong, disable the Worker routes or redeploy a no-op Worker without redeploying either Render service.
- If the public origin is broken and rapid diagnosis matters more than cleanliness, temporarily test against the direct `bud-web.onrender.com` and `bud-service.onrender.com` origins to isolate whether the failure is in Render or the edge layer.

## Exit Condition

This runbook is complete when:

- the public hostname routes app and service traffic exactly as listed above
- provider callbacks and Bud daemon traffic use that same hostname
- Phase 4 validation confirms `/api/*`, `/.well-known/*`, SSE, and `/ws` all behave correctly through the Cloudflare Worker path

---

*Last Updated: 2026-03-24*
