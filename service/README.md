# Bud Service (Backend)

Node.js + TypeScript monolith that exposes REST, SSE, a WebSocket gateway for Buds, and the LLM agent loop. This scaffolding follows Phase 0 of the PoC plan and will gain full functionality in later phases.

## Scripts (pnpm)

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start Fastify with `tsx watch` for local development. |
| `pnpm build` | Type-check and emit JS to `dist/`. |
| `pnpm start` | Run the compiled server from `dist/`. |
| `pnpm lint` | Run ESLint (TypeScript-aware). |
| `pnpm db:generate` | Create a SQL migration from `src/db/schema.ts`. |
| `pnpm db:migrate` | Apply migrations to the database. |
| `pnpm db:seed` | Insert a seed bud + enrollment token (idempotent). |
| `pnpm db:studio` | Explore the schema using Drizzle Studio. |

## Environment

Create a `.env` file in this directory with values from `/plan/proof-of-concept.md` (e.g., `PORT`, `BASE_URL`, `DATABASE_URL`, `OPENAI_API_KEY`). `dotenv` is loaded automatically in `src/server.ts`.

For local development:

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/bud
ENROLLMENT_HASH_SECRET=dev-secret
SEED_ENROLLMENT_TOKEN=DEV-ENROLL-0001
```

You can run Postgres however you like (Docker, Supabase, etc.). A quick Docker example:

```bash
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bud postgres:16
pnpm db:migrate
pnpm db:seed
```

`pnpm dev` will then serve `/api/buds` from the seeded data and host the `/ws` gateway (enrollment + challenge/response + presence updates).

## Next milestones

1. Route `run`/`cancel` frames through active Bud sessions and persist execution metadata.
2. Add REST resources for threads, messages, and runs (beyond `/api/buds`).
3. Wire the SSE endpoint to an in-memory event buffer with DB backfill.
4. Introduce the agent loop + LLM adapter (OpenAI Responses API first).
