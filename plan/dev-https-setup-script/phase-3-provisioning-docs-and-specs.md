# Phase 3: Provisioning, Docs, And Specs

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented; mobile validation pending

---

## Objective

Close the local HTTPS workflow by wrapping iOS OAuth provisioning, updating docs/specs, and validating the mobile auth path that motivated the work.

By the end of this phase:

- local iOS OAuth provisioning has an HTTPS-profile command
- developers have a single documented local HTTPS workflow
- specs match the new dev tooling
- `/api/me` succeeds in the local mobile OAuth flow

## Scope

### In Scope

- `pnpm dev:https:provision-ios`
- local HTTPS setup docs
- service/web README updates
- dev and plan spec updates
- root documentation index updates
- validation checklist closeout

### Out Of Scope

- mobile app code changes
- Better Auth provider behavior changes
- bearer verifier logging
- production OAuth configuration

## Provisioning Contract

Repo-root command:

```sh
pnpm dev:https:provision-ios
```

Script mapping:

```sh
node dev/local-https.mjs provision-ios
```

Expected behavior:

1. Resolve and inject `NODE_EXTRA_CA_CERTS`.
2. Apply HTTPS-profile public-origin env:

```text
APP_BASE_URL=https://localhost:3443
BETTER_AUTH_URL=https://localhost:3443
API_AUDIENCE=https://localhost:3443/api
```

3. Run the existing service-local provisioning command:

```sh
pnpm --dir service oauth:provision:ios-local
```

4. Print the resulting local iOS auth bundle values.

The wrapper should reuse the existing provisioning implementation rather than duplicating database or OAuth-client logic in `dev/local-https.mjs`.

## Documentation Tasks

### Task 1: Update local HTTPS docs

Update docs to describe the new happy path:

```sh
pnpm dev:https:setup
pnpm dev:https
pnpm dev:https:check
pnpm dev:https:provision-ios
```

Docs should state that `pnpm dev:https` owns service, web, and Caddy.

### Task 2: Update service docs

Update `service/README.md` to explain:

- package-local `pnpm dev` remains the normal HTTP backend command
- mobile/OAuth local HTTPS work should use repo-root `pnpm dev:https`
- `NODE_EXTRA_CA_CERTS` is injected by the launcher and should not be manually copied into `.env` as the primary workflow

### Task 3: Update web docs

Update `web/README.md` to explain:

- package-local `pnpm dev` remains the normal web command
- the HTTPS profile serves the web app through Caddy at `https://localhost:3443`
- `VITE_API_BASE_URL` should remain unset for same-origin HTTPS profile testing unless a specific split-origin test needs it

### Task 4: Update specs

Update specs corresponding to touched files:

- `dev/dev.spec.md`
- `dev/caddy/caddy.spec.md`
- `service/service.spec.md`
- `service/src/scripts/scripts.spec.md`
- `web/web.spec.md`
- `bud.spec.md`
- `plan/dev-https-setup-script/dev-https-setup-script.spec.md`

### Task 5: Close validation

Run the validation checklist and document any failures for human follow-up.

Per repo instructions, if a build/run command fails, capture the exact command and error and stop for guidance.

## Validation Checklist

- [ ] `pnpm dev:https:provision-ios` runs the existing provisioning script under HTTPS-profile env
- [ ] generated auth bundle uses `https://localhost:3443`
- [ ] iOS local OAuth code exchange succeeds with the provisioned client
- [ ] `GET https://localhost:3443/api/me` succeeds with the mobile access token
- [ ] service README points mobile/OAuth local HTTPS work at the root command
- [ ] web README describes the Caddy-served HTTPS profile
- [ ] specs reflect the new script ownership
- [ ] progress and validation checklists are updated

## Exit Criteria

This phase is done when the local HTTPS workflow is documented, spec-aligned, and validated through the mobile OAuth `/api/me` path.
