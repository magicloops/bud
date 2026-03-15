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

That keeps browser requests same-origin from the web app’s perspective while proxying `/api/*` to the service, which is the simplest local auth setup.

Optional:

- `VITE_API_BASE_URL=http://localhost:3000`
  Use this only if you want direct cross-origin API calls instead of the Vite proxy.
- `VITE_ROUTER_DEVTOOLS=true`
- `VITE_SHOW_SYSTEM_MESSAGES=false`

## Local Run

Open the app at `http://localhost:5173` after starting the service from [service/](../service).

The important routes for auth testing are:

- `/login`
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
