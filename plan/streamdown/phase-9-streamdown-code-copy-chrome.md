# Phase 9: Streamdown Code Copy Chrome Refinement

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented; manual visual validation deferred

---

## Objective

Move Streamdown code-block copy controls to the same above-surface interaction pattern used by Mermaid diagrams and tables, while keeping the code block's dark surface as the visual basis for the control background.

By the end of this phase:

- fenced code blocks keep their compact dark Bud code surface
- the code copy control stays available
- the copy control appears just above the code block, aligned to the top-right edge
- the copy control is hidden until the code block is hovered or keyboard focus enters the control group on desktop/fine-pointer devices
- desktop/fine-pointer users can move from the code block to the above-surface copy control without the control disappearing
- the copy control remains visible on mobile/coarse-pointer devices where hover is unavailable
- the control does not cover code text
- the control background uses the code block's dark background treatment, not the light Mermaid/table control background
- the change remains client-side only and keeps Streamdown's code plugin in charge of highlighting and copy behavior

## Context

Bud currently wires code controls through `MarkdownContent` with:

```typescript
code: { copy: true, download: false }
```

Code blocks are rendered by Streamdown's code plugin. Bud's current CSS targets:

- `[data-streamdown="code-block"]`
- `[data-streamdown="code-block-header"]`
- `[data-streamdown="code-block-actions"]`
- `[data-streamdown="code-block-copy-button"]`
- `[data-streamdown="code-block-body"]`

The current code-block copy button is already hover/focus revealed on desktop/fine-pointer devices, but it sits inside the code block near the top-right corner. Phase 7 and Phase 8 moved Mermaid and table controls above their surfaces with narrow hover bridges so controls stay reachable without obscuring content. Code blocks should now adopt the same interaction model.

Important visual difference: Mermaid/table controls use Bud's normal message/background chrome. Code copy controls should use the code block's dark surface language instead, because they belong visually to the dark code surface.

Current code block styling:

- outer `[data-streamdown="code-block"]` is the dark surface container
- Streamdown language/header row is hidden
- body uses `#24292f`, `#c9d1d9`, `0.85em`, and horizontal overflow
- actions wrapper is currently positioned inside the block at `top: 0.25rem; right: 0.25rem`
- code downloads are disabled, so the action group should normally contain only the copy button

## Implementation Notes

Implemented on 2026-05-29 as a scoped CSS-only pass in [../../web/src/index.css](../../web/src/index.css).

The installed Streamdown 2.5.0 code path renders fenced blocks as:

- outer `[data-streamdown="code-block"]`
- hidden `[data-streamdown="code-block-header"]`
- a wrapper containing `[data-streamdown="code-block-actions"]`
- `[data-streamdown="code-block-body"]` through the highlighted-code body/Suspense path

The implementation keeps the outer code block as the hover/focus container, moves the action wrapper to `top: -2rem; right: 0`, adds a right-aligned hover bridge on fine-pointer devices, and keeps horizontal scrolling on `[data-streamdown="code-block-body"]`. The action group keeps the dark `#24292f` code-surface treatment instead of using the lighter Mermaid/table button chrome.

Follow-up debugging found that Streamdown's code block component sets inline `contentVisibility: "auto"` and `containIntrinsicSize: "auto 200px"`. Bud now overrides those containment values for `.bud-markdown` code blocks so above-surface controls can paint outside the code block border box.

## Scope

### In Scope

- scoped CSS under `.bud-markdown`
- `data-streamdown` selector refinements for code block wrappers and code actions
- moving the code action wrapper above the code block
- desktop-only hover/focus visibility behavior for code controls, with always-visible controls on mobile/coarse-pointer devices
- a narrow hover bridge so desktop users can move from the code block to the control
- preserving keyboard focus visibility
- preserving Streamdown code copy behavior
- preserving code block density, syntax highlighting, line-number policy, and horizontal overflow
- spec and validation checklist updates after implementation

### Out Of Scope

- backend/SSE changes
- replacing Streamdown's code plugin
- enabling code downloads
- reintroducing code-block language headers
- changing Shiki themes or syntax highlighting
- changing code font size or line height beyond what is necessary for the control move
- changing Mermaid/table control styling as part of this phase
- adding a custom `components.code` or `components.pre` override unless CSS cannot reliably target the Streamdown plugin structure

## Preferred Approach

Prefer a scoped CSS-only pass first.

1. Confirm the actual rendered DOM for a fenced code block before editing CSS. Completed from the installed Streamdown 2.5.0 dist output.
2. Keep `[data-streamdown="code-block"]` as the hover/focus container and dark code surface.
3. Keep `[data-streamdown="code-block-body"]` as the scrollable code content surface.
4. Move the wrapper that contains `[data-streamdown="code-block-actions"]` from inside the code block to just above the block, aligned to the top-right edge.
5. Preserve visible overflow on `[data-streamdown="code-block"]` so the above-surface control is not clipped.
6. Ensure the code body remains horizontally scrollable and the control move does not alter code text padding more than needed.
7. Use the existing dark code surface colors for `[data-streamdown="code-block-actions"]`, such as `#24292f` and subtle white borders, rather than the Mermaid/table `var(--background)` treatment.
8. Inside `@media (hover: hover) and (pointer: fine)`, hide `[data-streamdown="code-block-actions"]` until `[data-streamdown="code-block"]` is hovered or focus is inside the block.
9. Add a narrow, right-aligned invisible hover bridge above `[data-streamdown="code-block"]` so pointer travel from the code surface to the copy control keeps the parent block hovered.
10. Outside that desktop/fine-pointer media query, keep controls visible for mobile/coarse-pointer devices where hover is unavailable.
11. Preserve `:focus-within` behavior so keyboard access does not depend on hover.

Likely selectors:

```css
.bud-markdown [data-streamdown="code-block"] { ... }
.bud-markdown [data-streamdown="code-block"] > div:has(> [data-streamdown="code-block-actions"]) { ... }
.bud-markdown [data-streamdown="code-block"]::before { ... }
.bud-markdown [data-streamdown="code-block-actions"] { ... }
.bud-markdown [data-streamdown="code-block-copy-button"] { ... }
.bud-markdown [data-streamdown="code-block-body"] { ... }
```

If Streamdown's generated wrapper order changes, update this phase before implementation rather than styling guessed markup.

## Implementation Tasks

### Task 1: Confirm Code Block DOM

Inspect rendered fenced-code markup in the already-running dev server or generated markup.

Capture:

- which child wraps `[data-streamdown="code-block-actions"]` - confirmed from installed Streamdown output
- whether the wrapper can be positioned absolutely without moving the code body - confirmed and implemented
- which element owns horizontal overflow for the code text - `[data-streamdown="code-block-body"]`
- whether streaming/incomplete code blocks use the same outer wrapper structure - confirmed through the same code-block component path
- whether the copy button remains disabled or enabled according to Streamdown streaming state

### Task 2: Move Copy Controls Above The Surface

Move the code action group above the code block, aligned to the top-right edge.

Expected behavior:

- the copy control is not always visible on desktop/fine-pointer devices
- hovering the code block reveals the copy control
- moving the pointer from the code block to the above-surface control keeps it visible
- keyboard focus reveals the copy control
- controls do not create layout shift when they appear
- controls do not cover code text
- touch/coarse-pointer behavior keeps controls visible without hover

### Task 3: Preserve Code-Specific Visual Treatment

Keep the code control visually tied to the code block.

Expected behavior:

- the action group background uses the dark code surface treatment
- the action group does not look like the Mermaid/table light chrome
- hover state remains subtle against the dark surface
- focus state remains visible
- disabled streaming state remains legible

### Task 4: Validate Code Behavior

Review:

- TypeScript fenced code
- shell fenced code
- fenced code with no language
- wide code line overflow
- code block during streaming/incomplete fence
- copy action
- keyboard focus and hover bridge
- light mode
- dark mode
- compact chat-column layout

### Task 5: Update Specs And Validation

After implementation, update:

- [../../web/src/src.spec.md](../../web/src/src.spec.md)
- [../../web/src/components/message-renderers/roles/roles.spec.md](../../web/src/components/message-renderers/roles/roles.spec.md)
- [streamdown.spec.md](./streamdown.spec.md)
- [progress-checklist.md](./progress-checklist.md)
- [validation-checklist.md](./validation-checklist.md)

## Validation Checklist

- [x] code block DOM structure confirmed before styling
- [x] copy action wrapper moves above the code surface
- [x] code copy control is hidden until hover/focus on desktop/fine-pointer devices
- [x] code copy control appears above the code surface without layout shift
- [x] a narrow hover bridge keeps desktop controls visible while moving the pointer to them
- [x] keyboard focus reveals controls
- [x] mobile/coarse-pointer controls remain visible without hover
- [ ] code copy action still works
- [x] control background uses the dark code block surface treatment
- [x] controls do not cover code text
- [x] wide code remains horizontally scrollable
- [x] no-language fenced code renders without a visible header
- [x] streaming/incomplete code blocks remain readable
- [ ] TypeScript code renders in light mode
- [ ] TypeScript code renders in dark mode
- [x] `pnpm --dir /Users/adam/bud/web build` passes

## Exit Criteria

This phase is done when code-block copy controls follow the same above-surface hover/focus interaction model as Mermaid and table controls, while preserving Bud's compact dark code block visual language and Streamdown's plugin-owned copy behavior.
