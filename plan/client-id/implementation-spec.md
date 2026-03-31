# Implementation Spec: Message Client IDs

**Status**: In Progress
**Created**: 2026-03-30
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-schema-and-transcript-foundation.md](./phase-1-schema-and-transcript-foundation.md)
**Phase 2**: [phase-2-user-message-write-contract.md](./phase-2-user-message-write-contract.md)
**Phase 3**: [phase-3-agent-runtime-and-stream-identity.md](./phase-3-agent-runtime-and-stream-identity.md)
**Phase 4**: [phase-4-reference-web-adoption-and-handoff.md](./phase-4-reference-web-adoption-and-handoff.md)
**Related Docs**:
- [../../design/message-client-id-and-stable-message-identity.md](../../design/message-client-id-and-stable-message-identity.md)
- [../../review/message-streaming-and-message-ids-review.md](../../review/message-streaming-and-message-ids-review.md)
- [../../reference/client-id-recommendation.md](../../reference/client-id-recommendation.md)
- [../../design/mobile-agent-stream-attach-semantics.md](../../design/mobile-agent-stream-attach-semantics.md)

---

## Context

Bud’s current message flow still uses unstable client-local identifiers during normal healthy streaming:

- optimistic user rows start as `temp_*` and later swap to `message_id`
- pending tool rows start as `tool_call:<call_id>` and later swap to the persisted tool row
- draft assistant rows start as `assistant_draft:<turn_id>` and later swap to the persisted assistant row

That behavior is now fully documented in [../../review/message-streaming-and-message-ids-review.md](../../review/message-streaming-and-message-ids-review.md).

The reference recommendation in [../../reference/client-id-recommendation.md](../../reference/client-id-recommendation.md) is directionally correct for Bud:

- UI identity must exist before persistence
- database identity and UI identity should not be the same concern

Bud should adopt that direction without replacing `message_id`.

## Objective

Implement a stable top-level `client_id` for messages by:

1. adding `message.client_id` to the database
2. exposing `client_id` on transcript read surfaces
3. accepting or generating `client_id` on user-message writes
4. generating service-owned `client_id` values for assistant/tool/system messages
5. threading `client_id` through `/agent/state` and agent SSE before assistant/tool persistence
6. updating the reference web client so message rendering keys by `client_id`
7. keeping `message_id` intact for persistence, cursors, and debugging
8. aligning protocol/spec/reference docs with the shipped contract

## Why This Matters

The current system has strong correlation primitives:

- `turn_id`
- `call_id`
- `message_id`

But it is still missing a single message identity that survives all of these transitions:

- optimistic -> persisted user message
- draft assistant -> persisted assistant message
- pending tool -> persisted tool message
- `/agent/state` bootstrap -> `/messages` durable transcript
- SSE live events -> post-reload transcript rehydration

`client_id` fills that gap.

## Architecture Phrase

`client_id` is the stable message identity. `message_id` is the persisted row identity.

## Fixed Decisions

These decisions are locked for this implementation plan:

- Keep `message_id` as the current persisted row identifier.
- Add `client_id` as a separate top-level field.
- Use snake_case `client_id` on HTTP and SSE contracts.
- Use the `uuid` npm package with UUIDv7 support in both service and web.
- Keep transcript cursor ordering on `(created_at, message_id)`.
- Do not add a separate `attempt_id` in this tranche.
- Do not add a new transcript lookup route by `client_id` in this tranche.
- Extend `/agent/state` rather than inventing another runtime bootstrap route.
- During rollout, first-party clients may fall back to `message_id` when `client_id` is absent on historical or partially migrated payloads.
- Full cross-request send idempotency is not required in this tranche; only first-pass duplicate `client_id` handling on `POST /messages` is in scope.

## Success Criteria

- [x] `message` rows have a `client_id` column.
- [x] historical `message` rows are backfilled with `client_id`.
- [ ] end-state schema makes `client_id` non-null and unique.
- [x] `GET /api/threads/:thread_id/messages` returns `client_id` on every row.
- [x] `POST /api/threads/:thread_id/messages` accepts optional `client_id`.
- [x] `POST /api/threads/:thread_id/messages` returns `{ message_id, client_id }`.
- [x] missing user-message `client_id` values are generated server-side.
- [x] assistant messages get a stable `client_id` before the first draft stream event that references them.
- [x] tool messages get a stable `client_id` before `agent.tool_call`.
- [x] `/agent/state.pending_tool` includes `client_id`.
- [x] `/agent/state.draft_assistant` includes `client_id`.
- [x] agent SSE assistant/tool payloads include `client_id` before persistence completes.
- [x] persisted assistant/tool `message` payloads include both `message_id` and `client_id`.
- [ ] the reference web client keys message UI state by `client_id` instead of mutating identity from temp/synthetic IDs to `message_id`.
- [ ] the web client uses UUIDv7 `client_id` generation for new user messages.
- [ ] the `/new` route also sends a client-generated `client_id` for its first message.
- [ ] protocol/spec/reference docs are updated together.
- [x] duplicate `client_id` requests on `POST /api/threads/:thread_id/messages` return the existing identifiers without creating a second user row or starting a second agent turn.

## Non-Goals

- replacing `message_id` in the public API
- changing transcript cursor ordering to `client_id`
- introducing a new request/turn table
- guaranteeing perfect send idempotency across service restarts or lost-start edge cases
- adding regenerate/attempt semantics beyond existing `turn_id`

## Key System Constraints

The current implementation imposes a few important boundaries:

### 1. Transcript pagination already depends on `message_id`

`GET /messages` cursor ordering is tied to `(created_at, message_id)`. That should stay unchanged in this work.

### 2. `/agent/state` already exists and is the right place for in-flight identity

Bud already has a best-effort runtime bootstrap contract via `/agent/state`. That means assistant/tool `client_id` should flow through the existing runtime surface rather than a new route.

### 3. The current send path has no dedicated request record

`POST /messages` inserts the user row and starts agent work, but there is no separate durable request table tying one `client_id` to one turn. That means first-pass duplicate handling can be useful, but it will not become a perfect replay engine in this tranche.

### 4. Web and service do not currently share a UUIDv7 helper

The repo does not already carry one. This plan standardizes on the `uuid` package for both sides.

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-schema-and-transcript-foundation.md](./phase-1-schema-and-transcript-foundation.md) | Urgent | `client_id` exists in storage, historical rows are backfilled, and transcript reads serialize it |
| 2 | [phase-2-user-message-write-contract.md](./phase-2-user-message-write-contract.md) | Urgent | user-message writes accept/echo `client_id` and first-party send flows can stop depending on temp identity swaps |
| 3 | [phase-3-agent-runtime-and-stream-identity.md](./phase-3-agent-runtime-and-stream-identity.md) | Urgent | assistant/tool runtime and SSE surfaces emit stable `client_id` before persistence |
| 4 | [phase-4-reference-web-adoption-and-handoff.md](./phase-4-reference-web-adoption-and-handoff.md) | High | web adopts `client_id` as render identity and docs/specs/handoffs align with the shipped contract |

## Sequencing Notes

- Do not update web rendering identity before transcript reads and live agent/runtime payloads can both provide `client_id`.
- Do not make `client_id` non-null until after historical backfill is complete.
- Do not change pagination logic to depend on `client_id`.
- Do not rely on `client_id` for full send replay semantics; document the limited first-pass duplicate behavior explicitly.
- Keep docs/proto/spec updates in the same phase as the client contract flip.

## Current Progress

- Phase 1 is complete in code: schema, UUIDv7 generation, persisted message stamping, transcript serialization, and the historical backfill have all landed.
- Phase 2 is complete in code: `POST /api/threads/:thread_id/messages` now accepts optional `client_id`, echoes it back, and suppresses duplicate same-thread user retries.
- Phase 3 is complete in code: `/agent/state`, draft assistant SSE, tool SSE, and persisted assistant/tool rows now reuse the same preallocated `client_id`.
- Phase 4 remains outstanding.

## Expected Files And Areas

### Service

- `service/package.json`
- `service/src/db/schema.ts`
- `service/src/routes/threads.ts`
- `service/src/agent/agent-service.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/db/*.ts` and `service/src/scripts/*.ts` for backfill/bootstrap support
- `service/src/routes/routes.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/db/db.spec.md`

### Web

- `web/package.json`
- `web/src/lib/api.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/routes/$budId/new.tsx`
- `web/src/components/workbench/chat-timeline.tsx`
- relevant web specs

### Root Docs

- `docs/proto.md`
- `bud.spec.md`
- iOS/reference handoff docs that describe transcript and stream semantics

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| We accidentally change transcript ordering semantics while adding `client_id` | Low | High | Keep pagination and cursor ordering on `(created_at, message_id)` only |
| Historical rows or partial rollout payloads lack `client_id`, breaking clients that switch too early | Medium | High | Backfill first and keep `client_id ?? message_id` fallback during rollout |
| Assistant/tool events expose inconsistent `client_id` between runtime, stream, and persisted row | Medium | High | Allocate once and thread the same value through runtime state, SSE, and DB insert |
| Duplicate send handling is mistaken for perfect idempotency | Medium | Medium | Keep first-pass behavior narrow and document non-goals clearly |
| Web still mutates identity because one path continues to key by `message_id` | Medium | High | Update both existing-thread and new-thread flows together and validate `/agent/state` bootstrap paths |
| `uuid` usage diverges between service and web | Low | Medium | Standardize on the same package and document that choice explicitly |

## Rollout Strategy

1. Add schema/read-path support and complete backfill.
2. Add user write-path support and first-pass duplicate handling.
3. Add assistant/tool runtime and stream `client_id` support.
4. Move the reference web client to `client_id`-first rendering.
5. Tighten schema constraints and update docs/handoffs/specs.

## Definition Of Done

- [ ] transcript reads, user writes, `/agent/state`, and agent SSE all expose `client_id`
- [ ] assistant/tool `client_id` values are stable before persistence and match the later persisted row
- [ ] first-party web no longer depends on temp/synthetic IDs as its primary message identity model
- [ ] `message_id` remains intact for cursors and debugging
- [ ] touched specs and protocol/reference docs are updated together
- [ ] validation notes are captured in [validation-checklist.md](./validation-checklist.md)
