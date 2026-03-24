# Phase 4: Validation And Mobile Bundle

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Objective

Prove that the deployed staging environment behaves like the codebase expects, publish the final environment bundle the mobile team should target, and capture the post-validation platform decision.

By the end of this phase:

- the environment is validated against the real public origin
- the Bud daemon can claim and reconnect against the deployed stack
- the mobile team has a stable issuer/base-url/audience bundle
- the team can decide whether the validated topology stays on Render beyond staging or should move to AWS/another provider for production

---

## Scope

### In Scope

- deployed-environment smoke tests
- hosted auth validation
- Bud claim/bootstrap validation
- SSE and WebSocket validation
- mobile bundle publication
- operator notes and rollback guidance

### Out Of Scope

- scaling work beyond single-instance operation
- post-launch observability/platform work that is not needed for prototype mobile testing

---

## Expected Files And Areas

- `plan/deploy/validation-checklist.md`
- deployment notes under `plan/deploy/`
- `service/README.md` / `web/README.md` / `README.md` if the published environment guidance belongs there
- mobile handoff docs only if the new environment needs to be referenced from those artifacts

---

## Implementation Tasks

### Task 1: Validate public auth and discovery

Against the real deployed origin, verify:

- `/login`
- `/auth/mobile`
- `/auth/mobile/consent`
- `/api/auth/.well-known/openid-configuration`
- authorization-server metadata
- `/api/me`

The goal is to prove the public auth contract, not just route existence.

### Task 2: Validate Bud claim/bootstrap

Run a real Bud daemon against the deployed origin and confirm:

- device-auth start works
- claim URL resolves
- approval works
- daemon retrieves the approved secret
- daemon reconnects over `/ws`

### Task 3: Validate live streaming behavior

Confirm the deployed environment supports:

- agent SSE streaming
- terminal SSE streaming
- Bud daemon WebSocket stability

This phase should explicitly watch for buffering, timeout, and reconnect issues that may not appear locally.

### Task 4: Publish the mobile environment bundle

Document the values the mobile client should use:

- app/public base URL
- issuer/discovery URL
- API audience/resource
- any known callback or provider-facing values

This should be the single source of truth for the prototype environment.

### Task 5: Publish operator notes

Record:

- first deploy order
- migration order
- redeploy expectations
- rollback path
- known prototype limitations

### Task 6: Make the post-validation platform call

After the staging environment is validated, record one explicit decision:

- keep using Render beyond staging for now, or
- treat the validated Render environment as proof-of-shape and move the same one-origin topology to AWS or another provider for production

This phase does not require the migration to happen. It does require the team to avoid leaving the production-platform question implicit.

---

## Validation Checklist

- [ ] all items in [validation-checklist.md](./validation-checklist.md) are reviewed against the real environment
- [ ] browser login works through the public origin
- [ ] hosted mobile auth pages work through the public origin
- [ ] discovery and auth metadata resolve from the public origin
- [ ] Bud claim/bootstrap succeeds against the deployed environment
- [ ] the Bud daemon stays connected over `/ws`
- [ ] agent and terminal SSE behave correctly under the public front door
- [ ] the final mobile environment bundle is published
- [ ] prototype limitations are documented for the team
- [ ] the team has written down whether Render remains staging-only or continues toward production use

---

## Spec Updates Required

- [ ] `bud.spec.md`
- [ ] any touched README or handoff docs that should reference the deployed environment

---

## Exit Criteria

This phase is complete when:

1. the environment behaves correctly for browser, Bud, and mobile-facing auth flows,
2. the team has one published environment bundle to target,
3. known prototype limitations are explicit rather than tribal knowledge,
4. the production-platform decision is explicit instead of implied.

At that point the deployment is ready to support ongoing mobile iteration.

---

*Last Updated: 2026-03-23*
