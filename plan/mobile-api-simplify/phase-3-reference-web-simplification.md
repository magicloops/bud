# Phase 3: Reference Web Simplification

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Complete

---

## Objective

Move the reference web thread view onto the simplified transcript and stream contracts.

By the end of this phase:

- web uses the paged message-history contract
- web reconciles live events using backend-provided identifiers
- web no longer depends on full-array transcript replacement for the normal happy path
- web becomes the proof that the new contract is actually simpler to consume

## Why This Phase Exists

If the backend contract improves but the web app keeps using the old workaround-heavy model, the repo still teaches future clients the wrong lessons.

The current web route in `web/src/routes/$budId/$threadId.tsx` still does all of these:

- bootstrap with `limit=200`
- sort the array client-side
- synthesize IDs for live tool and assistant rows
- render incomplete live state
- refetch the full transcript on `final`

That is exactly the behavior we are trying to simplify away.

## Scope

### In Scope

- thread loader and transcript state model
- upward history loading
- reconciliation with stable stream identifiers
- moving `final` refetch to fallback/background consistency behavior
- thread bootstrap simplification if the backend now supports it

### Out Of Scope

- mobile app implementation
- true assistant text deltas
- major visual redesign beyond what is needed to consume the new contract cleanly

## Implementation Tasks

### Task 1: Adopt paged history

Replace the current latest-200 snapshot logic with:

- initial latest page
- upward older-page loading
- explicit anchor preservation when prepending older pages

### Task 2: Replace synthetic IDs with real reconciliation

Use the Phase 2 stream identifiers so live tool and assistant events can merge into canonical transcript state without guessing.

### Task 3: De-emphasize `final` full refetch

Keep a refetch path as a fallback or background verification step, but remove it as the primary mechanism for correctness during normal turns.

### Task 4: Optional thread bootstrap cleanup

If Phase 1 makes it cheap and clear, consider a combined thread-detail bootstrap payload:

- thread metadata
- latest message page

This is not required for correctness, but it reduces client choreography.

### Task 5: Keep the UI contract honest

Update the web docs/specs so they describe the new transcript model rather than the old “snapshot plus sort plus refetch” pattern.

## Validation Checklist

- [ ] web opens a thread using the new paged transcript contract
- [ ] web can load older pages without jumping the viewport
- [ ] live tool and assistant events reconcile without synthetic ID hacks
- [ ] `final` refetch is no longer the primary visible convergence mechanism
- [ ] web docs/specs describe the new behavior accurately

## Exit Criteria

This phase is done when the web client is a clean reference consumer for the transcript contract instead of a collection of special-case recovery logic.
