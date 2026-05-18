# Phase 2: Setup And Preflight

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented; runtime validation pending

---

## Objective

Make setup and verification explicit enough that local HTTPS failures are caught before mobile developers debug auth symptoms.

By the end of this phase:

- `pnpm dev:https:setup` generates repo-local Caddy certs
- `pnpm dev:https:check` validates the already-running public HTTPS profile
- JWKS fetching is proven through Node with the mkcert root loaded

## Scope

### In Scope

- mkcert setup and cert generation
- local `.test` DNS validation
- `.certs/` directory creation
- Caddy cert file validation
- simple service/web/Caddy running checks
- public HTTPS metadata fetches
- JSON response assertions for issuer, resource, and JWKS
- focused error messages for missing prereqs and TLS trust failures

### Out Of Scope

- starting processes from `dev:https:check`
- CI orchestration
- service bearer-verifier logging
- backend-local JWKS override implementation

## Setup Contract

Repo-root command:

```sh
pnpm dev:https:setup
```

Script mapping:

```sh
node dev/local-https.mjs setup
```

Expected behavior:

1. Verify `mkcert` exists.
2. Verify `caddy` exists.
3. Run or validate mkcert local root installation.
4. Create `.certs/` if needed.
5. Generate:

```text
.certs/bud-local.pem
.certs/bud-local-key.pem
```

Candidate generation command:

```sh
mkcert -cert-file .certs/bud-local.pem -key-file .certs/bud-local-key.pem localhost 127.0.0.1 ::1 bud-show.test "*.bud-show.test" bud-proxy.localhost "*.bud-proxy.localhost"
```

The command may run `mkcert -install` because `dev:https:setup` is an explicit setup action. It should print what it is about to do before mutating the local trust store.

## Check Contract

Repo-root command:

```sh
pnpm dev:https:check
```

Script mapping:

```sh
node dev/local-https.mjs check
```

Expected behavior:

1. Resolve `NODE_EXTRA_CA_CERTS` with `mkcert -CAROOT`.
2. Confirm service, web, and Caddy appear to be running.
3. Confirm `smoke.bud-show.test` resolves to `127.0.0.1`.
4. Fetch the public HTTPS OAuth endpoints with the mkcert root loaded.
5. Assert the returned metadata matches the HTTPS profile.
6. Exit non-zero with a focused message on failure.

This command should not start any processes. The first implementation stays simple: if the local HTTPS profile is absent, the check fails and tells the developer to run `pnpm dev:https`.

## Required Probes

Fetch:

```text
https://localhost:3443/.well-known/oauth-protected-resource/api
https://localhost:3443/api/auth/.well-known/openid-configuration
https://localhost:3443/api/auth/jwks
```

Required assertions:

- protected resource metadata advertises `https://localhost:3443/api`
- issuer metadata advertises `https://localhost:3443/api/auth`
- JWKS response contains a non-empty `keys` array
- JWKS fetch succeeds only through the launcher-managed mkcert CA trust path
- `smoke.bud-show.test` resolves to `127.0.0.1`

## Implementation Tasks

### Task 1: Implement setup

Add setup behavior to `dev/local-https.mjs`:

- command checks
- root CA installation/validation
- `.certs/` creation
- cert generation
- `.test` DNS validation with dnsmasq remediation output
- final summary with cert paths and public origin

### Task 2: Implement process-absent checks

Add non-invasive checks for:

- service on `127.0.0.1:3000`
- web on `localhost:5173`
- Caddy on `localhost:3443`

Keep the output prescriptive:

```text
Local HTTPS profile is not running. Start it with: pnpm dev:https
```

### Task 3: Implement HTTPS fetch probes

Use Node's built-in `fetch` from the same process after setting `NODE_EXTRA_CA_CERTS` before process startup where possible.

If the script cannot change Node trust for the already-running script process, run a child Node process for the HTTPS probes with `NODE_EXTRA_CA_CERTS` in its environment. This preserves the critical startup-time behavior.

### Task 4: Add semantic assertions

Parse JSON responses and assert:

- expected issuer
- expected resource
- non-empty JWKS

Do not treat a `200` alone as sufficient.

### Task 5: Wire checks into `dev:https`

After Phase 1 readiness waits complete, `dev:https` should run the same semantic check before printing final ready state.

## Validation Checklist

- [ ] removing `.certs/bud-local.pem` and running `pnpm dev:https:setup` regenerates it
- [ ] removing `.certs/bud-local-key.pem` and running `pnpm dev:https:setup` regenerates it
- [ ] `pnpm dev:https:check` fails when service/web/Caddy are not running
- [ ] `pnpm dev:https:check` fails clearly when `smoke.bud-show.test` does not resolve
- [ ] `pnpm dev:https:check` passes when `pnpm dev:https` is running and healthy
- [ ] `pnpm dev:https:check` catches wrong issuer metadata
- [ ] `pnpm dev:https:check` catches an empty JWKS
- [ ] `pnpm dev:https` does not announce ready until semantic checks pass

## Exit Criteria

This phase is done when setup can generate the local certs and check can prove the public HTTPS OAuth/JWKS path works through mkcert trust.
