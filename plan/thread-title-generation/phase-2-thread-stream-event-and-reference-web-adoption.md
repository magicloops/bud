# Phase 2: Thread Stream Event And Reference Web Adoption

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Make the reference web client actually use the new thread-title contract so the product reflects live title generation during the first assistant response.

By the end of this phase:

- the Bud route owns mutable thread summary state instead of only immutable loader data
- thread-open canonical data can patch that state even if the stream event was missed
- `thread.title` patches the same state live
- the active workspace header renders the resolved thread title instead of a static placeholder

## Current Problem

The backend can emit a title event, but the current web data flow still would not reflect it correctly:

- `/$budId` seeds the thread list from loader data and treats it as immutable
- `/$budId/$threadId` owns local message/runtime state only
- the active top bar uses static labels like `Thread`

That means the feature would still look incomplete in the reference client even with a correct backend.

## Scope

### In Scope

- mutable thread summary state in the Bud route
- canonical thread-detail bootstrap on thread open
- `thread.title` event handling in the active thread route
- active workspace title rendering
- web/spec updates for the new data flow

### Out Of Scope

- generic live thread-summary sync for preview/count/activity
- mobile-repo implementation
- redesigning the overall Bud/thread layout

## Contract Direction

The reference web client should converge through two inputs:

1. canonical thread detail on open
2. live `thread.title` updates on the thread stream

The client should not depend on the event alone because the event may have arrived:

- before attach
- during navigation
- while the user was disconnected

So the intended web contract is:

- thread-open canonical reads establish the current truth
- `thread.title` updates that truth live afterward

## Implementation Tasks

### Task 1: Move `/$budId` to mutable thread summary state

In `web/src/routes/$budId.tsx`:

- seed local thread summary state from loader data
- keep it in component state rather than a pure `useMemo(...)` projection
- provide helpers such as:
  - `upsertThreadSummary(thread)`
  - `updateThreadTitle(threadId, title, updatedAt?)`
  - existing delete/removal behavior

The goal is minimal shared state, not a new global store.

### Task 2: Pass thread-summary update helpers to child routes

Use outlet context or a local Bud-route context so `/$budId/$threadId` can:

- upsert the current thread row on open
- patch the title on `thread.title`

This same mechanism should also let the thread route update the active-title display path cleanly.

### Task 3: Load canonical thread detail on thread open

Extend `web/src/routes/$budId/$threadId.tsx` loader to fetch:

- `GET /api/threads/:thread_id`
- `GET /api/threads/:thread_id/messages?limit=...`
- `GET /api/threads/:thread_id/agent/state`

On mount/load refresh:

- upsert the canonical thread detail into the Bud-route thread summary state

This solves the race where the title was already persisted before the stream attached.

### Task 4: Consume `thread.title` on the thread agent stream

In `/$budId/$threadId.tsx`:

- add a listener for `thread.title`
- parse the payload
- patch Bud-route thread summary state by `thread_id`
- if the active thread matches, update the active workspace title immediately

Treat it as idempotent:

- repeated events should simply overwrite the same title

### Task 5: Show the resolved title in the active workspace

Update `web/src/components/workbench/workspace-top-bar.tsx` and its callers so the active thread view can render:

- the real thread title when present
- a fallback placeholder when absent

Recommendation:

- keep `New Thread` on the dedicated new-thread route
- use `thread.title ?? 'Untitled thread'` on the existing-thread route until the real title arrives

### Task 6: Keep the first-message new-thread flow coherent

Confirm the new-thread route still works cleanly:

- create thread
- send first message
- navigate to `/$budId/$threadId`
- canonical thread detail seeds the new row if parent loader did not rerun
- live `thread.title` patches the row later if generation completes after navigation

### Task 7: Update web specs

Update:

- `web/src/routes/$budId/budId.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/routes/routes.spec.md` if the parent/child Bud-route data-flow description changes materially

The updated specs should describe:

- mutable thread summary state in the Bud route
- canonical thread-detail bootstrap on open
- live title patching via `thread.title`

## Validation Checklist

- [ ] opening an already-titled thread updates the Bud thread list row from canonical thread detail
- [ ] creating a new thread still navigates correctly from `/$budId/new` to `/$budId/$threadId`
- [ ] a newly created thread appears in the Bud thread list without requiring a full Bud-route reload
- [ ] `thread.title` updates the Bud thread list row live
- [ ] `thread.title` updates the active thread header live
- [ ] repeated `thread.title` events are handled idempotently
- [ ] the UI still converges correctly if the stream event was missed before attach
- [ ] thread deletion and existing thread-selection behavior still work after the Bud-route state becomes mutable
- [ ] web specs describe the new loader-plus-stream convergence model accurately

## Exit Criteria

This phase is done when the reference web client visibly stops treating thread titles as static loader-time placeholders and instead converges through canonical thread detail plus the streamed `thread.title` event.
