# Streamdown Message Rendering Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

Use this as the running status board while the Streamdown migration lands.

## Status Legend

- `[ ]` not yet started or not yet verified
- `[x]` implemented and verified
- `[-]` deferred or intentionally out of scope for now

## Phase 1: Dependencies, Tailwind, And API Confirmation

### Dependencies

- [x] `streamdown` installed in `web`
- [x] `@streamdown/code` installed in `web`
- [x] `@streamdown/mermaid` installed in `web`
- [x] `@streamdown/math` installed in `web`
- [x] `web/pnpm-lock.yaml` updated

### CSS And Tailwind

- [x] `streamdown/styles.css` imported once
- [x] `katex/dist/katex.min.css` imported once
- [x] Tailwind `@source` added for Streamdown core
- [x] Tailwind `@source` added for code plugin
- [x] Tailwind `@source` added for Mermaid plugin
- [x] Tailwind `@source` added for math plugin

### API Confirmation

- [x] `Streamdown` import confirmed
- [x] Streamdown default plugin imports confirmed if used
- [x] `@streamdown/code` import confirmed
- [x] `@streamdown/mermaid` import confirmed
- [x] `@streamdown/math` import confirmed
- [x] web build passes after dependency/CSS setup

## Phase 2: Streamdown Renderer Foundation

### Renderer

- [x] `MessageContentRendererProps` accepts `isStreaming`
- [x] `MarkdownContent` uses Streamdown
- [x] static mode works for persisted messages
- [x] streaming mode works for draft content
- [x] `remark-breaks` behavior is retained or intentionally changed
- [x] raw HTML handling is explicitly configured

### Plugins

- [x] code plugin wired
- [x] Mermaid plugin wired
- [x] math plugin wired
- [x] controls configured deliberately

### Bud Overrides

- [x] Markdown link override preserves file actions
- [x] Markdown link override preserves safe external links
- [x] unsafe protocols remain inert
- [x] unsupported local links can remain inert for preview contexts
- [x] inline-code override preserves copy behavior
- [x] inline-code override preserves file-open affordance
- [x] no `code` override breaks fenced-code plugin rendering

## Phase 3: Chat Timeline Streaming Cutover

- [x] draft assistant rows use `RoleContentRenderer`
- [x] draft assistant rows pass `isStreaming`
- [x] plain `whitespace-pre-wrap` draft branch removed
- [x] Streamdown streaming mode replaces the bespoke plain-text draft branch without Streamdown text-reveal animation or caret chrome
- [x] draft file-action source omits synthetic `message_id`
- [x] persisted assistant file-action source includes durable `message_id`
- [x] activity indicator suppression still behaves correctly
- [x] draft-to-final transition no longer switches renderer families

## Phase 4: Visual Controls And Hardening

- [x] `.bud-markdown` scoped styling added where needed
- [ ] light mode reviewed
- [ ] dark mode reviewed
- [ ] long links wrap safely
- [ ] long inline code wraps safely
- [ ] code blocks fit the chat pane
- [ ] tables fit the chat pane
- [ ] Mermaid diagrams render or fail gracefully
- [ ] math expressions render or fail gracefully
- [ ] controls do not obscure text
- [ ] controls are disabled during streaming
- [ ] residual bounce classified

## Phase 5: Cleanup, Specs, And Validation

### Cleanup

- [x] `react-markdown` removed or explicitly retained
- [x] `react-syntax-highlighter` removed or explicitly retained
- [x] `@types/react-syntax-highlighter` removed or explicitly retained
- [x] `remark-gfm` removed or explicitly retained
- [x] `@tailwindcss/typography` removed or explicitly retained
- [x] `CodeBlock` deleted or explicitly retained
- [x] `InlineCode` retained/updated or deleted as appropriate

### Specs And Validation

- [x] `web/web.spec.md` updated
- [x] `web/src/src.spec.md` updated
- [x] `web/src/components/message-renderers/message-renderers.spec.md` updated
- [x] `web/src/components/message-renderers/roles/roles.spec.md` updated
- [x] `web/src/components/workbench/workbench.spec.md` updated
- [x] `web/src/components/ui/ui.spec.md` updated if needed
- [x] `bud.spec.md` updated
- [x] focused file-action tests pass
- [x] full web test suite passes
- [x] web build passes
- [x] manual validation status recorded

## Phase 6: Streamdown Rich Block Styling

### Block Structure

- [x] current code block selectors captured from installed Streamdown output
- [x] current Mermaid block selectors captured from installed Streamdown output
- [x] current table and math wrapper selectors captured from installed Streamdown output

### Code Blocks

- [x] code blocks use compact Bud styling
- [x] double-heavy borders removed or softened
- [x] code text size matches or intentionally revises the previous renderer density
- [x] chat line-number behavior is explicit
- [x] wide code remains contained in the message column

### Controls And Rich Blocks

- [x] code copy controls align without covering text
- [x] controls keep visible keyboard focus states
- [ ] Mermaid blocks are compact in light mode
- [ ] Mermaid blocks are compact in dark mode
- [ ] invalid Mermaid output fails gracefully
- [x] table and math overflow remains contained

### Validation

- [x] affected specs updated
- [x] web build passes after styling changes
- [x] manual rich-block visual validation status recorded

## Phase 7: Streamdown Mermaid Chrome Refinement

### Mermaid Structure

- [x] current Mermaid wrapper DOM confirmed before styling
- [x] Mermaid/table shared selectors split without table regressions

### Mermaid Chrome

- [x] visible `mermaid` label/header removed
- [x] outer Mermaid card border removed
- [x] diagram surface keeps one visible top border
- [x] copy/fullscreen controls move above the diagram surface
- [x] controls hide until hover/focus on desktop/fine-pointer devices
- [x] desktop hover bridge keeps above-surface controls reachable
- [x] mobile/coarse-pointer controls remain visible without hover

### Validation

- [ ] valid Mermaid reviewed in light mode
- [ ] valid Mermaid reviewed in dark mode
- [ ] invalid Mermaid output remains contained
- [x] affected specs updated
- [x] web build passes after Mermaid chrome changes

## Phase 8: Streamdown Table Chrome Refinement

### Table Structure

- [x] current table wrapper DOM confirmed before styling
- [x] horizontal overflow owner identified before controls move above the table
- [x] table/Mermaid selector split preserved without table regressions

### Table Chrome

- [x] table action row no longer creates a visible top gap
- [x] table surface keeps one visible top border
- [x] table copy control moves above the table surface
- [x] controls hide until hover/focus on desktop/fine-pointer devices
- [x] desktop hover bridge keeps above-surface controls reachable
- [x] mobile/coarse-pointer controls remain visible without hover
- [x] wide tables remain horizontally scrollable

### Validation

- [ ] normal table reviewed in light mode
- [ ] normal table reviewed in dark mode
- [ ] wide table output remains contained
- [ ] table copy action still works
- [x] affected specs updated
- [x] web build passes after table chrome changes

## Phase 9: Streamdown Code Copy Chrome Refinement

### Code Structure

- [x] current code block DOM confirmed before styling
- [x] code action wrapper target identified before moving controls above the surface
- [x] code body remains the horizontal overflow owner
- [x] streaming/incomplete code blocks use compatible wrapper structure or are handled explicitly

### Code Copy Chrome

- [x] code copy control moves above the code surface
- [x] controls hide until hover/focus on desktop/fine-pointer devices
- [x] desktop hover bridge keeps above-surface controls reachable
- [x] mobile/coarse-pointer controls remain visible without hover
- [x] control background uses the dark code surface treatment
- [x] controls do not cover code text
- [x] wide code remains horizontally scrollable
- [x] no-language fenced code still renders without a visible header

### Validation

- [ ] TypeScript fenced code reviewed in light mode
- [ ] TypeScript fenced code reviewed in dark mode
- [ ] shell fenced code reviewed
- [ ] no-language fenced code reviewed
- [ ] code copy action still works
- [x] affected specs updated
- [x] web build passes after code copy chrome changes

## Overall Progress

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Complete | Dependencies, CSS imports, Tailwind sources, and exports are confirmed |
| 2 | Complete | `MarkdownContent` uses Streamdown with Bud link/inline-code overrides |
| 3 | Complete | Draft assistant rows use the shared renderer with `isStreaming` |
| 4 | Partial | Scoped CSS is in place; human visual review remains open |
| 5 | Complete / Manual Deferred | Cleanup, specs, tests, and build are complete; manual validation is left to humans |
| 6 | Implemented / Manual Deferred | Compact rich-block styling is implemented and build passes; human visual validation remains open |
| 7 | Implemented / Manual Deferred | Mermaid-specific chrome refinement is implemented and build passes; human visual validation remains open |
| 8 | Implemented / Manual Deferred | Table chrome alignment is implemented; human visual validation remains open |
| 9 | Implemented / Manual Deferred | Code copy chrome alignment is implemented; human visual validation remains open |

## Notes

- Keep this checklist current as soon as implementation or verification status changes.
- Do not mark manual visual validation complete unless it was actually run.
- Automated validation completed on 2026-05-29, including the Phase 9 code copy chrome build. Manual visual validation remains unchecked in `validation-checklist.md`.
- Phase 9 is implemented as a CSS-only follow-up; manual visual validation remains open for code hover, copy, and light/dark review.
