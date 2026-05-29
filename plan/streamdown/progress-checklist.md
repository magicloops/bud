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
- [x] Streamdown streaming mode/caret replaces bespoke cursor; animation is re-enabled with no-stagger `blurIn`
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

## Overall Progress

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Complete | Dependencies, CSS imports, Tailwind sources, and exports are confirmed |
| 2 | Complete | `MarkdownContent` uses Streamdown with Bud link/inline-code overrides |
| 3 | Complete | Draft assistant rows use the shared renderer with `isStreaming` |
| 4 | Partial | Scoped CSS is in place; human visual review remains open |
| 5 | Complete / Manual Deferred | Cleanup, specs, tests, and build are complete; manual validation is left to humans |

## Notes

- Keep this checklist current as soon as implementation or verification status changes.
- Do not mark manual visual validation complete unless it was actually run.
- Automated validation completed on 2026-05-28. Manual visual validation remains unchecked in `validation-checklist.md`.
