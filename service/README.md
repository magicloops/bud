# Bud Service

Fastify backend for browser auth, Bud device claims, REST/SSE APIs, and the Bud WebSocket gateway.

## Setup

```bash
cd service
pnpm install
cp .env.example .env
```

Create a Postgres database, then apply the schema:

```bash
createdb bud
pnpm db:push
```

Start the service:

```bash
pnpm dev
```

## Required Env For Local Auth Testing

Use [service/.env.example](./.env.example) as the source of truth.

The critical auth/device-claim values are:

- `DATABASE_URL`
  For local Postgres this can stay plain. Hosted providers such as Render often require SSL, in which case the URL should include `?sslmode=require`.
- `APP_BASE_URL`
  The browser origin Bud should print in claim links. With local Vite dev, use `http://localhost:5173`.
- `BETTER_AUTH_URL`
  The public auth origin exposed through the Vite proxy. For local iOS auth, use `http://localhost:5173` even though the Fastify process itself still listens on `http://localhost:3000`.
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_TRUSTED_ORIGINS`
  For the default local setup: `http://localhost:5173,http://localhost:3000`
- `OAUTH_TRUSTED_CLIENT_IDS`
  For the default local setup: `bud-ios-dev-local`
- `API_AUDIENCE`
  For the local iOS flow: `http://localhost:5173/api`
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

OAuth callback URLs for local dev:

- GitHub: `http://localhost:5173/api/auth/callback/github`
- Google: `http://localhost:5173/api/auth/callback/google`

Local topology for hosted iOS auth:

- public app/auth origin: `http://localhost:5173`
- Fastify service process: `http://localhost:3000`
- for day-to-day local browser/workbench development, prefer `VITE_API_BASE_URL=http://localhost:3000` so API and SSE traffic bypass the Vite-origin connection pool
- the Vite proxy for `/api/*` and `/.well-known/*` remains available when you explicitly want public-origin/auth-topology parity on `5173`
- `BETTER_AUTH_TRUSTED_ORIGINS` also acts as the service CORS allowlist, so direct local testing with `VITE_API_BASE_URL=http://localhost:3000` works as long as the web origin is included there

If you are testing from another machine or phone, replace `localhost` with your LAN host in:

- `APP_BASE_URL`
- `BETTER_AUTH_URL`
- `BETTER_AUTH_TRUSTED_ORIGINS`
- provider callback URLs
- the Bud daemon `BUD_SERVER_URL`
- the web app `VITE_API_PROXY_TARGET` or `VITE_API_BASE_URL`

## Optional Local HTTPS

Local HTTPS is not required for day-to-day service development. Use
[service/.env.https.example](./.env.https.example) only when validating the
web-proxy or mobile OAuth parity path through Caddy and mkcert.

In the HTTPS profile:

- Fastify still listens on `http://127.0.0.1:3000`.
- Caddy exposes app/auth/API/SSE/Bud WebSocket traffic at
  `https://localhost:3443`.
- Caddy exposes proxy endpoint hosts at
  `https://<slug>.bud-show.test:3443`.
- The proxy endpoint base domain requires local wildcard DNS:
  `*.bud-show.test -> 127.0.0.1`.
- `PROXY_PUBLIC_SCHEME=https` and `PROXY_PUBLIC_PORT=3443` make generated
  proxied-site URLs and viewer cookies match the Caddy front door.
- `PROXY_VIEWER_COOKIE_NAME=__Host-bud_proxy_viewer` keeps private viewer
  cookies host-only for each endpoint host.

OAuth callback URLs for local HTTPS:

- GitHub: `https://localhost:3443/api/auth/callback/github`
- Google: `https://localhost:3443/api/auth/callback/google`

The package-local `pnpm dev` command is unchanged for normal HTTP service work.
For the HTTPS profile, prefer the repo-root launcher:

```bash
pnpm dev:https:setup
pnpm dev:https
```

`pnpm dev:https:setup` also checks that `smoke.bud-show.test` resolves to
`127.0.0.1` and prints the dnsmasq runbook if local DNS is missing. `pnpm
dev:https` owns the service dev server, the web dev server, and Caddy. It also
injects `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` before starting
Node so service-side OAuth/JWKS verification trusts the local mkcert CA. Do
not rely on adding `NODE_EXTRA_CA_CERTS` only to `service/.env`; Node reads
that variable during process startup, before application dotenv loading.

## Prototype Deployment Contract

For the current prototype deployment, keep browser and hosted auth traffic on one public origin even though `web` and `service` deploy separately.

Recommended deployed values with public origin `https://bud.example.com`:

- `APP_BASE_URL=https://bud.example.com`
- `BETTER_AUTH_URL=https://bud.example.com`
- `API_AUDIENCE=https://bud.example.com/api`
- `OAUTH_TRUSTED_CLIENT_IDS=<published-first-party-client-ids>`

Public routing contract:

- `/api/*` -> `service`
- `/.well-known/*` -> `service`
- `/ws` -> `service`
- everything else -> `web`

Operational constraints for the prototype environment:

- keep `service` single-instance
- keep browser/API traffic same-origin
- use `/readyz` as the deploy/readiness check and keep `/healthz` as lightweight liveness
- if the hosted Postgres provider requires TLS, add `sslmode=require` to `DATABASE_URL`
- set provider callbacks to the same public origin:
  - `https://bud.example.com/api/auth/callback/github`
  - `https://bud.example.com/api/auth/callback/google`
- Bud daemons should target the same public origin via `BUD_SERVER_URL=wss://bud.example.com/ws`
- use `pnpm db:migrate` in staging or other deployed environments; keep `pnpm db:push` for local development only
- publish the first-party mobile client ids in `OAUTH_TRUSTED_CLIENT_IDS`
- run the environment-specific iOS provisioning script before handing the bundle to mobile

## Optional Env

Auth and Bud claim testing do not require an LLM provider key, and the service now boots cleanly without one. Chat/agent execution still needs at least one configured provider.

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DEFAULT_MODEL` (defaults to `gpt-5.5`)
- `AGENT_REASONING_EFFORT` (defaults to `low`)
- `OPENAI_MODEL`
- `AGENT_MAX_STEPS`
- `AGENT_DEBUG`

`/api/models` is the source of truth for first-party model IDs and valid `reasoning_effort` values. Current product IDs include `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-7`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, and `gpt-5.5`.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start Fastify with `tsx watch`. |
| `pnpm build` | Compile TypeScript to `dist/`. |
| `pnpm start` | Run the compiled server. |
| `pnpm lint` | Run ESLint. |
| `pnpm db:push` | Bootstrap Better Auth tables/schema and push Drizzle schema changes. |
| `pnpm db:migrate` | Apply checked-in migrations for production-like environments. |
| `pnpm db:migrate:staging` | Apply checked-in migrations using `.env.staging`. |
| `pnpm db:studio` | Open Drizzle Studio. |
| `pnpm db:seed` | Seed manual enrollment-token data for dev. |
| `pnpm oauth:provision:ios-local` | Upsert the fixed local iOS OAuth client and print the exact local auth bundle. |
| `pnpm oauth:provision:ios-staging` | Upsert the fixed staging iOS OAuth client and print the staging auth bundle using `.env.staging`. |

Local development for this repo uses `db:push`. Staging uses `db:migrate` against the checked-in migration chain.

`pnpm oauth:provision:ios-local` prints the bundle from the active
`service/.env`. For the optional mkcert+Caddy HTTPS profile, prefer the
repo-root wrapper so mkcert trust and public-origin values are applied before
Node starts:

```bash
pnpm dev:https:provision-ios
```

Confirm the printed bundle uses:

- `app_origin: https://localhost:3443`
- `issuer: https://localhost:3443/api/auth`
- `audience: https://localhost:3443/api`

## Local Test Flow

1. Start the service with `pnpm dev`.
2. Start the web app from [web/](../web).
3. Run `pnpm oauth:provision:ios-local` to create or verify the fixed local iOS client and print the current bundle.
4. Start the Bud daemon from [bud/](../bud).
5. Verify:
   - `http://localhost:5173/api/auth/.well-known/openid-configuration` resolves
   - `/api/me` returns `401` before login and the normalized user after login
   - Bud prints a claim link + QR
   - approving the claim creates or reuses the Bud and the daemon reconnects over `/ws`

## New Environment Checklist

When creating a new non-local environment, make sure all of these are true together:

1. `APP_BASE_URL`, `BETTER_AUTH_URL`, and `API_AUDIENCE` all point at the same public origin bundle for that environment.
2. `DATABASE_URL` includes the provider's required SSL settings when using a hosted Postgres service.
3. `OAUTH_TRUSTED_CLIENT_IDS` includes the first-party mobile client ids published for that environment.
4. Provider callback URLs point at `https://<public-origin>/api/auth/callback/{provider}`.
5. If hosted web views are enabled through Cloudflare, `PROXY_PUBLIC_SCHEME`,
   `PROXY_BASE_DOMAIN`, `PROXY_GATEWAY_ENABLED`, `PROXY_VIEWER_COOKIE_NAME`,
   and `PROXY_EDGE_SECRET` match the Worker route for `*.bud.show`.
6. The matching iOS provisioning script has been run against that environment's database before sharing the auth bundle.

## Notes

- Better Auth is mounted at `/api/auth/*`.
- Current-user normalization is served from `/api/me`.
- Device-claim bootstrap lives at `/api/device-auth/*`.
- Internal service ownership is now split so thread transport lives under `src/routes/threads/`, terminal runtime helpers live under `src/runtime/terminal/`, and the Bud WebSocket connection state machine lives in `src/ws/bud-connection.ts`.
- Agent orchestration is now split so `src/agent/` has dedicated conversation-loader, model-runner, terminal-tool-executor, transcript-writer, and cancellation modules instead of one large runtime file owning every concern.
- `/readyz` is the intended deploy/readiness check; `/healthz` is lightweight liveness.
- Local iOS auth should target the public `http://localhost:5173` origin, not the private service port.
- The prototype deployment keeps `APP_BASE_URL` and `BETTER_AUTH_URL` on the same public origin.
