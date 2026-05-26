# Phase 10: Radial Send Button Context Meter

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented; Browser Layout Validation Blocked

---

## Objective

Replace the dedicated composer context meter with a circular send button whose
outer radial border visualizes current context-budget usage from 0-100%.

The send button becomes the single compact surface for:

- submitting the message
- showing context-budget state at a glance through a radial ring
- exposing the existing context tooltip on hover/focus

## Current State

- `CommandComposer` renders a separate `ContextBudgetMeter` before the model and
  reasoning selectors.
- `ContextBudgetMeter` owns the visible compact label, horizontal progress bar,
  tooltip trigger, and tone color mapping.
- `context-budget-meter-state.ts` owns the reusable presentation model:
  percentage, tone, tooltip title, and detail lines.
- The submit button is a square-ish icon button with a black border, accent
  background, and send/loading icon.

## Proposed UX

- The submit control becomes a true circle.
- The visible percentage text disappears from the composer control row.
- The context usage is represented as a radial border/ring around the send
  button:
  - `0%` means no colored radial fill.
  - `50%` means half the ring is filled.
  - `100%` and higher means the ring is full.
  - over-budget state keeps the ring full and uses the existing red tone.
- Hovering or focusing the send button opens the existing context tooltip.
- The tooltip keeps the current service-owned details: effective budget, remaining
  tokens, Bud usable cap, output reserve, hard model window, basis, confidence,
  checkpoint state, and stale state.
- Unknown context shows a neutral ring/track with no progress fill and tooltip
  copy such as `Context unavailable`.
- Dispatching/loading keeps the radial ring visible while the centered send icon
  changes to the spinner.

## Implementation Approach

### Component Shape

Implemented first pass:

- Deleted the dedicated visible `context-budget-meter.tsx` component.
- Added a `context-send-button.tsx` component that owns the submit button, radial
  ring, tooltip trigger, and context tone colors.
- Kept `context-budget-meter-state.ts` for now as the pure presentation helper,
  even though the visible UI is no longer a standalone meter.

This avoids stuffing tooltip/ring styling into `command-composer.tsx`, while
still removing the dedicated context UI surface from the composer.

### Radial Ring Rendering

Use CSS `conic-gradient` on the button shell rather than SVG/canvas.

Implementation notes:

- Clamp visual progress to `[0, 100]` for the ring.
- Preserve the raw `percentLabel` in the tooltip, so over-budget values can still
  display honestly.
- Use CSS custom properties for the ring color/degree so Tailwind does not need
  to generate dynamic classes.
- Render an inner circular button surface above the gradient ring so the icon
  remains legible.
- Keep the click target at least the current `48px` square footprint.

### Tooltip Trigger

Disabled HTML buttons do not reliably trigger hover/focus tooltips because the
shared button class applies disabled pointer-event behavior.

Preferred behavior:

- Wrap the submit button in the tooltip trigger element.
- Keep the native `button type="submit"` inside the wrapper for form semantics.
- Allow the wrapper to show the tooltip even when the button is disabled or
  dispatching.
- Preserve keyboard access to the real submit button when enabled.

### Composer Layout

`CommandComposer` should remove the separate context meter slot:

```tsx
{contextBudget !== undefined && <ContextBudgetMeter contextBudget={contextBudget} />}
```

The control row should end with:

1. model selector
2. reasoning selector when present
3. context-aware circular send button

The textarea bottom padding may need a small adjustment only if the circular
button grows beyond the current `h-12 w-12` footprint.

## Files To Change

- `web/src/components/workbench/command-composer.tsx`
  - remove the `ContextBudgetMeter` import/use
  - render the context-aware send button instead of the raw `Button`
- `web/src/components/workbench/context-send-button.tsx`
  - new component for radial ring, tooltip, loading/send icon, and submit button
- `web/src/components/workbench/context-budget-meter.tsx`
  - delete once the new send button owns the tooltip surface
- `web/src/components/workbench/context-budget-meter-state.ts`
  - keep presentation helper; optionally add ring progress/tone metadata
- `web/src/components/workbench/context-budget-meter-state.test.ts`
  - update expectations to cover radial send-button presentation needs
- `web/src/components/workbench/workbench.spec.md`
  - document the removed standalone meter and new send-button integration
- `plan/context-meter/context-meter.spec.md`
  - document this phase file

## Acceptance Criteria

- The composer no longer renders a separate visible context meter.
- The send button is circular and still submits the form.
- The send button radial border fills from 0-100% based on
  `context_budget.percent_of_context_budget`.
- Values at or above 100% render as a full ring.
- Unknown context renders without crashing and shows neutral context tooltip
  details.
- Hover/focus on the send control shows the context tooltip.
- Dispatching state still shows a centered spinner and keeps the context ring.
- Model/reasoning selectors remain usable and visually aligned with the button.
- No backend/API changes are required.

## Validation Plan

- Run the focused web presentation test:
  - `pnpm --dir /Users/adam/bud/web exec node --experimental-strip-types --test src/components/workbench/context-budget-meter-state.test.ts`
- Run the web build:
  - `pnpm --dir /Users/adam/bud/web build`
- Manually validate in the browser:
  - normal context shows a partial ring
  - near/over context changes ring color
  - over context fills the ring
  - unknown context shows neutral ring and tooltip
  - disabled/dispatching button still exposes tooltip on hover
  - narrow composer widths do not overflow

## Implementation Notes

- The radial ring is rendered with CSS `conic-gradient` in
  `context-send-button.tsx`.
- Ring progress is clamped by `getContextBudgetRingProgress(...)`; over-budget
  states fill the ring and keep the existing red tone.
- The tooltip trigger wraps the native submit button, so hover/focus can still
  expose context details when the button is disabled.
- No backend, API, SSE, or database changes were required.

## Validation Results

Validated on 2026-05-24:

- `pnpm --dir /Users/adam/bud/web exec node --experimental-strip-types --test src/components/workbench/context-budget-meter-state.test.ts`
  - Passed: 7 tests, 0 failures.
  - Node emitted the expected experimental type-stripping warning.
- `pnpm --dir /Users/adam/bud/web build`
  - Passed.
  - Vite emitted the existing large-chunk warning for chunks above 500 kB.

Browser validation is still pending. An attempted dev-server start failed with
`listen EPERM` because the dev server was already/sandbox-blocked locally, and
the in-app browser then blocked both `127.0.0.1:5173` and `localhost:5173`.
Manual browser verification should use an already-permitted preview URL.

## Open Questions

- Should the neutral unknown state show a full muted track, an empty track, or no
  ring at all? Proposed: full muted track with no colored progress.
- Should near/over context also affect the inner button background, or only the
  radial ring? Proposed: ring only, keeping the send action visually stable.
- Should the tooltip open on focus for keyboard users in addition to hover?
  Proposed: yes, through the existing Radix tooltip behavior.
- Should `context-budget-meter-state.ts` be renamed to a more generic
  `context-budget-presentation.ts` now that the standalone meter is going away?
  Proposed: defer the rename to avoid unnecessary churn in this UI change.

## Known Unknowns

- Exact ring thickness may need a quick browser pass to keep the black outline,
  colored progress ring, and accent button fill visually balanced.
- Radix tooltip behavior around disabled buttons needs verification with the
  wrapper approach.
- The existing Vite large-chunk warning is unrelated but will still appear during
  web build validation.
