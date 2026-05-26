# Phase 4: Web Context Meter UI

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Render a compact context budget meter in the web workbench.

By the end of this phase:

- users can see context budget usage for the active thread
- the visual meter uses percent of effective budget
- details show rounded token values and estimate basis/confidence
- unknown/stale/degraded states are handled cleanly

## Scope

### In Scope

- formatter helpers for percent and rounded token values
- compact meter component
- tooltip/popover details
- composer/workbench placement
- responsive behavior
- UI tests where existing test infrastructure supports them

### Out Of Scope

- manual compaction button
- provider token-count refresh button
- mobile implementation
- new SSE event handling

## Implementation Tasks

### Task 1: Add formatting helpers

Implement small helpers for:

- percent display from `percent_of_context_budget`
- rounded token values such as `312k`
- state classification from budget percentage, `status`, and `stale`

Suggested states:

- unknown
- normal
- elevated
- near-threshold
- compacting or over-threshold
- degraded
- stale

### Task 2: Build meter component

Add a reusable component that accepts `ApiContextBudget`.

Visual behavior:

- show percent as the primary visual value
- show restrained color changes at 70% and 85%
- show unknown/degraded text when needed
- avoid exact-token noise in the compact view

### Task 3: Add details popover/tooltip

Details should include:

- model/provider
- estimated input tokens
- remaining context tokens
- effective budget tokens
- compaction threshold ratio/tokens when enabled
- estimate basis/confidence
- stale indicator
- short note that compaction preserves visible chat history

Use "before auto-compact" copy only when `compaction_enabled` is true.

### Task 4: Place near model controls

Primary placement:

- command composer/model-control row near model and reasoning selectors

Secondary placement:

- optional top-bar chip only if the thread is near threshold or compacting

Avoid placing the meter inside the transcript.

### Task 5: Refresh behavior

Ensure the UI gets updated budget snapshots after:

- thread open
- message send
- stream reconnect or final state
- compaction completion if reflected by agent-state refresh

Do not add a new stream reducer event in this phase.

### Task 6: Add UI tests or focused component tests

Cover:

- normal percent rendering
- near-threshold rendering
- unknown state
- stale state
- disabled auto-compaction copy
- rounded token details

## Files Likely Changed

- `web/src/lib/api-types.ts`
- `web/src/features/threads/`
- `web/src/components/workbench/command-composer.tsx`
- `web/src/components/workbench/`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/features/threads/threads.spec.md`

## Design Guardrails

- Keep the UI quiet and work-focused.
- Do not add a landing-page-style explanation.
- Do not show raw checkpoint ids in the compact view.
- Use percentage visually and rounded token counts in details.
- Do not imply exactness unless the backend basis/confidence supports it.

## Exit Criteria

- Meter is visible in the thread workbench.
- Text fits in compact and mobile-ish widths.
- Details explain basis/confidence and compaction semantics.
- No manual compaction control ships.
