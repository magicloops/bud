# Persist Thread Model Preferences Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Service Default, Schema, And Resolver

### Defaults

- [x] `GET /api/models.default_model` is `gpt-5.5`
- [x] `GET /api/models.service_default_model` is `gpt-5.5`
- [x] `GET /api/models.default_reasoning_effort` is `low`
- [x] omitted reasoning for `gpt-5.5` resolves to `low`

### Schema

- [x] `thread.model_id` exists in schema
- [x] `thread.reasoning_effort` exists in schema
- [x] migration SQL adds both columns
- [x] migration SQL does not touch `user_profile`
- [x] migration applies locally through `pnpm db:push`
- [ ] checked-in migration can be applied through `pnpm db:migrate`

### Resolver

- [x] explicit valid request beats thread selection
- [x] valid thread selection beats service default
- [x] service default is used when no request/thread selection exists
- [x] unavailable stored thread model falls back to service default
- [ ] invalid explicit model returns `400 invalid_model`
- [x] invalid explicit reasoning returns `400 invalid_reasoning_effort`
- [x] omitted/null reasoning persists a concrete resolved value

## Phase 2: Service API

### Thread Reads

- [x] thread list includes `model`
- [x] thread list includes `reasoning_effort`
- [x] thread list includes `effective_model`
- [x] thread list includes `effective_reasoning_effort`
- [x] thread list includes `model_selection_source`
- [x] thread detail includes the same fields
- [x] old null-selection thread returns effective service default
- [ ] cross-user thread read remains `404`

### Thread Writes

- [x] PATCH owned thread with valid selection succeeds
- [ ] PATCH cross-user thread returns `404`
- [ ] PATCH unauthenticated request returns `401`
- [ ] PATCH invalid model returns `400 invalid_model`
- [ ] PATCH invalid reasoning returns `400 invalid_reasoning_effort`
- [x] PATCH `model: null` returns `400 invalid_model`
- [x] PATCH omitted/null reasoning stores selected model default

### Thread Creation

- [x] creating a thread with explicit selection stores that selection
- [x] creating a thread without explicit selection stores `gpt-5.5` + `low`
- [ ] creating a thread with invalid model fails before insert
- [ ] creating a thread with invalid reasoning fails before insert
- [-] created thread response intentionally remains `{ thread_id }`; stored/effective selection is verified through thread detail/list after creation

### Message Send

- [x] explicit message selection updates thread selection
- [x] message send without explicit selection uses stored thread selection
- [x] message send on old null-selection thread stores service default
- [x] unsupported explicit reasoning fails before agent start
- [ ] duplicate retry does not change selection differently

### Message Metadata

- [x] user message metadata includes `model`
- [x] user message metadata includes `reasoning_effort`
- [x] user message metadata includes `model_selection_source`
- [x] assistant message metadata includes the same turn selection
- [x] tool message metadata includes the same turn selection
- [x] existing metadata fields are preserved

## Phase 3: Web

- [x] new-thread route initializes to `gpt-5.5` + `low`
- [x] first new-thread submit sends model/reasoning to `POST /api/threads`
- [x] first new-thread submit sends model/reasoning to `POST /messages`
- [x] created thread opens with submitted selection
- [x] refresh preserves created thread selection
- [x] existing-thread route initializes from thread effective fields
- [x] existing-thread selector change calls PATCH
- [x] changing reasoning persists after refresh
- [x] changing model persists after refresh
- [x] stale pending PATCH does not override the message submit selection
- [x] failed PATCH leaves composer usable

## Phase 4: Automated And Manual Closeout

### Automated

- [x] `pnpm --dir service test`
- [x] `pnpm --dir service build`
- [x] `pnpm --dir service lint`
- [x] `pnpm --dir web build`
- [x] `pnpm --dir web lint`
- [x] `git diff --check`

### Manual

- [x] new thread starts with GPT-5.5 low
- [x] new thread first message persists GPT-5.5 low
- [x] existing thread selection persists across refresh
- [ ] old null-selection thread shows effective default
- [ ] old null-selection thread backfills after send
- [ ] message metadata visible in DB for user/assistant/tool messages

### Docs / Spec Alignment

- [x] DB spec matches schema
- [x] migration spec lists the generated migration
- [x] route spec describes thread model fields and PATCH route
- [x] agent spec describes metadata persistence
- [x] LLM spec describes GPT-5.5 low default
- [x] web specs describe selector persistence
- [x] service README/env docs describe new default
- [x] mobile handoff notes describe the API contract

## Notes

- Live provider smoke tests are not required for this persistence rollout unless the implementation changes provider request shapes.
- `POST /api/threads` intentionally returns only `{ thread_id }`; clients that need stored/effective model selection should read the thread detail/list contract.
- If a command fails, capture the exact command and error output in a debug note and stop for human guidance.
