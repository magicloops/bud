# Bud Proof of Concept

Bud is a deployable agent that lets users (and LLM copilots) run shell commands on remote machines through a secure backend. The proof-of-concept covers:

- **Bud** (`bud/`): Rust daemon that connects to the backend over WSS and executes commands.
- **Service** (`service/`): Node.js/TypeScript backend providing REST, SSE, WS gateway, and the LLM agent loop.
- **Web** (`web/`): Vite + React UI for chat threads, live logs, and cancel controls.

## Getting Started

1. Read [`AGENTS.md`](AGENTS.md) for repository rules and process (plans/debug notes, invariants, testing).
2. Review the high-level plan in [`plan/proof-of-concept.md`](plan/proof-of-concept.md) and per-phase plans in `plan/`.
3. Follow the scaffolding plan in [`plan/phase-0-scaffolding.md`](plan/phase-0-scaffolding.md) while building out each component.

Each subproject will document its own build/run steps once initialized:

| Path | Notes |
|------|-------|
| `bud/` | Rust crate (`cargo`). |
| `service/` | Node.js/TypeScript (`pnpm`, Fastify, SSE, WS gateway). |
| `web/` | Vite + React (TypeScript, `pnpm`). |

> Use `pnpm` for all JavaScript/TypeScript workspaces. Install dependencies with `pnpm install` inside each subproject and prefer `pnpm run <script>` for lifecycle commands.

## Docs

- [`docs/poc-plan.md`](docs/poc-plan.md): Pointers to scoped plans/tasks derived from the PoC roadmap.
- [`docs/proto.md`](docs/proto.md): Source of truth for protocol/schema versions (Bud ⇄ backend, SSE events, DB).

## Plans & Debug Notes

- Plans live in [`plan/`](plan/) using the template in `AGENTS.md`.
- Issues/bugs MUST have a [`debug/`](debug/) note before fixes.

## License

License decision is still pending (see `/plan/proof-of-concept.md §10`). Until chosen, contributions remain under the company’s copyright.
