# Phase 1: Bootstrap And Process Owner

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented; runtime validation pending

---

## Objective

Add the repo-root command surface and launcher foundation so `pnpm dev:https` can own service, web, and Caddy as one local HTTPS profile.

By the end of this phase:

- repo-root `pnpm dev:https` exists
- `dev/local-https.mjs` exists
- service starts with the mkcert root in `NODE_EXTRA_CA_CERTS`
- web and Caddy are started by the same launcher
- interrupting the launcher terminates all child processes

## Scope

### In Scope

- minimal root `package.json` or equivalent root script surface
- `dev/local-https.mjs`
- child-process spawning for service, web, and Caddy
- `NODE_EXTRA_CA_CERTS` derivation from `mkcert -CAROOT`
- HTTPS profile environment overrides for child processes
- process prefix logging
- signal handling and cleanup
- basic readiness waits for service, web, and Caddy ports

### Out Of Scope

- cert generation
- JWKS/metadata preflight assertions
- iOS provisioning wrapper
- docs beyond minimal spec alignment for files touched in this phase
- service verifier logging

## Command Contract

Repo-root command:

```sh
pnpm dev:https
```

Script mapping:

```sh
node dev/local-https.mjs start
```

The command owns these long-running processes:

| Process | Working Directory | Command |
| --- | --- | --- |
| service | `service/` | `pnpm dev` |
| web | `web/` | `pnpm dev` |
| Caddy | repo root | `caddy run --config dev/caddy/Caddyfile.https-local` |

## Environment Contract

The launcher should derive:

```text
NODE_EXTRA_CA_CERTS=<mkcert CAROOT>/rootCA.pem
```

The service child process should receive at least:

```text
APP_BASE_URL=https://localhost:3443
BETTER_AUTH_URL=https://localhost:3443
API_AUDIENCE=https://localhost:3443/api
NODE_EXTRA_CA_CERTS=<mkcert CAROOT>/rootCA.pem
```

The web child process should preserve same-origin API behavior. Do not force `VITE_API_BASE_URL` to a split service origin for this profile.

## Implementation Tasks

### Task 1: Add root script surface

Add the smallest viable repo-root script surface for:

- `dev:https`
- `dev:https:setup`
- `dev:https:check`
- `dev:https:provision-ios`

Only `dev:https` needs to be functional in this phase. The other scripts may call placeholder subcommands that return a clear not-yet-implemented message until Phase 2/3 lands.

### Task 2: Add launcher command parser

Add `dev/local-https.mjs` with subcommand parsing for:

- `start`
- `setup`
- `check`
- `provision-ios`
- `--help`

Keep the script dependency-light and compatible with the repo's supported Node versions.

### Task 3: Add prerequisite resolution

Implement helpers for:

- checking command availability for `mkcert`, `caddy`, and `pnpm`
- resolving `mkcert -CAROOT`
- validating `<CAROOT>/rootCA.pem`
- validating `.certs/bud-local.pem`
- validating `.certs/bud-local-key.pem`

For Phase 1, missing certs should fail with guidance to run `pnpm dev:https:setup`.

### Task 4: Spawn and track child processes

Implement child-process ownership for service, web, and Caddy.

Requirements:

- prefix each child process log line with the process name
- preserve child environment plus launcher overrides
- track all child PIDs
- on `SIGINT` / `SIGTERM`, terminate every child
- if one child exits early, terminate the rest and exit non-zero

### Task 5: Wait for basic readiness

Add basic readiness waits before printing that the HTTPS profile is ready:

- service HTTP port is accepting connections on `127.0.0.1:3000`
- web HTTP port is accepting connections on `localhost:5173`
- Caddy HTTPS port is accepting connections on `localhost:3443`

Phase 2 will add semantic OAuth/JWKS checks.

## Validation Checklist

- [ ] `pnpm dev:https` starts service, web, and Caddy
- [ ] service logs show it started with HTTPS public-origin env
- [ ] interrupting `pnpm dev:https` stops all three processes
- [ ] if Caddy exits early, service and web are stopped
- [ ] missing cert files produce a clear `pnpm dev:https:setup` instruction
- [ ] package-local `pnpm --dir service dev` still works unchanged
- [ ] package-local `pnpm --dir web dev` still works unchanged

## Exit Criteria

This phase is done when the launcher owns the local HTTPS process group and reliably injects mkcert CA trust into Node child processes before they start.
