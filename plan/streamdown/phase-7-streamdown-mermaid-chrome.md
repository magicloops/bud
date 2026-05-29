# Phase 7: Streamdown Mermaid Chrome Refinement

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented; manual visual review deferred

---

## Objective

Make Streamdown Mermaid diagrams feel like native Bud diagram surfaces instead of default plugin cards.

By the end of this phase:

- Mermaid diagrams have one calm diagram surface instead of nested or unnecessary borders
- the visible `mermaid` label/header is removed from chat output
- copy and fullscreen controls stay available
- Mermaid controls are hidden until the diagram is hovered or keyboard focus enters the control group on desktop/fine-pointer devices
- desktop/fine-pointer users can move from the diagram to the above-surface controls without the controls disappearing
- Mermaid controls remain visible on mobile/coarse-pointer devices where hover is unavailable
- the controls appear just above the diagram surface, so the diagram's top border remains the first visible edge of the Mermaid view
- the change remains client-side only and keeps Streamdown's Mermaid plugin in charge of rendering, copy, and fullscreen behavior

## Context

Bud currently wires Mermaid through `MarkdownContent` with:

```typescript
mermaid: { copy: true, download: false, fullscreen: true, panZoom: false }
```

The current styling in `web/src/index.css` targets Streamdown's generated structure:

- `[data-streamdown="mermaid-block"]`
- `[data-streamdown="mermaid-block-actions"]`
- `[data-streamdown="mermaid"]`

The installed Streamdown output currently wraps Mermaid blocks as:

- an outer `mermaid-block` container with default card chrome
- a first child header row containing the text `mermaid`
- an actions row containing copy/fullscreen controls
- an inner diagram surface that wraps `[data-streamdown="mermaid"]`

Bud's existing CSS also groups Mermaid and table wrappers together in a shared selector:

```css
.bud-markdown [data-streamdown="mermaid-block"],
.bud-markdown [data-streamdown="table-wrapper"] { ... }
```

Phase 7 should split Mermaid styling from table styling before changing Mermaid chrome, so table behavior does not drift.

## Scope

### In Scope

- scoped CSS under `.bud-markdown`
- `data-streamdown` selector refinements for Mermaid blocks and Mermaid actions
- removing the visible Mermaid header/label
- reducing Mermaid block chrome to a single diagram surface
- desktop-only hover/focus visibility behavior for copy/fullscreen controls, with always-visible controls on mobile/coarse-pointer devices
- light/dark and compact chat-column review
- spec and validation checklist updates after implementation

### Out Of Scope

- backend/SSE changes
- replacing Streamdown's Mermaid plugin
- replacing `components.code` or the Mermaid renderer as the first fix
- changing Mermaid parsing, error handling, or fullscreen behavior
- enabling pan/zoom controls in normal chat mode
- redesigning code block or table controls beyond avoiding shared selector regressions

## Preferred Approach

Prefer a scoped CSS-only pass first.

1. Confirm the actual rendered DOM for a valid Mermaid block before editing CSS.
2. Split Mermaid and table wrapper selectors in `web/src/index.css`.
3. Remove outer Mermaid card chrome from `[data-streamdown="mermaid-block"]` by clearing the extra border/background/padding and keeping `position: relative` plus visible overflow.
4. Hide the Streamdown Mermaid label/header row.
5. Keep one diagram surface border on the inner Mermaid view so the top of the rendered diagram area is the top visible border.
6. Position the actions wrapper absolutely above the diagram surface, aligned to the top-right edge.
7. Inside `@media (hover: hover) and (pointer: fine)`, hide `[data-streamdown="mermaid-block-actions"]` until `[data-streamdown="mermaid-block"]` is hovered or focus is inside the block.
8. Add a narrow, right-aligned invisible hover bridge above `[data-streamdown="mermaid-block"]` so pointer travel from the diagram to the controls keeps the parent block hovered.
9. Outside that desktop/fine-pointer media query, keep controls visible for mobile/coarse-pointer devices where hover is unavailable.
10. Preserve visible keyboard focus behavior through `:focus-within`.

Likely selectors:

```css
.bud-markdown [data-streamdown="mermaid-block"] { ... }
.bud-markdown [data-streamdown="mermaid-block"] > div:first-child { ... }
.bud-markdown [data-streamdown="mermaid-block"] > div:has(> [data-streamdown="mermaid-block-actions"]) { ... }
.bud-markdown [data-streamdown="mermaid-block-actions"] { ... }
.bud-markdown [data-streamdown="mermaid-block"] > div:last-child { ... }
.bud-markdown [data-streamdown="mermaid"] { ... }
```

If Streamdown's generated wrapper order changes, update this phase before implementation rather than styling guessed markup.

## Implementation Tasks

### Task 1: Confirm Mermaid DOM

Inspect a rendered valid Mermaid block in the already-running dev server or generated markup.

Capture:

- which child contains the `mermaid` label
- which child wraps `[data-streamdown="mermaid-block-actions"]`
- which child provides the visible diagram surface border
- whether invalid Mermaid output uses the same outer wrappers

### Task 2: Split Shared Mermaid/Table Styling

Separate selectors currently shared by Mermaid blocks and table wrappers.

Keep table behavior unchanged while allowing Mermaid-specific:

- no outer card border
- no Mermaid label row
- absolute above-surface actions
- visible overflow for controls that extend above the block

### Task 3: Remove Mermaid Header And Outer Border

Hide the `mermaid` label/header row and remove unnecessary outer card chrome.

The target visual shape is:

- no visible `mermaid` text
- no double border
- no header-height gap before the diagram
- one contained diagram surface with the top border at the top of the Mermaid view

### Task 4: Hover/Focus Actions Above The Surface

Move copy/fullscreen controls above the diagram surface.

Expected behavior:

- controls are not always visible on desktop/fine-pointer devices
- hovering the Mermaid diagram reveals controls
- moving the pointer from the diagram to the above-surface controls keeps controls visible
- keyboard focus reveals controls
- controls do not create layout shift when they appear
- controls can overlap preceding content if needed, but must not be clipped by the message bubble or scroll container
- touch/coarse-pointer behavior keeps controls visible without hover

### Task 5: Validate Themes And Error Cases

Review:

- light mode valid diagram
- dark mode valid diagram
- invalid Mermaid syntax
- wide diagram overflow
- control focus ring and hover state
- copy action
- fullscreen action

### Task 6: Update Specs And Validation

After implementation, update:

- [../../web/src/src.spec.md](../../web/src/src.spec.md)
- [../../web/src/components/message-renderers/roles/roles.spec.md](../../web/src/components/message-renderers/roles/roles.spec.md)
- [streamdown.spec.md](./streamdown.spec.md)
- [progress-checklist.md](./progress-checklist.md)
- [validation-checklist.md](./validation-checklist.md)

## Validation Checklist

- [x] Mermaid DOM structure confirmed before styling
- [x] table wrapper styling remains unchanged
- [x] Mermaid label/header is not visible
- [x] Mermaid outer card border is removed
- [x] diagram surface keeps one clear top border
- [x] copy/fullscreen controls are hidden until hover on desktop/fine-pointer devices
- [x] copy/fullscreen controls appear above the diagram surface without layout shift
- [x] a narrow hover bridge keeps desktop controls visible while moving the pointer to them
- [x] keyboard focus reveals controls
- [x] mobile/coarse-pointer controls remain visible without hover
- [ ] valid Mermaid renders in light mode
- [ ] valid Mermaid renders in dark mode
- [ ] invalid Mermaid output remains readable and contained
- [ ] wide Mermaid output remains contained in the message column
- [x] `pnpm --dir /Users/adam/bud/web build` passes

## Exit Criteria

This phase is done when Mermaid diagrams no longer look like labeled plugin cards, controls remain accessible but visually quiet, and the diagram surface reads as the only visible Mermaid block chrome in Bud's chat UI.
