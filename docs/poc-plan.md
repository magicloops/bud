# Bud PoC Task Index

This document tracks active plans derived from [`/plan/proof-of-concept.md`](../plan/proof-of-concept.md). Each plan should stay narrow, link back to the main PoC roadmap, and reference an issue/PR.

## Active Plans

| Phase / Scope | Plan doc | Notes |
|---------------|----------|-------|
| Phase 0 — Repo & Scaffolding | [`plan/phase-0-scaffolding.md`](../plan/phase-0-scaffolding.md) | Initialize repo structure, stub docs, and baseline tooling. |
| Phase 1 — Database & Schema | [`plan/phase-1-db-schema.md`](../plan/phase-1-db-schema.md) | Establish Postgres schema + migrations and seed initial data. |
| Phase 2 — WSS Handshake & Presence | [`plan/phase-2-wss-handshake.md`](../plan/phase-2-wss-handshake.md) | Implement hello/ack, registry, and Bud presence tracking. |
| Phase 3 — Exec Path (No Agent) | [`plan/phase-3-exec-path.md`](../plan/phase-3-exec-path.md) | Trigger shell runs via REST, execute on Bud, stream logs via SSE. |

Add rows here as new plans are created (Phase 1 schema work, Phase 2 WS handshake, etc.).

## Usage

1. When kicking off a substantial task, copy the template from `AGENTS.md` into `plan/<slug>.md`.
2. Link the new plan from the issue tracker and record it in the table above.
3. Update the plan as scope evolves (decisions, risks, DoD).

For bugs/outages, follow the `debug/` template instead.*** End Patch
