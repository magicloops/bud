# Phase 6: Streamdown Rich Block Styling

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented; manual visual review deferred

---

## Objective

Make Streamdown's rich blocks feel native to Bud's compact chat timeline without replacing Streamdown's parser or plugin pipeline.

By the end of this phase:

- code blocks visually match the density of Bud's previous renderer
- code, Mermaid, table, and math blocks avoid heavy nested chrome
- copy and block controls align cleanly and do not obscure content
- line-number behavior is explicit for chat messages
- static and streaming assistant messages continue to render through the same Streamdown path

## Context

The current Streamdown renderer is functionally correct, but its default block styling is heavier than Bud's previous implementation:

- code blocks use nested bordered containers and a larger default `text-sm` body
- the previous `CodeBlock` used a single dark code surface with `fontSize: 0.85em`
- Streamdown controls are always part of the block chrome rather than the old hover-only top-right copy button
- Mermaid blocks now render as diagrams instead of plain code, so they need their own compact Bud treatment
- `.bud-markdown` currently scopes only a small amount of overflow and sizing behavior, leaving most plugin defaults intact

This phase is intentionally scoped as styling and configuration work. It should not introduce backend changes or a second markdown renderer.

## Scope

### In Scope

- scoped CSS under `.bud-markdown`
- Streamdown props or plugin options with stable public APIs
- code block density, font size, border, background, and line-number behavior
- code copy control alignment and hover/focus behavior
- Mermaid block chrome and control alignment
- table/math overflow and spacing review
- light/dark theme review for rich blocks

### Out Of Scope

- replacing Streamdown code, Mermaid, or math plugins
- overriding `components.code` or `components.pre` as the first fix
- changing SSE or backend stream semantics
- broader message bubble redesign
- adding visual regression infrastructure

## Preferred Approach

Prefer small, scoped styling and configuration changes:

1. Use `.bud-markdown [data-streamdown="..."]` selectors for Streamdown-owned block structure.
2. Pass Streamdown/plugin props only when the docs expose a stable public option.
3. Keep `components.a` and `components.inlineCode` overrides for Bud file actions.
4. Avoid `components.code` and `components.pre` overrides initially so fenced-code, Mermaid, and math plugin behavior remains intact.

Likely selectors to inspect and style:

```css
.bud-markdown [data-streamdown="code-block"] { ... }
.bud-markdown [data-streamdown="code-block-header"] { ... }
.bud-markdown [data-streamdown="code-block-actions"] { ... }
.bud-markdown [data-streamdown="code-block-body"] { ... }
.bud-markdown [data-streamdown="mermaid-block"] { ... }
.bud-markdown [data-streamdown="mermaid-block-actions"] { ... }
.bud-markdown [data-streamdown="mermaid"] { ... }
.bud-markdown [data-streamdown="table-wrapper"] { ... }
```

If the actual rendered selectors differ, update this phase before implementation rather than styling guessed markup.

The implemented v1 targets the selectors exposed by the installed Streamdown packages:

- code: `code-block`, `code-block-header`, `code-block-actions`, `code-block-copy-button`, `code-block-download-button`, `code-block-body`
- Mermaid: `mermaid-block`, `mermaid-block-actions`, `mermaid`
- tables: `table-wrapper`, `table`, `table-header-cell`, `table-cell`
- math: KaTeX `.katex` and `.katex-display`

## Implementation Tasks

### Task 1: Capture Current Block Structure

Use the already-running dev server to inspect Streamdown-rendered:

- TypeScript fenced code
- shell fenced code
- a wide code line
- valid Mermaid
- invalid Mermaid
- a table wider than the chat column
- inline and block math

Record the exact `data-streamdown` selectors and any generated wrapper nesting that the implementation will target.

### Task 2: Compact Code Blocks

Bring code blocks closer to the previous renderer:

- remove or visually soften the large outer border
- avoid double bordered inner/outer surfaces
- reduce code text toward the previous `0.85em` density
- keep readable line height for long sessions
- keep horizontal overflow inside the code block
- decide whether chat code blocks should use `lineNumbers={false}`

The default expectation for v1 is to disable line numbers in chat unless manual review shows they are useful and unobtrusive.

### Task 3: Align Controls

Make controls feel like Bud message affordances:

- keep code copy enabled
- keep downloads disabled
- align copy/actions to the top-right edge without covering code
- consider hover-only visual prominence while preserving keyboard focus visibility
- confirm controls are disabled or hidden during incomplete streaming content

Do not remove accessible focus states to achieve a cleaner visual result.

### Task 4: Style Mermaid Blocks

Mermaid diagrams need a compact diagram surface instead of inheriting code-block assumptions.

Validate:

- diagram background and border are calm in light and dark mode
- copy/fullscreen controls align with the block edge
- invalid Mermaid errors do not overflow the bubble
- wide diagrams scroll or scale acceptably in the chat column

### Task 5: Review Tables And Math

Keep table and math behavior usable in the message column:

- tables scroll horizontally inside their wrapper
- table controls do not overlap headers
- KaTeX inline output does not disrupt line height
- block math overflow is contained

### Task 6: Update Specs And Validation

After implementation, update:

- [../../web/src/src.spec.md](../../web/src/src.spec.md)
- [../../web/src/components/message-renderers/roles/roles.spec.md](../../web/src/components/message-renderers/roles/roles.spec.md)
- [../../web/src/components/workbench/workbench.spec.md](../../web/src/components/workbench/workbench.spec.md) if timeline layout or scroll behavior changes
- [streamdown.spec.md](./streamdown.spec.md)
- [validation-checklist.md](./validation-checklist.md)

## Validation Checklist

- [x] current Streamdown block selectors are captured before styling
- [x] code blocks use compact Bud styling without double-heavy borders
- [x] code font size matches or intentionally revises the previous `0.85em` density
- [x] chat line-number behavior is explicit
- [x] copy controls align and do not cover code
- [ ] keyboard focus states remain visible
- [ ] Mermaid blocks are compact and readable in light mode
- [ ] Mermaid blocks are compact and readable in dark mode
- [ ] invalid Mermaid output fails gracefully
- [x] tables and math stay within the message column
- [x] static and streaming renderer paths both keep using Streamdown
- [x] `pnpm --dir /Users/adam/bud/web build` passes

## Exit Criteria

This phase is done when Streamdown rich blocks look like a deliberate part of Bud's chat UI rather than default plugin surfaces, while preserving the existing Streamdown plugin and file-open behavior.
