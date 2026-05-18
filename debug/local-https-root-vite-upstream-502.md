# Debug: Local HTTPS Root Vite Upstream 502

## Environment

- Local mkcert + Caddy HTTPS profile
- App URL: `https://localhost:3443`
- Caddy config: `dev/caddy/Caddyfile.https-local`
- Web dev server expected at `http://localhost:5173`
- Service dev server expected at `http://127.0.0.1:3000`

## Repro Steps

1. Start Caddy with the local HTTPS profile.
2. Open `https://localhost:3443`.
3. Observe a Caddy `502` for `/`.

## Observed

Caddy logged:

```text
dial tcp 127.0.0.1:5173: connect: connection refused
```

The `/` route in the HTTPS Caddyfile proxies app traffic to the Vite dev
server. A connection refusal means Caddy could not open a TCP connection to
the configured Vite upstream.

## Expected

When the web dev server is running, `https://localhost:3443` should load the
Vite app through Caddy. API, auth, and Bud WebSocket routes should continue to
route to the Fastify service.

## Hypotheses

- Most likely: the Vite dev server is not running.
- Also possible: Vite is listening on `localhost` / IPv6 loopback but not
  `127.0.0.1`, matching the earlier local-proxy target-host issue seen on this
  machine.

## Proposed Fix

- Keep documenting that the HTTPS profile requires the normal `web` dev server
  to be running.
- Change the Caddy app upstream from `127.0.0.1:5173` to `localhost:5173` so it
  matches the supported local web URL and avoids IPv4-only assumptions for
  Vite.
- Leave service upstreams on `127.0.0.1:3000` because the service and daemon
  WSS path have already validated successfully through Caddy in this profile.

Spec files affected:

- `dev/caddy/caddy.spec.md`
- `plan/web-proxy/phase-8-local-https-dev.md`
