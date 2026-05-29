# Debug: Streamdown Code Copy Hover Hidden

## Environment

- Web client: React + Vite dev server already running
- Renderer: Streamdown 2.5.0 with `@streamdown/code` 1.1.1
- Area: assistant/user Markdown code block chrome in `web/src/index.css`

## Repro Steps

1. Render a Markdown fenced code block in a chat message.
2. Move the pointer over the code block.
3. Expect the code copy control to appear above the top-right edge of the code block.

## Observed

- The copy control does not appear on hover after Phase 9 moved code controls above the code block surface.
- The same above-surface model works for Mermaid and table controls.

## Expected

- On desktop/fine-pointer devices, hovering the code block reveals the copy control above the surface.
- The control remains reachable through the hover bridge.
- On mobile/coarse-pointer devices, the control remains visible without hover.

## Findings

- Streamdown's installed code path renders code blocks with:
  - outer `[data-streamdown="code-block"]`
  - hidden `[data-streamdown="code-block-header"]`
  - an action wrapper containing `[data-streamdown="code-block-actions"]`
  - `[data-streamdown="code-block-body"]`
- The outer code block component also sets inline `contentVisibility: "auto"` and `containIntrinsicSize: "auto 200px"`.
- Phase 9 moved the action wrapper to `top: -2rem`, outside the code block's normal border box.
- `content-visibility: auto` applies containment behavior that can clip or suppress paint for out-of-bounds descendants. That makes the above-surface control unreliable even when the CSS rule sets `overflow: visible`.
- Mermaid/table wrappers do not use the same Streamdown code-block component and therefore do not have this inline containment issue.

## Hypotheses

- Primary: the above-surface code action group is being clipped by Streamdown's inline `content-visibility: auto` containment on `[data-streamdown="code-block"]`.
- Secondary: the hover reveal selector is correct, because the code action group is still a descendant of `[data-streamdown="code-block"]` in the installed Streamdown output.

## Proposed Fix

- Override Streamdown's code-block containment in the scoped Bud CSS:
  - `content-visibility: visible !important`
  - `contain-intrinsic-size: none !important`
- Keep:
  - the outer code block as the hover/focus container
  - the action wrapper above the surface
  - the code body as the horizontal overflow owner
  - the dark code-surface action background
- Update Phase 9 notes/checklists if the fix is applied.

## Applied Fix

- Added the scoped containment override to `.bud-markdown [data-streamdown="code-block"]` in `web/src/index.css`.
- This should allow the above-surface action wrapper to paint outside the code block border box while preserving the existing hover/focus selector and dark code-surface styling.
