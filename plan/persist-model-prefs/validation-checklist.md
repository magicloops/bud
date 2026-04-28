# Persist Thread Model Preferences Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Service Default, Schema, And Resolver

### Defaults

- [ ] `GET /api/models.default_model` is `gpt-5.5`
- [ ] `GET /api/models.service_default_model` is `gpt-5.5`
- [ ] `GET /api/models.default_reasoning_effort` is `low`
- [ ] omitted reasoning for `gpt-5.5` resolves to `low`

### Schema

- [ ] `thread.model_id` exists in schema
- [ ] `thread.reasoning_effort` exists in schema
- [ ] migration SQL adds both columns
- [ ] migration SQL does not touch `user_profile`
- [ ] migration applies locally through `pnpm db:push`
- [ ] checked-in migration can be applied through `pnpm db:migrate`

### Resolver

- [ ] explicit valid request beats thread selection
- [ ] valid thread selection beats service default
- [ ] service default is used when no request/thread selection exists
- [ ] unavailable stored thread model falls back to service default
- [ ] invalid explicit model returns `400 invalid_model`
- [ ] invalid explicit reasoning returns `400 invalid_reasoning_effort`
- [ ] omitted/null reasoning persists a concrete resolved value

## Phase 2: Service API

### Thread Reads

- [ ] thread list includes `model`
- [ ] thread list includes `reasoning_effort`
- [ ] thread list includes `effective_model`
- [ ] thread list includes `effective_reasoning_effort`
- [ ] thread list includes `model_selection_source`
- [ ] thread detail includes the same fields
- [ ] old null-selection thread returns effective service default
- [ ] cross-user thread read remains `404`

### Thread Writes

- [ ] PATCH owned thread with valid selection succeeds
- [ ] PATCH cross-user thread returns `404`
- [ ] PATCH unauthenticated request returns `401`
- [ ] PATCH invalid model returns `400 invalid_model`
- [ ] PATCH invalid reasoning returns `400 invalid_reasoning_effort`
- [ ] PATCH `model: null` returns `400 invalid_model`
- [ ] PATCH omitted/null reasoning stores selected model default

### Thread Creation

- [ ] creating a thread with explicit selection stores that selection
- [ ] creating a thread without explicit selection stores `gpt-5.5` + `low`
- [ ] creating a thread with invalid model fails before insert
- [ ] creating a thread with invalid reasoning fails before insert
- [ ] created thread response includes stored/effective selection

### Message Send

- [ ] explicit message selection updates thread selection
- [ ] message send without explicit selection uses stored thread selection
- [ ] message send on old null-selection thread stores service default
- [ ] unsupported explicit reasoning fails before agent start
- [ ] duplicate retry does not change selection differently

### Message Metadata

- [ ] user message metadata includes `model`
- [ ] user message metadata includes `reasoning_effort`
- [ ] user message metadata includes `model_selection_source`
- [ ] assistant message metadata includes the same turn selection
- [ ] tool message metadata includes the same turn selection
- [ ] existing metadata fields are preserved

## Phase 3: Web

- [ ] new-thread route initializes to `gpt-5.5` + `low`
- [ ] first new-thread submit sends model/reasoning to `POST /api/threads`
- [ ] first new-thread submit sends model/reasoning to `POST /messages`
- [ ] created thread opens with submitted selection
- [ ] refresh preserves created thread selection
- [ ] existing-thread route initializes from thread effective fields
- [ ] existing-thread selector change calls PATCH
- [ ] changing reasoning persists after refresh
- [ ] changing model persists after refresh
- [ ] stale pending PATCH does not override the message submit selection
- [ ] failed PATCH leaves composer usable

## Phase 4: Automated And Manual Closeout

### Automated

- [ ] `pnpm --dir service test`
- [ ] `pnpm --dir service build`
- [ ] `pnpm --dir service lint`
- [ ] `pnpm --dir web build`
- [ ] `pnpm --dir web lint`
- [ ] `git diff --check`

### Manual

- [ ] new thread starts with GPT-5.5 low
- [ ] new thread first message persists GPT-5.5 low
- [ ] existing thread selection persists across refresh
- [ ] old null-selection thread shows effective default
- [ ] old null-selection thread backfills after send
- [ ] message metadata visible in DB for user/assistant/tool messages

### Docs / Spec Alignment

- [ ] DB spec matches schema
- [ ] migration spec lists the generated migration
- [ ] route spec describes thread model fields and PATCH route
- [ ] agent spec describes metadata persistence
- [ ] LLM spec describes GPT-5.5 low default
- [ ] web specs describe selector persistence
- [ ] service README/env docs describe new default
- [ ] mobile handoff notes describe the API contract

## Notes

- Live provider smoke tests are not required for this persistence rollout unless the implementation changes provider request shapes.
- If a command fails, capture the exact command and error output in a debug note and stop for human guidance.
