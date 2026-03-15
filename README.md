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
  For local service dev this is usually `http://localhost:3000`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_TRUSTED_ORIGINS`
  Usually `http://localhost:3000,http://localhost:5173`
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

4. Configure OAuth callbacks:

- GitHub callback: `http://localhost:3000/api/auth/callback/github`
- Google callback: `http://localhost:3000/api/auth/callback/google`

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
