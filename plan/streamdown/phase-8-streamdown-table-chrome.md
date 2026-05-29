# Phase 8: Streamdown Table Chrome Refinement

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented; manual visual review deferred

---

## Objective

Make Streamdown tables use the same quiet interaction model as Mermaid diagrams without re-coupling table and Mermaid CSS.

By the end of this phase:

- tables have one calm table surface instead of a wrapper with an always-visible action row
- the table copy control stays available
- table controls are hidden until the table is hovered or keyboard focus enters the control group on desktop/fine-pointer devices
- desktop/fine-pointer users can move from the table surface to the above-surface controls without the controls disappearing
- table controls remain visible on mobile/coarse-pointer devices where hover is unavailable
- the controls appear just above the table surface, so the table's top border remains the first visible edge of the table view
- wide tables still scroll horizontally inside the message column
- the change remains client-side only and keeps Streamdown's table extraction/copy behavior in charge

## Context

Bud currently wires table controls through `MarkdownContent` with:

```typescript
table: { copy: true, download: false, fullscreen: false }
```

The current styling in `web/src/index.css` targets Streamdown's table structure with:

- `[data-streamdown="table-wrapper"]`
- `[data-streamdown="table"]`
- `[data-streamdown="table-header-cell"]`
- `[data-streamdown="table-cell"]`

Phase 7 intentionally split Mermaid styling from table styling so Mermaid-specific changes could remove diagram headers, move controls above the diagram, and add a hover bridge without drifting table behavior.

Phase 8 should realign tables with the same product interaction pattern, but it should not literally re-merge broad Mermaid/table selectors. Mermaid diagrams and tables have different overflow and rendering constraints:

- Mermaid controls can sit above a diagram whose inner surface owns overflow.
- Tables often need horizontal scrolling, and the current table wrapper participates in that overflow behavior.
- Streamdown's table action components depend on a `data-streamdown="table-wrapper"` ancestor and a descendant `<table>` element for copy/export extraction.

The main implementation risk is overflow ownership. Above-surface controls need visible overflow on the outer wrapper, while wide table content still needs a contained horizontal scroll region.

Implementation confirmed the installed Streamdown table DOM uses:

- an outer `[data-streamdown="table-wrapper"]`
- a first child action row containing the copy control
- a last child table surface with horizontal/vertical overflow classes
- a descendant `<table data-streamdown="table">`

Phase 8 keeps the outer wrapper as the hover/focus container, moves the first child action row above the surface, and keeps overflow on the last child table surface.

Follow-up visual debugging found that the table action row was painting its own border/background, unlike Mermaid where the positioned row is a transparent 2rem shell and the visible controls are centered inside it. The table row now follows the Mermaid shell model: the row positions the controls and preserves hover/focus behavior, while the nested dropdown wrapper or direct control owns the visible background, border, padding, and shadow.

## Scope

### In Scope

- scoped CSS under `.bud-markdown`
- `data-streamdown` selector refinements for table wrappers, table controls, and table surfaces
- moving table controls above the table surface
- desktop-only hover/focus visibility behavior for table controls, with always-visible controls on mobile/coarse-pointer devices
- a narrow hover bridge so desktop users can move from the table to the controls
- preserving horizontal overflow for wide tables
- light/dark and compact chat-column review
- spec and validation checklist updates after implementation

### Out Of Scope

- backend/SSE changes
- replacing Streamdown's table parsing
- enabling table download or fullscreen controls in this phase
- changing table data extraction/copy behavior
- adding sticky table headers, sorting, filtering, or pagination
- a custom table component unless CSS-only styling cannot preserve both above-surface controls and contained horizontal overflow
- re-joining Mermaid and table selectors in a way that makes future diagram/table changes coupled again

## Preferred Approach

Prefer a scoped CSS-only pass first.

1. Confirm the actual rendered DOM for a normal table and a wide table before editing CSS.
2. Keep Mermaid and table rules structurally separate, while sharing only small action-control styling primitives where that already fits.
3. Identify which element should own horizontal scrolling after controls move above the table surface.
4. Make `[data-streamdown="table-wrapper"]` `position: relative` with visible overflow, and keep horizontal scrolling on the inner table surface rather than the action wrapper.
5. Remove the current action-row height from normal table flow so the table surface starts at the top visible border.
6. Position the table action wrapper absolutely above the table surface, aligned to the top-right edge.
7. Inside `@media (hover: hover) and (pointer: fine)`, hide the table controls until `[data-streamdown="table-wrapper"]` is hovered or focus is inside the wrapper.
8. Add a narrow, right-aligned invisible hover bridge above `[data-streamdown="table-wrapper"]` so pointer travel from the table to the controls keeps the parent wrapper hovered.
9. Outside that desktop/fine-pointer media query, keep controls visible for mobile/coarse-pointer devices where hover is unavailable.
10. Preserve visible keyboard focus behavior through `:focus-within`.

Likely selectors:

```css
.bud-markdown [data-streamdown="table-wrapper"] { ... }
.bud-markdown [data-streamdown="table-wrapper"] > div:first-child:not(:last-child) { ... }
.bud-markdown [data-streamdown="table-wrapper"]::before { ... }
.bud-markdown [data-streamdown="table-wrapper"] > div:last-child { ... }
.bud-markdown [data-streamdown="table"] { ... }
.bud-markdown [data-streamdown="table-header"] { ... }
.bud-markdown [data-streamdown="table-header-cell"] { ... }
.bud-markdown [data-streamdown="table-cell"] { ... }
```

If Streamdown's generated wrapper order does not give CSS a reliable inner scroll target, prefer a minimal `components.table` override only after confirming that it preserves:

- `data-streamdown="table-wrapper"`
- Streamdown table action components
- a descendant semantic `<table>`
- table copy behavior
- Bud's existing no-download/no-fullscreen controls decision

## Implementation Tasks

### Task 1: Confirm Table DOM

Inspect rendered table markup in the already-running dev server or generated markup.

Capture:

- which child wraps the table copy action
- which child contains the `<table>` element
- which element currently owns horizontal overflow
- whether wide tables and narrow tables use the same wrapper structure
- whether streaming/incomplete tables use the same outer wrapper structure

### Task 2: Decide Overflow Ownership

Keep wide tables contained in the message column while allowing above-surface controls to extend outside the table surface.

Expected outcome:

- controls are not clipped by a scroll container
- wide table content still scrolls horizontally
- the table wrapper does not force the chat bubble wider than the message column
- mobile/coarse-pointer controls remain reachable even when the table scrolls horizontally

### Task 3: Move Table Controls Above The Surface

Move the table control group above the table surface, aligned to the top-right edge.

Expected behavior:

- the copy control is not always visible on desktop/fine-pointer devices
- hovering the table reveals controls
- moving the pointer from the table to the above-surface controls keeps controls visible
- keyboard focus reveals controls
- controls do not create layout shift when they appear
- touch/coarse-pointer behavior keeps controls visible without hover

### Task 4: Align Table Surface Styling

Make table chrome consistent with the rest of Bud's compact Markdown renderer.

Review:

- one visible table surface border
- no extra header/action-row gap before the table
- compact header and cell padding remain readable
- light/dark colors match Bud message surfaces
- action controls visually align with Mermaid controls where appropriate

### Task 5: Validate Table Behavior

Review:

- normal table
- wide table with horizontal overflow
- table with long cell content
- table during streaming
- copy action
- keyboard focus and hover state
- light mode
- dark mode
- compact chat-column layout

### Task 6: Update Specs And Validation

After implementation, update:

- [../../web/src/src.spec.md](../../web/src/src.spec.md)
- [../../web/src/components/message-renderers/roles/roles.spec.md](../../web/src/components/message-renderers/roles/roles.spec.md)
- [streamdown.spec.md](./streamdown.spec.md)
- [progress-checklist.md](./progress-checklist.md)
- [validation-checklist.md](./validation-checklist.md)

## Validation Checklist

- [x] table DOM structure confirmed before styling
- [x] table overflow owner identified before changing controls
- [x] table wrapper keeps wide tables contained in the message column
- [x] table surface keeps one clear top border
- [x] table action row no longer creates a visible top gap
- [x] table copy control is hidden until hover/focus on desktop/fine-pointer devices
- [x] table copy control appears above the table surface without layout shift
- [x] a narrow hover bridge keeps desktop controls visible while moving the pointer to them
- [x] keyboard focus reveals controls
- [x] mobile/coarse-pointer controls remain visible without hover
- [ ] table copy action still works
- [ ] normal tables render in light mode
- [ ] normal tables render in dark mode
- [x] wide tables remain horizontally scrollable
- [ ] long cell content remains contained
- [x] `pnpm --dir /Users/adam/bud/web build` passes

## Exit Criteria

This phase is done when Streamdown tables use the same calm above-surface control pattern as Mermaid diagrams, while table overflow, copy behavior, and semantic table rendering remain intact.
