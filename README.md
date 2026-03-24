# Bud

Bud is a device-agent platform for AI-assisted terminal access across remote machines. The repo has three runnable packages:

- [bud/](./bud): Rust daemon that runs on the target machine
- [service/](./service): Fastify backend with Better Auth, REST/SSE, and Bud WebSocket gateway
- [web/](./web): React + Vite UI

Start with [AGENTS.md](./AGENTS.md) for repo rules and [bud.spec.md](./bud.spec.md) for architecture.

## Prereqs

- Node `20.19+` or `22.12+` for the Vite 7 web toolchain
- `pnpm`
- Rust stable toolchain
- PostgreSQL
- `tmux` on any machine running the Bud daemon

## Local Auth/Test Setup

1. Install dependencies:

```bash
cd service && pnpm install
cd ../web && pnpm install
```

2. Copy env templates:

```bash
cp service/.env.example service/.env
cp web/.env.example web/.env
cp bud/.env.example bud/.env
```

3. Fill the service auth vars in [service/.env.example](./service/.env.example):

- `APP_BASE_URL`
  For local Vite dev this is usually `http://localhost:5173`
- `BETTER_AUTH_URL`
  For local auth/iOS dev this is usually `http://localhost:5173` even though the Fastify process itself still listens on `http://localhost:3000`
- `API_AUDIENCE`
  Usually `http://localhost:5173/api` for the default local setup
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_TRUSTED_ORIGINS`
  Usually `http://localhost:5173,http://localhost:3000`
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

4. Configure OAuth callbacks:

- GitHub callback: `http://localhost:5173/api/auth/callback/github`
- Google callback: `http://localhost:5173/api/auth/callback/google`

If you are testing from another machine or a phone, replace `localhost` with your LAN host everywhere: `APP_BASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, the OAuth callback URLs, `VITE_API_PROXY_TARGET`, and `BUD_SERVER_URL`.

5. Create the database and push schema:

```bash
createdb bud
cd service
pnpm db:push
```

6. Start the backend:

```bash
cd service
pnpm dev
```

7. Start the web app:

```bash
cd web
pnpm dev
```

8. Start the Bud daemon:

```bash
cd bud
set -a; source .env; set +a
cargo run -- --terminal-enabled
```

Bud should print a claim URL and QR code. Open the web app or scan the QR, sign in with GitHub or Google, approve the device, and wait for the daemon to reconnect.

## Prototype Deployment Contract

The current prototype deployment shape is:

- `web` and `service` deploy separately
- browser and hosted auth traffic stay same-origin
- one public origin fronts app routes, `/api/*`, `/.well-known/*`, and `/ws`
- `service` stays single-instance for now

For a deployed prototype environment, use one public origin such as `https://bud.example.com`:

- `APP_BASE_URL=https://bud.example.com`
- `BETTER_AUTH_URL=https://bud.example.com`
- `API_AUDIENCE=https://bud.example.com/api`
- browser `VITE_API_BASE_URL` should usually stay unset
- Bud daemon `BUD_SERVER_URL` should be `wss://bud.example.com/ws`

Routing contract for the public origin:

- `/api/*` -> `service`
- `/.well-known/*` -> `service`
- `/ws` -> `service`
- everything else -> `web`

Checked-in deployment artifacts for this prototype shape:

- [render.yaml](./render.yaml): Render Blueprint for `web`, `service`, and PostgreSQL
- [plan/deploy/cloudflare-front-door-runbook.md](./plan/deploy/cloudflare-front-door-runbook.md): Cloudflare path-routing and deploy-order runbook for the single public origin

Database note:

- local development uses `pnpm db:push`
- deployed/prototype environments should use checked-in migrations, not `db:push`

## Local Run Order

- Terminal 1: `cd service && pnpm dev`
- Terminal 2: `cd web && pnpm dev`
- Terminal 3: `cd bud && set -a; source .env; set +a && cargo run -- --terminal-enabled`

## Package Docs

- [service/README.md](./service/README.md): backend setup, auth env, DB push, local testing
- [web/README.md](./web/README.md): frontend env and dev server setup
- [bud/README.md](./bud/README.md): daemon env, claim flow, and local launch

## Docs

- [docs/proto.md](./docs/proto.md): protocol shapes and versions
- [design/](./design): design docs
- [plan/](./plan): phased implementation plans
- [debug/](./debug): debugging notes
