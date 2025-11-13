# Plan: Dev Enrollment Token Bypass

## Context
- Link to issue(s): _TBD (request to make local Bud enrollment easier)_
- Related docs: `AGENTS.md` (security posture), `/plan/proof-of-concept.md` Phase 2 (WSS handshake).

## Objective
- Allow local developers to run Bud without minting new enrollment tokens every time, while keeping production semantics unchanged.
- Introduce an opt-in “dev token” path that bypasses token consumption but cannot be enabled accidentally in real deployments.

## Design / Approach
- Add env/config flag on the service: `DEV_BUD_TOKEN_BYPASS` (string). Default empty/undefined.
- During `handleEnrollmentHello`, check:
  - If bypass flag is set AND the incoming token matches it, skip the `enrollment_token` table lookup and treat the hello as always valid. Mint `bud_id`/`device_secret` like normal, but do **not** insert/consume any token rows.
  - Else, fall back to existing logic (hash token, validate row, set `consumed_at`, etc.).
- Add log line clearly warning when bypass is used: `server.log.warn({ budId }, "Dev token bypass used")`.
- Document the flag in `service/README.md` and `.env.example` with text like “for local dev only; do not set in prod”.

## Impacted contracts
- [x] Backend config (`service/src/config.ts`)
- [x] WSS enrollment flow (`service/src/ws/gateway.ts`)
- [ ] Bud client (no change)
- [x] Docs/README/environments

## Test plan
- Unit-ish: Run backend with `DEV_BUD_TOKEN_BYPASS=DEV-ANY`.
  - Start Bud with `--token DEV-ANY`; ensure it enrolls even though no DB token exists.
  - Restart Bud without token and verify identity reauth still works.
  - Confirm that when bypass flag is unset, old behavior remains (token required, single-use).
- Manual DB inspection: ensure `enrollment_token` table is untouched when bypass used.

## Rollout
- Ship behind env flag off by default.
- Communicate to team via README + `PROGRESS.md`.
- No protocol/schema changes; no plan file updates beyond this doc.

## Out of scope
- Permanent multi-use tokens for production.
- Alternative auth methods (mTLS, etc.).
