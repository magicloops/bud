# Phase 3: Web Selector Persistence

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Proposed

---

## Objective

Move web model/reasoning selector state from route-local defaults to a shared contract that initializes from service data and persists existing-thread changes.

By the end of this phase:

- new-thread UI initializes to `gpt-5.5` + `low`
- existing-thread UI initializes from the thread's effective selection
- selector changes in existing threads persist through the thread PATCH route
- the first new-thread message creates a thread with the submitted selection
- route remounts, refreshes, and navigation no longer reset the selector unexpectedly

## Scope

### In Scope

- shared `useModelSelection({ threadId?: string })` hook or equivalent local pattern
- web model API types/helpers
- `web/src/routes/$budId/new.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- workbench command composer props/state wiring
- focused web tests if the existing harness supports them
- web lib/routes/workbench spec updates if implementation lands in this phase

### Out Of Scope

- Mobile client implementation
- Global user model preferences
- Per-Bud defaults
- New settings UI
- Clear-override UI

## Implementation Tasks

### Task 1: Update web API types

Extend thread types with:

- `model`
- `reasoning_effort`
- `effective_model`
- `effective_reasoning_effort`
- `model_selection_source`

Extend `/api/models` response types with:

- `service_default_model`
- `default_reasoning_effort`

Keep compatibility with existing model catalog fields.

### Task 2: Add shared selection hook

Create a shared hook or helper with this shape:

```typescript
useModelSelection({ threadId?: string })
```

Responsibilities:

- fetch/use `/api/models`
- initialize new-thread state from service default
- initialize existing-thread state from thread effective selection
- normalize reasoning only when the current reasoning is invalid for the selected model
- expose selected model/reasoning and setters
- expose pending/error state for persistence
- keep composer usable if persistence fails

### Task 3: Persist existing-thread changes

When a user changes model or reasoning in an existing thread:

- validate locally against `/api/models` metadata when possible
- debounce or coalesce rapid selector changes
- call `PATCH /api/threads/:thread_id/model-preference`
- adopt the server-returned stored/effective selection
- surface non-blocking persistence errors

There is no clear-override behavior. A different selection replaces the previous thread selection.

### Task 4: Keep new-thread changes local until creation

For `/$budId/new`:

- initialize to `gpt-5.5` + `low`
- store selector changes in local component/hook state only
- pass selected model/reasoning to `POST /api/threads`
- pass selected model/reasoning to the first `POST /messages` as a defensive compatibility path
- after navigation, the created thread should already return the stored selection

### Task 5: Preserve defensive submit payloads

Existing-thread message submit should keep sending current `model` and `reasoning_effort` with `POST /messages`.

This makes message send authoritative if a debounced PATCH is still pending. The service should resolve the explicit request and update the thread selection consistently.

### Task 6: Avoid reset loops

Guard against route effects that:

- overwrite a loaded thread selection with `/api/models.default_model`
- reset reasoning to a model default when the existing reasoning remains valid
- bounce between pending local state and stale thread loader data after PATCH

The selector should only normalize when model metadata says the current reasoning value is unsupported.

## Web Tests

Add or update tests where the harness supports them:

- new-thread route initializes to `gpt-5.5` + `low`
- existing-thread route initializes from `effective_model` and `effective_reasoning_effort`
- existing-thread selector change calls PATCH
- failed PATCH leaves composer usable and does not erase local selection
- model change preserves reasoning when still valid
- model change resets reasoning when invalid
- first message from `/$budId/new` sends model/reasoning to thread create and message create

## Validation Checklist

- [ ] new-thread selector shows `gpt-5.5` + `low`
- [ ] existing-thread selector shows stored/effective selection
- [ ] changing existing-thread model persists through PATCH
- [ ] changing existing-thread reasoning persists through PATCH
- [ ] first message from new-thread creates a thread with the submitted selection
- [ ] refresh keeps the same thread selection
- [ ] navigation away/back keeps the same thread selection
- [ ] pending PATCH does not block message submit
- [ ] failed PATCH does not make the composer unusable

## Exit Criteria

This phase is done when the web selector behaves as a thread-scoped persisted control and the original route-remount reset bug is no longer reproducible.
