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

- Leave `VITE_API_BASE_URL` unset
- Set `VITE_API_PROXY_TARGET=http://localhost:3000`

That keeps browser requests same-origin from the web app’s perspective while proxying `/api/*` and `/.well-known/*` to the service, which is the simplest local auth setup.

For the local iOS auth flow, `http://localhost:5173` is also the public auth origin. The service still listens on `http://localhost:3000`, but OAuth discovery, authorize, token, revoke, and `/api/me` should all be consumed through the proxied `5173` origin.

Optional:

- `VITE_API_BASE_URL=http://localhost:3000`
  Use this only if you want direct cross-origin API calls instead of the Vite proxy. It is not the recommended browser deployment shape today.
- `VITE_ROUTER_DEVTOOLS=true`
- `VITE_SHOW_SYSTEM_MESSAGES=false`

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
