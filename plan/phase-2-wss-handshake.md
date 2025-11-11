# Plan: Phase 2 — WSS Handshake & Presence

## Context
- Link to issue(s): _TBD (Phase 2 tracking issue)_
- Related docs/sections in `/plan/proof-of-concept.md`: §3.1 Bud, §3.2 Backend (wsGateway/registry), §4 Protocol, §11 Phase 2 DoD.

## Objective
- Implement the `hello` ⇄ `hello_ack` enrollment/reauth handshake between Bud and the backend over WSS.
- Maintain an in-memory + DB-backed registry of online Buds (status/last_seen/session).
- Enforce heartbeats/timeout detection; offline Buds must transition status in Postgres and surface via `/api/buds`.
- Lay the groundwork for dispatching `run`/`cancel` messages by establishing a per-connection router.

## Design / Approach
- **WS Gateway (backend/service)**:
  - Add a Fastify/WS handler that upgrades to WSS, parses JSON frames, and validates `proto:"0.1"`.
  - On first `hello` with enrollment token: verify token (hashed in DB), mint `bud_id` + `device_secret`, persist identity, respond with `hello_ack`.
  - On reconnect: verify HMAC using stored secret + nonce, rotate session id, update `last_seen_at` + set status `online`.
  - Track each active Bud in a registry map `{ bud_id -> session }` (includes ws socket, heartbeat timeout, queue length).
  - Emit heartbeat pings (or expect heartbeats from Bud) every 30s; mark offline after 90s silence, update DB + notify registry watchers (SSE later).
- **Bud agent**:
  - Extend the CLI scaffold to load/save `~/.bud/identity.json`.
  - Implement WSS connection loop with backoff, send `hello`, handle `hello_ack`, and respond to heartbeat pings.
  - For now, just log `run` commands without executing until Phase 3; focus on handshake + presence updates.
- **DB interactions**:
  - When Bud comes online/offline, update `bud.status` + `last_seen_at`.
  - On first enrollment, store `device_secret` server-side and write same identity to Bud’s filesystem.
- **Security**:
  - Enrollment tokens hashed (`HMAC(secret, token)`), single-use, expire after 24h.
  - Device secret used to sign reconnect nonce; keep protocols versioned to allow future upgrades.

## Impacted contracts
- [x] WSS protocol
- [ ] SSE events
- [ ] DB schema (migration) — existing tables suffice
- [ ] Agent adapter/tool registry
- [ ] Web UI surfaces (will reflect new `online` status via `/api/buds`)

## Test plan
- Unit-style tests (Rust + TS) for hello parsing/HMAC validation helpers.
- Manual flow:
  1. Run backend + Postgres.
  2. Generate enrollment token (`pnpm db:seed` or dedicated command).
  3. Start Bud with `--server ws://localhost:3000/ws --token <TOKEN>`.
  4. Observe Bud receives `hello_ack`, identity file created.
  5. Stop Bud; confirm backend marks it offline after heartbeat timeout and `/api/buds` reflects status flip.
- Simulate invalid token and invalid HMAC to ensure backend rejects with `AUTH_FAILED`.

## Rollout
- Update `/docs/proto.md` with the concrete message schemas (no version bump if we stay within 0.1 contract).
- Document enrollment flow + required env vars in `service/README.md` and `bud/README.md`.
- Provide troubleshooting steps for handshake failures (common errors, logs).

## Out of scope
- Dispatching actual `run` commands or cancel semantics (Phase 3/5).
- SSE updates/event fanout (Phase 4/6).
- Production-ready multi-tenant auth; we keep enrollment tokens simple for the PoC.
