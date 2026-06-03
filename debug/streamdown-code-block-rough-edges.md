# Debug: Streamdown Code Block Rough Edges

## Environment

- Repo: `/Users/adam/bud`
- Area: Web UI assistant/user Markdown renderer
- Date: 2026-06-03
- OS: macOS Darwin 24.6.0 arm64
- Node: v22.14.0
- Renderer: `streamdown@2.5.0` with `@streamdown/code@1.1.1`
- DB connection style: not involved
- LLM mode: not involved; visual styling issue in scoped CSS

## Repro Steps

1. Render a fenced code block in a chat message.
2. Compare the code block corners against rendered table and Mermaid blocks.

## Observed

- Code blocks have rougher, squarer visible edges than table and Mermaid rich blocks.
- The effect is most noticeable on the dark code surface.

## Expected

- Code blocks should use the same slightly rounded rich-block surface feel as table and Mermaid output.
- Above-surface code copy controls should still render outside the code surface.

## Findings

- The outer Streamdown code block already has `border-radius: var(--radius)`.
- The outer code block also intentionally uses `overflow: visible` so above-surface copy controls and hover bridges can paint outside the block.
- The visible dark code surface is `[data-streamdown="code-block-body"]`.
- Bud's current override sets that visible body to `border-radius: 0`.
- Because the outer wrapper cannot clip descendants, the square code body is what determines the visible corner shape.
- Table and Mermaid visible surfaces use `border-radius: var(--radius)` on the surface element itself.

## Proposed Fix

- Set `[data-streamdown="code-block-body"]` to `border-radius: var(--radius)`.
- Keep overflow ownership on the code body so wide code remains horizontally scrollable.
- Keep the outer code block `overflow: visible` for the above-surface copy control.

## Status

- Investigation documented.
- Applied a Bud-scoped CSS fix in `web/src/index.css` by setting `[data-streamdown="code-block-body"]` to `border-radius: var(--radius)`.
- Follow-up cleanup removes the outer `[data-streamdown="code-block"]` border entirely with `border: 0`, so Streamdown's package border utility does not leave a visible border color around code blocks.
- The outer code block still keeps `overflow: visible` for above-surface copy controls.
