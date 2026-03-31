# Phase 1: Schema And Transcript Foundation

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Introduce `message.client_id` safely, backfill historical rows, and expose `client_id` on transcript read surfaces without changing message ordering semantics.

## Scope

In scope:

- service dependency setup for UUIDv7 generation
- schema changes for `message.client_id`
- staged backfill plan
- transcript serializer updates
- read-path API/spec updates

Out of scope:

- user write contract
- `/agent/state` changes
- agent SSE changes
- reference web adoption

## Decisions For This Phase

- Use the `uuid` package in the service for UUIDv7 generation.
- Add `client_id` as a top-level `uuid` column on `message`.
- Keep `message_id` as the primary key.
- Keep transcript cursors ordered by `(created_at, message_id)`.

## Implementation Steps

### 1. Service dependency

- add `uuid` to `service/package.json`
- define one service-owned helper for `client_id` generation

### 2. Staged schema change

Because this repo uses `drizzle-kit push`, the schema tightening should happen in two stages:

#### Stage A

- add nullable `client_id`
- add a partial unique index for non-null values if supported by the chosen schema shape
- deploy/read while backfill is in progress

#### Stage B

- after backfill completes, update schema to:
  - `client_id NOT NULL`
  - full unique index on `client_id`

### 3. Backfill

- add a service-owned backfill script under `service/src/scripts/`
- fill missing `client_id` values in batches
- verify there are no nulls before the second schema tightening pass

### 4. Transcript serializers

Update all persisted message serializers so canonical transcript rows include:

```json
{
  "message_id": "uuid",
  "client_id": "uuidv7",
  "role": "...",
  "display_role": "...",
  "content": "...",
  "metadata": {},
  "created_at": "..."
}
```

Primary touchpoints:

- `service/src/routes/threads.ts`
- `service/src/agent/agent-service.ts` persisted-message serialization helper
- corresponding API types/spec docs

### 5. Read compatibility

Until web adoption lands, read surfaces may expose both:

- old rows that were backfilled
- newly written rows with native `client_id`

This phase should leave reads stable enough that clients can begin adopting `client_id ?? message_id` later.

## Acceptance Criteria

- [ ] `message.client_id` exists in the schema.
- [ ] service has a UUIDv7 generation helper based on `uuid`.
- [ ] a backfill script exists and is documented in the phase notes.
- [ ] transcript history responses include `client_id`.
- [ ] persisted assistant/tool message serializers can emit `client_id` even before live-stream adoption.
- [ ] message ordering and cursor logic remain based on `(created_at, message_id)`.
- [ ] DB specs and route specs are updated.

## Risks / Notes

- Do not couple backfill order to transcript ordering; `created_at` and `message_id` still own ordering semantics.
- Do not flip `NOT NULL` until backfill has been verified.
