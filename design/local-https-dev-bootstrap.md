# Design: Local HTTPS Dev Bootstrap

Status: Implemented; local runtime validation pending

Audience: Backend, web, mobile, and local-dev tooling

Last updated: 2026-05-17

Update: Phase 8a of the web-proxy plan moved generated local HTTPS proxy
endpoint hosts from wildcard `.localhost` to `*.bud-show.test` with explicit
local DNS. The app/API/auth origin remains `https://localhost:3443`.

## 1. Context

Bud's local HTTPS profile uses Caddy and mkcert so the web app, backend OAuth issuer, and mobile app can all talk to one public development origin:

```text
https://localhost:3443
```

That profile is the right shape for local mobile auth because it exercises secure-cookie behavior, hosted OAuth pages, OAuth metadata, JWKS, and `/api/me` through the same public origin the mobile app sees.

The recent mobile `/api/me` failure exposed an avoidable configuration burden. The service process minted a JWT through the local OAuth provider, then verified the bearer token by fetching JWKS from:

```text
https://localhost:3443/api/auth/jwks
```

A default Node process did not trust the mkcert leaf chain for that public HTTPS URL. Starting Node with the mkcert root fixed the issue:

```sh
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
```

The failure mode was subtle because the verifier eventually surfaced as an auth failure rather than an obvious TLS trust error. The fix is also easy to forget because `NODE_EXTRA_CA_CERTS` must be present before the Node process starts; adding it only to an application-loaded `.env` file is not a reliable solution.

## 2. Goals

- Provide one obvious local HTTPS entry point that developers can run without remembering mkcert-specific environment variables.
- Preserve `https://localhost:3443` as the public OAuth issuer, API audience, auth bundle origin, and JWKS URL.
- Make local HTTPS startup fail early with actionable diagnostics when mkcert, Caddy, cert files, ports, or OAuth metadata are misconfigured.
- Keep the normal HTTP quickstart available for non-mobile and non-HTTPS work.
- Avoid insecure TLS bypasses and avoid making backend-local JWKS overrides the default path.

## 3. Non-Goals

- Redesigning the OAuth provider or bearer verifier.
- Changing production deployment topology.
- Replacing mkcert or managing OS trust stores directly.
- Auto-mutating developer secrets or provider credentials.
- Making Caddy mandatory for every Bud development workflow.

## 4. Decision

Add an opt-in local HTTPS bootstrap in `dev/` and make it the official way to run the Caddy + mkcert profile.

The bootstrap should:

1. Resolve the mkcert CA root with `mkcert -CAROOT`.
2. Validate that `<CAROOT>/rootCA.pem` exists.
3. Start all Node processes that may call the local public HTTPS origin with `NODE_EXTRA_CA_CERTS=<CAROOT>/rootCA.pem` in their process environment.
4. Own the long-running service, web app, and Caddy HTTPS processes for this profile.
5. Run preflight probes against the public origin and print focused remediation steps on failure.

The preferred developer command should be repo-root and memorable:

```sh
pnpm dev:https
```

Package-local commands may still exist, but the root command should be the documented path for mobile/OAuth local HTTPS development. Because the repo currently has only package-local `package.json` files under `service/` and `web/`, implementing this command likely requires adding a minimal root script surface.

## 5. Resolved Decisions

- `pnpm dev:https` owns all long-running local HTTPS processes. Developers should not have to manually start service, web, and Caddy in separate shells for the default HTTPS workflow.
- `pnpm dev:https:setup` owns repo-local certificate generation. It should generate the Caddy leaf certificate files rather than only printing the `mkcert` command.
- `pnpm dev:https:check` stays simple: it checks already-running services and fails if they are absent. It does not need a `--start` mode in the first implementation.
- Service-side structured logging for JWKS fetch failures is out of scope for this plan. The bootstrap and check commands should make the local TLS trust failure easy enough to diagnose; deeper service logging can be added separately if needed.

## 6. Proposed Command Surface

### 6.1 `pnpm dev:https:setup`

One-time setup, certificate generation, and validation.

Responsibilities:

- confirm `mkcert` is installed
- ensure the local mkcert root exists and is installed for local development
- confirm `caddy` is installed
- generate the repo-local Caddy certificate files with mkcert
- check local wildcard DNS for `smoke.bud-show.test -> 127.0.0.1`
- print the generated paths and the public HTTPS origin
- avoid mutating the OS trust store from `pnpm dev:https`; only the explicit setup command may do that work

Candidate cert path contract:

```text
.certs/bud-local.pem
.certs/bud-local-key.pem
```

Candidate generation command:

```sh
mkcert -install
mkcert -cert-file .certs/bud-local.pem -key-file .certs/bud-local-key.pem localhost 127.0.0.1 ::1 bud-show.test "*.bud-show.test" bud-proxy.localhost "*.bud-proxy.localhost"
```

### 6.2 `pnpm dev:https`

Primary local HTTPS launcher.

Responsibilities:

- derive `NODE_EXTRA_CA_CERTS` from `mkcert -CAROOT`
- spawn the service process with the derived CA trust
- spawn the web process with the same environment for consistency
- start Caddy with the local HTTPS Caddyfile
- forward logs with clear process prefixes
- wait for service, web, and Caddy readiness before declaring the profile ready
- fail fast with `pnpm dev:https:setup` guidance if the mkcert root or repo-local cert files are missing
- handle `SIGINT` / `SIGTERM` by shutting down child processes cleanly

The service `pnpm dev` command should remain available and unchanged. `pnpm dev:https` is an opt-in profile, not a replacement for the basic development loop.

### 6.3 `pnpm dev:https:check`

Fast preflight that can run independently of the long-running launcher.

This command should check already-running services only. If service, web, or Caddy are not running, it should fail with the missing prerequisite rather than trying to start them.

Required checks:

```text
GET https://localhost:3443/.well-known/oauth-protected-resource/api
GET https://localhost:3443/api/auth/.well-known/openid-configuration
GET https://localhost:3443/api/auth/jwks
```

The JWKS check should use a Node fetch process started with the same `NODE_EXTRA_CA_CERTS` value that the launcher uses. This directly tests the failure class that caused `/api/me` to reject otherwise-valid local mobile access tokens.

Recommended assertions:

- protected-resource metadata advertises `https://localhost:3443/api`
- issuer metadata advertises `https://localhost:3443/api/auth`
- JWKS returns at least one key
- service and web public-origin config agree on `https://localhost:3443`
- the backend service is not advertising `http://localhost:3000` as the public issuer in the HTTPS profile

### 6.4 `pnpm dev:https:provision-ios`

Wrapper for local iOS OAuth provisioning.

Responsibilities:

- run the existing local OAuth provisioning script under the HTTPS profile
- set `NODE_EXTRA_CA_CERTS` before Node starts
- emit the final auth bundle values that iOS should use

This avoids a second fatigue point where provisioning and runtime use subtly different local trust and origin settings.

## 7. Implementation Shape

Use a small dependency-light Node script under `dev/`, for example:

```text
dev/local-https.mjs
```

The script should be mostly orchestration and diagnostics, not application configuration logic.

Suggested behavior:

- expose subcommands such as `setup`, `start`, `check`, and `provision-ios`
- derive mkcert root by executing `mkcert -CAROOT`
- construct child-process environments with `NODE_EXTRA_CA_CERTS`
- own child-process lifecycle for service, web, and Caddy in `start`
- preserve existing environment variables and add only the HTTPS-profile values needed by the child process
- read `.env.https.example` files as documentation inputs only; do not write secrets into `.env`
- print a `--print-env` mode for developers who need to run commands manually

The launcher should prefer explicit profile selection over implicit detection. A developer running `pnpm --dir service dev` directly should get the normal service behavior. A developer running `pnpm dev:https` should get the full HTTPS profile and preflight assumptions.

## 8. Environment Contract

For the HTTPS profile, the public-origin contract remains:

```text
APP_BASE_URL=https://localhost:3443
BETTER_AUTH_URL=https://localhost:3443
API_AUDIENCE=https://localhost:3443/api
```

The web app should keep using same-origin API calls in this profile. `VITE_API_BASE_URL` should remain unset unless a specific test requires a split origin.

Generated local proxy endpoint hosts use:

```text
PROXY_BASE_DOMAIN=bud-show.test
```

That domain requires explicit local wildcard DNS. The launcher should validate
`smoke.bud-show.test` before declaring the HTTPS profile ready and should print
a dnsmasq runbook rather than writing `/etc/resolver` automatically.

The launcher-owned process environment adds:

```text
NODE_EXTRA_CA_CERTS=<mkcert CAROOT>/rootCA.pem
```

`OAUTH_JWKS_VERIFY_URL=http://127.0.0.1:3000/api/auth/jwks` may remain a backend escape hatch if implemented later, but it should not be the default local HTTPS fix. The default should verify through the public HTTPS JWKS URL so local development matches the mobile-facing issuer and metadata path.

## 9. Why Not the Alternatives

### 9.1 Put `NODE_EXTRA_CA_CERTS` only in `.env`

This is insufficient. Node reads `NODE_EXTRA_CA_CERTS` during process startup. Application-level dotenv loading happens after Node has already started, so a plain `.env` entry can be too late for the process trust store.

`.env.https.example` can still document the variable, but the reliable fix is a parent launcher that sets it before starting Node.

### 9.2 Default to a backend-local JWKS URL

An explicit local JWKS override can make verification work:

```text
OAUTH_JWKS_VERIFY_URL=http://127.0.0.1:3000/api/auth/jwks
```

That should remain a fallback rather than the primary path. It creates split verifier behavior where the public OAuth metadata says one thing and the backend validates against another origin. That can hide the exact class of local HTTPS trust problems this profile is supposed to catch.

### 9.3 Disable TLS verification for local development

Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0` or an equivalent custom insecure fetch path. It weakens too much behavior and makes local OAuth validation less representative of the real mobile integration.

### 9.4 Rely on runbook memory

Teaching every developer to prepend `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` to the correct commands does not scale. It is easy to miss the service, provisioning scripts, test probes, or future Node tools that call the public HTTPS origin.

## 10. Rollout Plan

1. Add the `dev/local-https.mjs` bootstrap with `setup`, `start`, `check`, and `provision-ios` subcommands.
2. Add repo-root package scripts for `dev:https`, `dev:https:setup`, `dev:https:check`, and `dev:https:provision-ios`.
3. Keep existing package-local `dev` scripts unchanged.
4. Update the local HTTPS docs in `service/README.md`, `web/README.md`, and the relevant `dev/` docs to point mobile/OAuth work at the root HTTPS command.
5. Keep service verifier logging unchanged unless a future debugging pass explicitly needs it.

## 11. Validation Plan

Before implementation is considered done:

- `pnpm dev:https:setup` installs/validates the mkcert local root and generates `.certs/bud-local.pem` plus `.certs/bud-local-key.pem`.
- `pnpm dev:https` starts service, web, and Caddy and shuts them down cleanly on interrupt.
- `pnpm dev:https:check` succeeds against a running Caddy + service + web HTTPS profile.
- `pnpm dev:https:check` fails clearly when the profile is not already running.
- A default Node fetch to `https://localhost:3443/api/auth/jwks` still fails without the mkcert CA, confirming the check covers the real trust boundary.
- The same fetch succeeds through the launcher-managed `NODE_EXTRA_CA_CERTS` environment.
- The iOS local OAuth flow can exchange a code, call `GET https://localhost:3443/api/me`, and receive the authenticated user.
- The normal non-HTTPS `pnpm --dir service dev` and `pnpm --dir web dev` workflows still run without requiring Caddy or mkcert.

## 12. Specs and Docs to Update When Implementing

- `dev/dev.spec.md`
- `dev/caddy/caddy.spec.md`
- `plan/dev-https-setup-script/dev-https-setup-script.spec.md`
- `service/service.spec.md`
- `service/src/scripts/scripts.spec.md`
- `web/web.spec.md`
- `service/README.md`
- `web/README.md`
- `bud.spec.md`

## 13. Deferred Questions

- Whether to add CI-like smoke orchestration later. The first `check` command intentionally stays simple and does not start processes.
- Whether a future service-auth debugging pass should add structured verifier logging. This design does not require it.
