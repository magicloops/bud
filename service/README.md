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
- `APP_BASE_URL`
  The browser origin Bud should print in claim links. With local Vite dev, use `http://localhost:5173`.
- `BETTER_AUTH_URL`
  The public auth origin exposed through the Vite proxy. For local iOS auth, use `http://localhost:5173` even though the Fastify process itself still listens on `http://localhost:3000`.
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_TRUSTED_ORIGINS`
  For the default local setup: `http://localhost:5173,http://localhost:3000`
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
- Vite proxies `/api/*` and `/.well-known/*` to the service so discovery, token exchange, revoke, and `/api/me` are all consumable from the public `5173` origin

If you are testing from another machine or phone, replace `localhost` with your LAN host in:

- `APP_BASE_URL`
- `BETTER_AUTH_URL`
- `BETTER_AUTH_TRUSTED_ORIGINS`
- provider callback URLs
- the Bud daemon `BUD_SERVER_URL`
- the web app `VITE_API_PROXY_TARGET` or `VITE_API_BASE_URL`

## Optional Env

Auth and Bud claim testing do not require an LLM provider key. Chat/agent execution does.

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DEFAULT_MODEL`
- `OPENAI_MODEL`
- `AGENT_MAX_STEPS`
- `AGENT_DEBUG`

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start Fastify with `tsx watch`. |
| `pnpm build` | Compile TypeScript to `dist/`. |
| `pnpm start` | Run the compiled server. |
| `pnpm lint` | Run ESLint. |
| `pnpm db:push` | Bootstrap Better Auth tables/schema and push Drizzle schema changes. |
| `pnpm db:studio` | Open Drizzle Studio. |
| `pnpm db:seed` | Seed legacy/manual enrollment-token data for dev. |
| `pnpm oauth:provision:ios-local` | Upsert the fixed local iOS OAuth client and print the exact local auth bundle. |

`db:generate` and `db:migrate` still exist in `package.json`, but local development for this repo uses `db:push`.

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

## Notes

- Better Auth is mounted at `/api/auth/*`.
- Current-user normalization is served from `/api/me`.
- Device-claim bootstrap lives at `/api/device-auth/*`.
- Local iOS auth should target the public `http://localhost:5173` origin, not the private service port.
