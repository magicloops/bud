# Persist Thread Model Preferences Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet started or not yet verified
- `[x]` implemented and verified
- `[-]` deferred or intentionally out of scope

## Phase 1: Service Default, Schema, And Resolver

### Defaults

- [x] service default model is `gpt-5.5`
- [x] service default reasoning is `low`
- [x] `/api/models` can report `default_reasoning_effort`
- [x] docs/examples no longer claim Claude Opus 4.6 is the default when env is omitted

### Schema And Migration

- [x] `thread.model_id` added to `service/src/db/schema.ts`
- [x] `thread.reasoning_effort` added to `service/src/db/schema.ts`
- [x] no user-profile preference columns added
- [x] `pnpm db:push` run or failure captured
- [x] `pnpm db:generate` run or failure captured
- [x] generated migration reviewed

### Resolver

- [x] shared resolver implemented
- [x] explicit request wins
- [x] thread selection wins when no explicit request exists
- [x] service default wins when no thread selection exists
- [x] invalid stored thread selection falls back without destructive cleanup
- [x] omitted/null reasoning resolves to a concrete model default
- [x] resolver tests added

## Phase 2: Thread API And Message Metadata

### API

- [x] `/api/models` returns `gpt-5.5` + `low` defaults
- [x] thread list returns stored/effective model fields
- [x] thread detail returns stored/effective model fields
- [x] `PATCH /api/threads/:thread_id/model-preference` implemented
- [x] PATCH route enforces thread ownership
- [x] PATCH route rejects `model: null`
- [x] thread creation always stores selection
- [x] message send resolves before agent start
- [x] message send updates thread selection for explicit requests
- [x] message send backfills old null-selection threads

### Metadata

- [x] user message metadata records effective model/reasoning
- [x] assistant message metadata records effective model/reasoning
- [x] tool message metadata records effective model/reasoning
- [x] metadata merges preserve `preferred_cwd`
- [x] metadata merges preserve terminal/tool fields

## Phase 3: Web Selector Persistence

- [x] web model/thread types updated
- [x] shared model-selection hook/helper added
- [x] new-thread selector initializes to service default
- [x] existing-thread selector initializes from thread effective selection
- [x] existing-thread selector changes call PATCH
- [x] new-thread submit sends model/reasoning to thread create
- [x] message submit keeps defensive model/reasoning payload
- [x] invalid reasoning is normalized only when necessary
- [x] refresh/remount no longer resets the selector

## Phase 4: Validation, Docs, And Mobile Handoff

### Validation

- [x] service tests run
- [x] service build run
- [x] service lint run
- [x] web build run if web changed
- [x] web lint run if web changed
- [x] `git diff --check` run
- [x] manual new-thread persistence check complete
- [x] manual existing-thread persistence check complete
- [ ] manual old-thread fallback/backfill check complete
- [ ] message metadata inspected

### Docs And Specs

- [x] `service/src/db/db.spec.md` updated if DB schema changed
- [x] `service/drizzle/migrations/migrations.spec.md` updated if migration generated
- [x] `service/src/routes/routes.spec.md` updated if routes changed
- [x] `service/src/agent/agent.spec.md` updated if agent/transcript code changed
- [x] `service/src/llm/llm.spec.md` updated if catalog/default code changed
- [x] `web/src/lib/lib.spec.md` updated if web lib changed
- [x] `web/src/routes/$budId/budId.spec.md` updated if routes changed
- [x] `web/src/components/workbench/workbench.spec.md` updated if composer changed
- [x] `service/.env.example` updated
- [x] `service/README.md` updated
- [x] mobile handoff notes captured

## Overall Progress

| Phase | Status | Notes |
| --- | --- | --- |
| 1 | Complete | Service default, schema, migration, and resolver are implemented and tested |
| 2 | Complete | Thread APIs and message metadata are implemented and covered by service tests |
| 3 | Complete | Web selector persistence is implemented, builds cleanly, and passed local manual persistence validation |
| 4 | Mostly Complete | Automated validation passed; old-null-thread fallback and DB metadata inspection remain optional manual checks |

## Notes

- Keep this checklist current during implementation.
- If a build/run command fails, capture the exact command and error output in a debug note and stop for human guidance.
