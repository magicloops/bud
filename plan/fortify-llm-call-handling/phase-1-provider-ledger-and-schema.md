# Phase 1: Provider Ledger And Schema

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Add durable, owner-stamped storage for provider calls and ordered provider items.

The goal is not to change UI behavior yet. The goal is to make provider-native reconstruction possible after a refresh, process restart, or later user turn.

## Scope

### In Scope

- new Drizzle schema for provider calls and provider call items
- checked-in migration for staging/deploy
- append-only persistence helpers
- same-thread ownership stamping
- service-only access helpers for reconstruction
- spec updates for DB and migrations

### Out Of Scope

- rendering reasoning in the UI
- changing message route response shape
- optimizing cache-control placement
- deleting or rewriting historical `message` rows

## Proposed Tables

### `llm_call`

One row per model invocation.

Required properties:

- stable ULID/UUID id
- `thread_id`
- `bud_id` if useful for ownership/debug joins
- `turn_id`
- `step_index`
- `provider`
- `model`
- `request_mode`
- `provider_response_id`
- `status`
- `input_fingerprint`
- `tool_config_fingerprint`
- `usage` JSONB
- `prompt_cache_key` nullable
- `cache_metadata` JSONB nullable
- `created_by_user_id`
- nullable `tenant_id`
- timestamps

### `llm_call_item`

One row per ordered provider input or output item.

Required properties:

- stable ULID/UUID id
- `llm_call_id`
- `thread_id`
- `direction`: `input` or `output`
- `role` nullable
- `kind`
- `sequence`
- `provider_output_index` nullable
- `provider_content_index` nullable
- `provider_item_id` nullable
- `tool_call_id` nullable
- `text` nullable
- `canonical_payload` JSONB
- `provider_payload` JSONB
- `visibility`
- `message_id` nullable
- `created_by_user_id`
- nullable `tenant_id`
- timestamps

Indexes should support:

- ordered lookup by `thread_id`, provider, and sequence
- ordered lookup by `llm_call_id`
- lookup by `tool_call_id`
- optional join from product `message_id`

## Implementation Tasks

1. Add Drizzle tables to `service/src/db/schema.ts`.
2. Include `tenant_id` and `created_by_user_id` nullable columns per repo convention.
3. Add foreign keys to `thread`, `message`, and `auth.user` where appropriate.
4. Add provider item kinds as either a constrained enum or checked string values.
5. Add persistence helper module under an appropriate service folder.
6. Ensure helpers write provider payloads without exposing them through browser-facing routes.
7. Run `pnpm --dir /Users/adam/bud/service db:push` for local schema application.
8. Run `pnpm --dir /Users/adam/bud/service db:generate` for checked-in migration SQL.
9. Review generated SQL and Drizzle metadata.
10. Update `service/src/db/db.spec.md` and `service/drizzle/migrations/migrations.spec.md`.

## Acceptance Criteria

- [ ] Provider call rows can be written for OpenAI and Anthropic invocations.
- [ ] Ordered provider item rows can be written before and after streaming completion.
- [ ] Reasoning and redacted thinking provider payloads fit without lossy transformation.
- [ ] Product transcript routes do not expose provider ledger rows.
- [ ] Migration files are generated and documented.

## Rollout Notes

The schema should be append-only and nullable enough to roll out before runtime adoption. Historical threads will not have provider-native reconstruction until they receive new calls after the migration.

## Risks

| Risk | Mitigation |
|------|------------|
| Provider payload JSON is large | Store item-level payloads, index metadata only, and avoid indexing raw JSON payloads initially |
| Reasoning payload is sensitive | Mark rows provider-only, keep out of browser routes, and document access restrictions |
| Schema is too generic to be useful | Require output/content indexes, provider item IDs, and tool call IDs in the common columns |
