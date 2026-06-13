# Phase 4: Client Types, Docs, And Validation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Finalize the public contract, update first-party types/docs/specs, and validate
that live and persisted message-duration metadata work for mobile grouping.

## Scope

### In Scope

- protocol docs
- service specs
- web API/event types
- mobile fixture/handoff notes
- automated test command documentation
- manual validation checklist execution

### Out Of Scope

- iOS UI implementation
- web visual redesign for grouped work rows
- turn table design or migration

## Implementation Tasks

### Task 1: Update protocol docs

Update `docs/proto.md` to document:

- `message.metadata.started_at`
- `message.metadata.finished_at`
- `message.metadata.duration_ms`
- `message.metadata.duration_source`
- `agent.message_start.started_at`
- `agent.message_done.started_at`
- `agent.message_done.finished_at`
- `agent.message_done.duration_ms`
- `agent.message_done.duration_source`
- `/agent/state.draft_assistant.started_at`

Explicitly state that `message.created_at` remains a persistence/order
timestamp.

### Task 2: Update service specs

Update the relevant specs after implementation:

- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`

The specs should describe the additive metadata contract and live-state fields.

### Task 3: Update web types

Update first-party TypeScript shapes so current web code tolerates the additive
fields:

- `web/src/lib/api-types.ts`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/features/threads/thread-message-state.ts`

The web UI does not need to adopt grouped duration display in this phase unless
the implementation naturally needs a reference consumer.

### Task 4: Update web specs if touched

If web files change, update:

- `web/src/src.spec.md`
- any narrower web spec covering the touched files

### Task 5: Update plan checklists

Record completed automated test commands in:

- [progress-checklist.md](./progress-checklist.md)
- [validation-checklist.md](./validation-checklist.md)

### Task 6: Add mobile-facing fixtures or examples

Provide examples for iOS showing:

- mixed reasoning + tool + assistant rows with duration metadata
- legacy assistant rows without duration metadata
- client sum behavior
- client interval-union behavior

These examples can live in docs, reference handoff, or tests depending on where
the implementation naturally lands.

## Suggested Automated Verification

Run package-local service tests from `service/` or via `pnpm --dir`:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/agent/transcript-writer.test.ts src/runtime/agent-runtime-state.test.ts
```

If agent-service tests are updated, include them in the same package-local
command.

If web type files change, run the package-local web type/lint command used by
the repo at the time of implementation.

## Manual Validation

Use [validation-checklist.md](./validation-checklist.md). At minimum validate:

- live assistant stream carries timing
- `/agent/state` carries active assistant `started_at`
- persisted history carries timing after reload
- tool and reasoning legacy fallback still works
- `message.content` remains replay-safe

## Exit Criteria

- Public docs and specs match the implementation.
- First-party web/mobile type expectations are aligned.
- Automated and manual validation results are recorded.
- The plan clearly states any remaining follow-up for turn-level status or
  active-vs-paused duration.
