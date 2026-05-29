# Debug: Streamdown Table Control Gap

## Environment

- Web client: React + Vite dev server already running
- Renderer: Streamdown 2.5.0
- Area: assistant/user Markdown table chrome in `web/src/index.css`

## Repro Steps

1. Render a Markdown table in a chat message.
2. Hover the table on a desktop/fine-pointer device.
3. Compare the table copy control spacing against Mermaid copy/fullscreen controls.

## Observed

- Mermaid controls show a small visual gap between the control background/border and the diagram surface.
- Table copy controls appear slightly taller and the control background/border visually touches the table surface.

## Expected

- Table controls should use the same above-surface feel as Mermaid controls.
- The table's top border should remain visually separated from the copy control background.

## Findings

- Mermaid and table controls are structurally different in Streamdown's generated DOM.
- Mermaid renders an outer actions wrapper with classes equivalent to `pointer-events-none sticky top-2 z-10 -mt-10 flex h-8 items-center justify-end`.
- Inside that 2rem-tall Mermaid wrapper, Streamdown renders the visible `[data-streamdown="mermaid-block-actions"]` control group.
- Bud positions the Mermaid wrapper at `top: -2rem`, but styles the inner `[data-streamdown="mermaid-block-actions"]` as the visible bordered background. Because the visible group is centered inside a 2rem shell, it naturally leaves a small gap above the diagram surface.
- Table rendering is different. Streamdown renders:
  - outer `[data-streamdown="table-wrapper"]`
  - first child action row with `flex items-center justify-end gap-1`
  - a nested `div.relative` from `TableCopyDropdown`
  - the actual copy button inside that nested dropdown wrapper
  - last child table surface with the descendant `<table>`
- Bud currently positions and styles the table's first child action row as the visible bordered control group.
- That means the table has no separate invisible 2rem positioning shell. The same element both establishes the above-surface slot and paints the border/background.
- The table row also contains a nested dropdown wrapper and button, so its final used height is content-driven rather than the fixed Mermaid `h-8` shell behavior.
- With `top: -2rem`, any action-row height close to or larger than 2rem visually touches or overlaps the table surface.

## Hypotheses

- Primary: the table copy control gap is missing because table CSS styles the outer positioned action row itself, while Mermaid styles the inner actions group within a 2rem positioning row.
- Secondary: the nested table dropdown wrapper and button line-height/padding make the table action row slightly taller than the available `top: -2rem` offset, causing the visible chrome to meet the table surface.

## Proposed Fix

- Keep the existing Streamdown table DOM and CSS-only approach.
- Treat the table action row like Mermaid's outer positioning shell:
  - keep it `position: absolute; top: -2rem; right: 0`
  - set it to `height: 2rem`
  - keep it transparent and borderless
  - keep `display: flex; align-items: center; justify-content: flex-end`
- Move the visible table control chrome to the nested dropdown wrapper and/or direct button children:
  - border/background/padding/box-shadow should live on the visible inner control group
  - pointer events should remain enabled on the inner controls
- Preserve the existing desktop hover/focus visibility and hover bridge.
- Preserve wide table overflow ownership on the table surface child.

## Notes

- Implemented as a CSS-only follow-up to Phase 8.
- The table action row is now the transparent 2rem positioning shell.
- The visible border/background/padding now live on the nested table control wrapper/direct controls, matching the Mermaid control-shell model more closely.
