# Bud Web

React + Vite frontend for browser login, device-claim approval, and the Bud workspace UI.

## Setup

```bash
cd web
pnpm install
cp .env.example .env
pnpm dev
```

## Env

Use [web/.env.example](./.env.example).

Recommended local setup:

- Set `VITE_API_BASE_URL=http://localhost:3000`
- Optionally keep `VITE_API_PROXY_TARGET=http://localhost:3000` if you still want proxied `/.well-known/*` / `/api/*` routes available through the Vite origin for specific auth-topology checks

This is now the preferred local browser/workbench setup. It keeps API and SSE traffic off the Vite origin, which avoids the same-browser multi-tab connection starvation we validated when each thread view holds both agent and terminal SSE streams open.

For the local iOS auth flow, `http://localhost:5173` is still the public auth origin. The service still listens on `http://localhost:3000`, and the Vite proxy remains available when you explicitly want same-origin/public-auth parity on `5173`.

Optional:

- `VITE_ROUTER_DEVTOOLS=true`
- `VITE_SHOW_SYSTEM_MESSAGES=false`

## Optional Local HTTPS

Local HTTPS is not required for normal web development. Use
[web/.env.https.example](./.env.https.example) only when validating browser
behavior through the mkcert+Caddy parity profile.

In the HTTPS profile:

- Vite still runs with `pnpm dev` on `http://localhost:5173`.
- Caddy exposes the app at `https://localhost:3443`.
- Caddy exposes generated proxy endpoint hosts at
  `https://<slug>.bud-show.test:3443`.
- Browser API and SSE calls stay same-origin through Caddy because
  `VITE_API_BASE_URL` is left unset.
- Caddy routes `/api/*`, `/.well-known/*`, and `/ws` directly to the service.

The proxy endpoint domain requires local wildcard DNS:
`*.bud-show.test -> 127.0.0.1`. The repo-root setup/check commands validate
that DNS before treating the HTTPS profile as ready.

The package-local `pnpm dev` command is unchanged for normal HTTP web work. For
the HTTPS profile, prefer the repo-root launcher:

```bash
pnpm dev:https:setup
pnpm dev:https
```

`pnpm dev:https` owns Vite, the service dev server, and Caddy. It forces
`VITE_API_BASE_URL` to an empty value for the Vite child process so browser API
and SSE calls stay same-origin through Caddy.

Open `https://localhost:3443` after the launcher reports ready. If Caddy
returns a 502 for `/`, confirm Vite is still running at
`http://localhost:5173`.

## Prototype Deployment Contract

For the current prototype deployment, the browser should still see one public origin even though `web` and `service` deploy as separate workloads behind it.

Recommended deployed browser behavior:

- leave `VITE_API_BASE_URL` unset
- serve the app from the same public origin used by hosted auth pages
- route `/api/*`, `/.well-known/*`, and `/ws` to `service`
- route non-API app paths to `web`

Cross-origin browser API mode is intentionally not the default deployment path for the current prototype.

## Local Run

Open the app at `http://localhost:5173` after starting the service from [service/](../service).

When using the optional HTTPS profile, open
`https://localhost:3443` instead.

The important routes for auth testing are:

- `/login`
- `/auth/mobile`
- `/auth/mobile/consent`
- `/devices/claim/$flowId`
- `/`

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run the Vite dev server. |
| `pnpm build` | Type-check and build the production bundle. |
| `pnpm preview` | Preview the production build locally. |
| `pnpm lint` | Run ESLint. |

## Notes

- Vite 7 requires Node `20.19+` or `22.12+`.
- For local phone/LAN testing, make sure the service `APP_BASE_URL` points at a web origin the phone can actually open.
- For the deployed prototype environment, the public browser origin should match `APP_BASE_URL` / `BETTER_AUTH_URL`.
