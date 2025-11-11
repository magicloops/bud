# Plan: Phase 0 Scaffolding

## Context
- Link to issue(s): _TBD_
- Related docs/sections in `/plan/proof-of-concept.md`: Phase 0 — Repo & Scaffolding

## Objective
- Stand up empty but runnable subprojects: `bud/` (Rust), `service/` (Node/TS), `web/` (Vite).
- Add initial docs placeholders (`docs/poc-plan.md`, `docs/proto.md`) referenced by the PoC plan.
- Ensure each subproject can install dependencies and run the default build/test command without errors.
- Set up shared tooling/config (gitignore, workspace README) to guide future contributors.

## Design / Approach
- Create the directory layout (`bud/`, `service/`, `web/`, `docs/`).
- Initialize Bud with `cargo init --bin` and add crate dependencies placeholders in `Cargo.toml` (no functionality yet).
- Initialize Backend with `npm create` (or manual) scaffolding using TypeScript + ts-node-dev + lint config.
- Initialize Web with Vite React TypeScript template.
- Add root-level README capturing repo overview and pointers to subprojects plus plan docs.
- Record base docs in `docs/poc-plan.md` (links back to `/plan/proof-of-concept.md`) and `docs/proto.md` (stub for protocol versioning).
- Configure shared `.gitignore`, editorconfig (optional), and root package metadata if needed.

## Impacted contracts
- [ ] WSS protocol
- [ ] SSE events
- [ ] DB schema (migration)
- [ ] Agent adapter/tool registry
- [ ] Web UI surfaces

## Test plan
- `cargo check` succeeds inside `bud/`.
- `npm install && npm run build` (or `ts-node-dev` start) succeed inside `service/`.
- `npm install && npm run build` succeeds inside `web/`.

## Rollout
- Document how to bootstrap each subproject in the root README.
- No migrations or protocol bumps in this phase.

## Out of scope
- Any functional logic (WS handshakes, DB, agent loop).
- Deployment automation and Docker packaging.
- UI pages beyond Vite template defaults.
