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
- Optional for the local HTTPS profile: `mkcert`, `caddy`, and local wildcard
  DNS for `*.bud-show.test`

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

## Optional Local HTTPS

The default local setup does not require Caddy or mkcert. Use this optional
profile when you need production-like browser behavior for proxied web views,
especially secure iframe cookies, split app/proxy sites, and WSS upgrades.

The checked-in HTTPS profile uses literal `localhost` for the app/auth/API
origin because Google OAuth accepts localhost but rejects arbitrary
`.localhost` hostnames as authorized origins. Proxied sites use a separate
reserved `.test` site with explicit local DNS so Safari and iOS WKWebView do
not depend on browser-specific wildcard `.localhost` behavior.

- App/auth/API/SSE/Bud WebSocket origin: `https://localhost:3443`
- Proxy endpoint hosts: `https://<slug>.bud-show.test:3443`

Install the local HTTPS tools once:

```bash
brew install mkcert caddy dnsmasq
```

Configure local wildcard DNS for proxy endpoints:

```bash
mkdir -p "$(brew --prefix)/etc/dnsmasq.d"
printf 'port=53\nlisten-address=127.0.0.1\naddress=/bud-show.test/127.0.0.1\n' > "$(brew --prefix)/etc/dnsmasq.d/bud-show.test.conf"
grep -q 'dnsmasq.d' "$(brew --prefix)/etc/dnsmasq.conf" 2>/dev/null || printf 'conf-dir=$(brew --prefix)/etc/dnsmasq.d/,*.conf\n' >> "$(brew --prefix)/etc/dnsmasq.conf"
sudo mkdir -p /etc/resolver
printf 'nameserver 127.0.0.1\n' | sudo tee /etc/resolver/test
sudo brew services restart dnsmasq
```

macOS note: `/etc/resolver/test` expects the scoped DNS server on port 53 for
this setup. Do not point it at dnsmasq running on a non-53 localhost port. If
`127.0.0.1:53` is unavailable, bind dnsmasq to a loopback alias on port 53 and
put that alias in `/etc/resolver/test`.

Verify DNS before continuing:

```bash
dscacheutil -q host -a name smoke.bud-show.test
```

Then run the repo-root setup command:

```bash
pnpm dev:https:setup
```

That command runs mkcert setup, generates the Caddy cert files in `.certs/`,
and checks that `smoke.bud-show.test` resolves to `127.0.0.1`. `mkcert
-install` may prompt for your macOS password because it adds a local CA to the
system trust store. Run setup in an interactive terminal if your editor or
agent shell cannot show the sudo prompt.

Use the HTTPS env examples as opt-in replacements or copy their values into
your existing local env files:

```bash
cp service/.env.https.example service/.env
cp web/.env.https.example web/.env
cp bud/.env.https.example bud/.env
```

Fill provider secrets in `service/.env`, then start the HTTPS profile from the
repo root:

```bash
pnpm dev:https
```

`pnpm dev:https` owns the service dev server, the web dev server, and Caddy. It
also injects `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` before
starting Node child processes so service-side OAuth/JWKS verification trusts
the local mkcert CA.

In another terminal, start the Bud daemon with the HTTPS env:

```bash
cd bud && set -a; source .env; set +a && cargo run -- --terminal-enabled
```

Check an already-running HTTPS profile with:

```bash
pnpm dev:https:check
```

Provision the local iOS OAuth client for the HTTPS profile with:

```bash
pnpm dev:https:provision-ios
```

Open `https://localhost:3443`. To switch back to the default HTTP flow, stop
`pnpm dev:https` and restore the default env values from the `.env.example`
files.
If Caddy returns a 502 for `/`, confirm the Vite web dev server is running at
`http://localhost:5173`; the HTTPS front door proxies app routes to that
server.

## Package Docs

- [service/README.md](./service/README.md): backend setup, auth env, DB push, local testing
- [web/README.md](./web/README.md): frontend env and dev server setup
- [bud/README.md](./bud/README.md): daemon env, claim flow, and local launch

## Docs

- [docs/proto.md](./docs/proto.md): protocol shapes and versions
- [design/](./design): design docs
- [plan/](./plan): phased implementation plans
- [debug/](./debug): debugging notes
