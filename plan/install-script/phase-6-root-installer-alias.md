# Phase 6: Root Installer Alias

## Objective

Support the short public landing-page command:

```sh
curl -fsSL https://get.bud.dev | sh
```

without changing the existing canonical installer path used by service-generated
commands:

```sh
curl -fsSL https://get.bud.dev/install.sh | sh
```

## Rationale

The root-domain command is easier to copy, easier to remember, and better for a
public marketing surface. The explicit `/install.sh` path remains useful for
service-generated commands, support docs, and debugging because it makes the
served resource obvious.

`get.bud.dev` is installer-only, so serving shell at `/` is acceptable. Do not
add user-agent based HTML/script switching; `curl | sh` should receive the same
script deterministically.

## Route Contract

The Worker should serve the same shell script for:

```text
GET  /
HEAD /
GET  /install.sh
HEAD /install.sh
```

Expected behavior:

- `GET /` returns the installer body
- `HEAD /` returns installer headers with an empty body
- response headers match `/install.sh`
- mutable installer responses use `Cache-Control: no-store`
- `/install.sh` remains supported indefinitely
- service-generated authenticated install commands keep using `/install.sh`
- unknown paths still return `404`
- unsupported methods still return `405`

Use a direct response, not an HTTP redirect, so the short command stays simple
and avoids an extra network hop.

## Implementation Areas

- `deploy/get-bud-dev/worker.js`
  - treat `/` and `/install.sh` as installer-script paths
- `deploy/get-bud-dev/worker.test.mjs`
  - add `GET /` and `HEAD /` tests
  - keep existing `/install.sh` tests
- `deploy/get-bud-dev/get-bud-dev.spec.md`
  - document root alias behavior
- `deploy/get-bud-dev/release-hosting.md`
  - document both public install command shapes
- `plan/install-script/implementation-spec.md`
  - mention root alias as a landing-page copy path
- `plan/install-script/validation-checklist.md`
  - add live validation checks for `GET /` and `HEAD /`

No service route changes are required for this phase.

## Test Plan

Local:

```sh
pnpm test:get-bud-dev
node --check deploy/get-bud-dev/worker.js
git diff --check
```

Live after promotion:

```sh
curl -fsSI https://get.bud.dev
curl -fsSL https://get.bud.dev | head
curl -fsSI https://get.bud.dev/install.sh
```

Do not run the installer during route validation unless intentionally performing
a clean-machine install test.

## Exit Criteria

- [x] `GET /` serves the installer script
- [x] `HEAD /` returns installer headers without a body
- [x] `/install.sh` remains unchanged
- [x] Worker tests cover root alias behavior
- [x] landing-page copy can use `curl -fsSL https://get.bud.dev | sh`
- [x] service-generated commands continue to use `/install.sh`
- [ ] live promoted Worker validates root alias behavior
