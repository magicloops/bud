# Persist Thread Model Preferences Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet started or not yet verified
- `[x]` implemented and verified
- `[-]` deferred or intentionally out of scope

## Phase 1: Service Default, Schema, And Resolver

### Defaults

- [ ] service default model is `gpt-5.5`
- [ ] service default reasoning is `low`
- [ ] `/api/models` can report `default_reasoning_effort`
- [ ] docs/examples no longer claim Claude Opus 4.6 is the default when env is omitted

### Schema And Migration

- [ ] `thread.model_id` added to `service/src/db/schema.ts`
- [ ] `thread.reasoning_effort` added to `service/src/db/schema.ts`
- [ ] no user-profile preference columns added
- [ ] `pnpm db:push` run or failure captured
- [ ] `pnpm db:generate` run or failure captured
- [ ] generated migration reviewed

### Resolver

- [ ] shared resolver implemented
- [ ] explicit request wins
- [ ] thread selection wins when no explicit request exists
- [ ] service default wins when no thread selection exists
- [ ] invalid stored thread selection falls back without destructive cleanup
- [ ] omitted/null reasoning resolves to a concrete model default
- [ ] resolver tests added

## Phase 2: Thread API And Message Metadata

### API

- [ ] `/api/models` returns `gpt-5.5` + `low` defaults
- [ ] thread list returns stored/effective model fields
- [ ] thread detail returns stored/effective model fields
- [ ] `PATCH /api/threads/:thread_id/model-preference` implemented
- [ ] PATCH route enforces thread ownership
- [ ] PATCH route rejects `model: null`
- [ ] thread creation always stores selection
- [ ] message send resolves before agent start
- [ ] message send updates thread selection for explicit requests
- [ ] message send backfills old null-selection threads

### Metadata

- [ ] user message metadata records effective model/reasoning
- [ ] assistant message metadata records effective model/reasoning
- [ ] tool message metadata records effective model/reasoning
- [ ] metadata merges preserve `preferred_cwd`
- [ ] metadata merges preserve terminal/tool fields

## Phase 3: Web Selector Persistence

- [ ] web model/thread types updated
- [ ] shared model-selection hook/helper added
- [ ] new-thread selector initializes to service default
- [ ] existing-thread selector initializes from thread effective selection
- [ ] existing-thread selector changes call PATCH
- [ ] new-thread submit sends model/reasoning to thread create
- [ ] message submit keeps defensive model/reasoning payload
- [ ] invalid reasoning is normalized only when necessary
- [ ] refresh/remount no longer resets the selector

## Phase 4: Validation, Docs, And Mobile Handoff

### Validation

- [ ] service tests run
- [ ] service build run
- [ ] service lint run
- [ ] web build run if web changed
- [ ] web lint run if web changed
- [ ] `git diff --check` run
- [ ] manual new-thread persistence check complete
- [ ] manual existing-thread persistence check complete
- [ ] manual old-thread fallback/backfill check complete
- [ ] message metadata inspected

### Docs And Specs

- [ ] `service/src/db/db.spec.md` updated if DB schema changed
- [ ] `service/drizzle/migrations/migrations.spec.md` updated if migration generated
- [ ] `service/src/routes/routes.spec.md` updated if routes changed
- [ ] `service/src/agent/agent.spec.md` updated if agent/transcript code changed
- [ ] `service/src/llm/llm.spec.md` updated if catalog/default code changed
- [ ] `web/src/lib/lib.spec.md` updated if web lib changed
- [ ] `web/src/routes/$budId/budId.spec.md` updated if routes changed
- [ ] `web/src/components/workbench/workbench.spec.md` updated if composer changed
- [ ] `service/.env.example` updated
- [ ] `service/README.md` updated
- [ ] mobile handoff notes captured

## Overall Progress

| Phase | Status | Notes |
| --- | --- | --- |
| 1 | Not Started | Service foundation |
| 2 | Not Started | Thread APIs and metadata |
| 3 | Not Started | Web adoption |
| 4 | Not Started | Validation and docs |

## Notes

- Keep this checklist current during implementation.
- If a build/run command fails, capture the exact command and error output in a debug note and stop for human guidance.
