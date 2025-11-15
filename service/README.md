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
DEV_BUD_TOKEN_BYPASS=DEV-LOCAL-ONLY  # optional, for local testing
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
AGENT_MAX_STEPS=5
RUN_LOG_MAX_BYTES=104857600
AGENT_DEBUG=false                    # set true to log OpenAI/Bud debug info
```

You can run Postgres however you like (Docker, Supabase, etc.). A quick Docker example:

```bash
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bud postgres:16
pnpm db:migrate
pnpm db:seed
```

`pnpm dev` will then serve `/api/buds` from the seeded data and host the `/ws` gateway (enrollment + challenge/response + presence updates). If you set `DEV_BUD_TOKEN_BYPASS`, Bud can enroll with that token indefinitely (local/dev only!); otherwise you must generate a fresh enrollment token per device.

### Trigger a run

1. Enroll a Bud and ensure it shows `online` via `GET /api/buds`.
2. Create (or reuse) a thread for that Bud:

```bash
curl -X POST http://localhost:3000/api/threads \
  -H "Content-Type: application/json" \
  -d '{"bud_id":"b_dev_seed","title":"Dev shell"}'
```

Response:

```json
{ "threadId": "6d5fd8cb-..." }
```

3. Post a user message to the thread. This persists the prompt and kicks off the agent loop (planning → tool calls → final answer):

```bash
curl -X POST http://localhost:3000/api/threads/6d5fd8cb-.../messages \
  -H "Content-Type: application/json" \
  -d '{"text":"echo hello from bud","cwd":"~"}'
```

Response:

```json
{ "messageId": "9f3ab3d6-...", "runId": "run_01HX..." }
```

4. Stream logs/events for that run via SSE:

```bash
curl -N http://localhost:3000/api/runs/run_01HX.../stream
```

Events now include `status`, `agent.message`, `agent.tool_call`, `exec.stdout`, `exec.stderr`, `agent.tool_result`, and `final`. The legacy `POST /api/runs` endpoint still exists for quick experiments, but new surfaces should go through threads/messages so prompts are recorded and the agent can hydrate prior context.

### Inspect threads & messages

List threads (optionally filter by Bud):

```bash
curl http://localhost:3000/api/threads?bud_id=b_dev_seed
```

Fetch a single thread and its message history:

```bash
curl http://localhost:3000/api/threads/6d5fd8cb-...
curl http://localhost:3000/api/threads/6d5fd8cb-.../messages?limit=100
```

Responses include ULIDs/timestamps so the web UI (and agent) can replay context without bespoke queries.

## Next milestones

1. Route `/api/runs/:id/cancel` through active Bud sessions (TERM → KILL) and plumb cancel into the agent + OpenAI request.
2. Persist richer run metadata (workspace paths, tool summaries) and add history listing APIs for the web UI.
3. Add SSE replay/`Last-Event-ID` resume backed by a bounded in-memory buffer + DB rehydrate.
4. Harden reliability: queue backpressure, timeout enforcement, and better log truncation UX.
