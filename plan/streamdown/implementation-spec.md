# Implementation Spec: Streamdown Message Rendering

**Status**: Implemented; rich block manual validation deferred
**Created**: 2026-05-28
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-dependencies-tailwind-and-api-confirmation.md](./phase-1-dependencies-tailwind-and-api-confirmation.md)
**Phase 2**: [phase-2-streamdown-renderer-foundation.md](./phase-2-streamdown-renderer-foundation.md)
**Phase 3**: [phase-3-chat-timeline-streaming-cutover.md](./phase-3-chat-timeline-streaming-cutover.md)
**Phase 4**: [phase-4-visual-controls-and-hardening.md](./phase-4-visual-controls-and-hardening.md)
**Phase 5**: [phase-5-cleanup-specs-and-validation.md](./phase-5-cleanup-specs-and-validation.md)
**Phase 6**: [phase-6-streamdown-rich-block-styling.md](./phase-6-streamdown-rich-block-styling.md)
**Phase 7**: [phase-7-streamdown-mermaid-chrome.md](./phase-7-streamdown-mermaid-chrome.md)
**Phase 8**: [phase-8-streamdown-table-chrome.md](./phase-8-streamdown-table-chrome.md)
**Phase 9**: [phase-9-streamdown-code-copy-chrome.md](./phase-9-streamdown-code-copy-chrome.md)
**Related Docs**:
- [../../design/streamdown-message-rendering.md](../../design/streamdown-message-rendering.md)
- [../../debug/assistant-message-render-bounce.md](../../debug/assistant-message-render-bounce.md)
- [../../reference/streamdown/getting-started.md](../../reference/streamdown/getting-started.md)
- [../../reference/streamdown/configuration.md](../../reference/streamdown/configuration.md)
- [../../reference/streamdown/customize-components.md](../../reference/streamdown/customize-components.md)
- [../../reference/streamdown/animation.md](../../reference/streamdown/animation.md)
- [../../reference/streamdown/plugins-code.md](../../reference/streamdown/plugins-code.md)
- [../../reference/streamdown/plugins-mermaid.md](../../reference/streamdown/plugins-mermaid.md)
- [../../reference/streamdown/plugins-math.md](../../reference/streamdown/plugins-math.md)

---

## Context

The web client currently uses two different renderers for the same assistant message lifecycle:

- streaming assistant drafts render as plain text in `ChatTimelineMessage`
- persisted assistant messages render through `MarkdownContent`, backed by `react-markdown`

The message usually keeps the same `client_id`, so the row can remain mounted while the body changes renderer families. The debug note in [../../debug/assistant-message-render-bounce.md](../../debug/assistant-message-render-bounce.md) identifies that renderer switch as the likely cause of the newest message bounce when streaming finalizes.

The desired direction is to use `streamdown` for both streaming and final markdown rendering. Streamdown is purpose-built for incomplete markdown and has plugins for code, Mermaid, and math. Bud initially experimented with Streamdown's text-reveal animation and caret, but the accepted v1 now keeps streaming parser/control state while omitting Streamdown animated text and caret chrome so fast model deltas remain visually calm.

After the functional migration, Streamdown's default rich-block chrome still needs compact Bud-specific passes. Phase 6 scopes broad rich-block styling, Phase 7 narrows in on Mermaid-specific chrome, Phase 8 aligns table controls with the same quiet above-surface interaction pattern while keeping table overflow intact, and Phase 9 scopes the equivalent code-copy control refinement while preserving code's dark surface treatment.

## Objective

Migrate Bud's web message markdown rendering to Streamdown while preserving the current product behaviors:

- assistant drafts and final assistant rows use one shared markdown renderer
- streaming assistant text uses Streamdown streaming mode, not a bespoke plain-text branch, while omitting Streamdown text-reveal animation and caret chrome
- persisted assistant/user messages render statically
- file-open overrides for Markdown links and inline code keep working
- unsafe/local/external link policies remain at least as strict as today
- code, Mermaid, and math rendering are enabled
- Tailwind v4 sees Streamdown classes in production builds
- old markdown dependencies are removed only after the replacement is verified

## Fixed Decisions

- Scope this as a web-only implementation.
- Do not change backend SSE events or `/agent/state`.
- Keep `MarkdownContent` as the exported component name if practical, but replace its internals.
- Add `isStreaming?: boolean` to message renderer props rather than adding a second renderer registry.
- Use Streamdown `mode="streaming"` and `isAnimating` only for draft assistant rows.
- Do not pass Streamdown `animated` or `caret` props for draft assistant rows in the current v1; the visible motion comes from the model stream itself.
- Use Streamdown `mode="static"` for persisted messages.
- Use `@streamdown/code`, `@streamdown/mermaid`, and `@streamdown/math`.
- Import `katex/dist/katex.min.css` for math rendering.
- Preserve `remark-breaks` behavior unless implementation proves Streamdown covers Bud's current line-break expectations without it.
- Override `components.a` and `components.inlineCode` for Bud file actions.
- Do not override `components.code` or `components.pre` in the first pass, because that would replace Streamdown's fenced-code/plugin pipeline.
- Prefer disabling raw HTML or otherwise matching the current stricter `react-markdown` behavior unless a security review explicitly accepts Streamdown's sanitized raw HTML default.
- Keep final manual visual validation with the already-running dev server as a human-owned check.

## Success Criteria

- [x] `streamdown`, `@streamdown/code`, `@streamdown/mermaid`, and `@streamdown/math` are installed in `web`
- [x] Streamdown core CSS and KaTeX CSS are imported once
- [x] Tailwind v4 `@source` directives cover Streamdown and installed plugins
- [x] `MarkdownContent` uses Streamdown for static and streaming modes
- [x] assistant draft rows no longer render through the plain-text branch
- [x] file-open affordances still work for Markdown links and inline code
- [x] external and unsafe link behavior does not loosen
- [x] code blocks render through Streamdown's code plugin
- [x] Mermaid diagrams render through Streamdown's Mermaid plugin
- [x] math expressions render through Streamdown's math plugin
- [x] web tests and build pass
- [x] relevant specs are updated

## Non-Goals

- backend stream event changes
- backend markdown preprocessing
- mobile client adoption
- general transcript design changes
- replacing the activity-indicator state machine
- implementing resize-driven scroll anchoring unless validation shows it is still required
- broad redesign of chat bubble layout

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-dependencies-tailwind-and-api-confirmation.md](./phase-1-dependencies-tailwind-and-api-confirmation.md) | Urgent | Streamdown packages, CSS imports, Tailwind sources, and API exports are confirmed |
| 2 | [phase-2-streamdown-renderer-foundation.md](./phase-2-streamdown-renderer-foundation.md) | Urgent | `MarkdownContent` is Streamdown-backed while preserving Bud file/link behavior |
| 3 | [phase-3-chat-timeline-streaming-cutover.md](./phase-3-chat-timeline-streaming-cutover.md) | Urgent | Draft assistant rows use the same Streamdown renderer as final rows |
| 4 | [phase-4-visual-controls-and-hardening.md](./phase-4-visual-controls-and-hardening.md) | High | Streamdown controls, plugins, theme behavior, and residual layout issues are hardened |
| 5 | [phase-5-cleanup-specs-and-validation.md](./phase-5-cleanup-specs-and-validation.md) | High | Old dependencies/spec drift are cleaned up and validation is recorded |
| 6 | [phase-6-streamdown-rich-block-styling.md](./phase-6-streamdown-rich-block-styling.md) | High | Code, Mermaid, table, and math block styling is tightened for Bud's compact chat UI |
| 7 | [phase-7-streamdown-mermaid-chrome.md](./phase-7-streamdown-mermaid-chrome.md) | Medium | Mermaid chrome is reduced to one diagram surface with hover/focus controls above the block |
| 8 | [phase-8-streamdown-table-chrome.md](./phase-8-streamdown-table-chrome.md) | Medium | Table controls adopt the Mermaid-style above-surface hover/focus pattern while preserving horizontal overflow |
| 9 | [phase-9-streamdown-code-copy-chrome.md](./phase-9-streamdown-code-copy-chrome.md) | Medium | Code copy controls adopt the above-surface hover/focus pattern while preserving the dark code-surface visual language |

## Expected Files And Areas

### Web dependencies and CSS

- `web/package.json`
- `web/pnpm-lock.yaml`
- `web/src/main.tsx`
- `web/src/index.css`

### Message rendering

- `web/src/components/message-renderers/types.ts`
- `web/src/components/message-renderers/roles/markdown-content.tsx`
- `web/src/components/message-renderers/roles/markdown-file-actions.ts`
- `web/src/components/message-renderers/roles/markdown-file-actions.test.ts`
- `web/src/components/message-renderers/roles/assistant.tsx`
- `web/src/components/message-renderers/roles/user.tsx`

### Timeline

- `web/src/components/workbench/chat-timeline.tsx`

### Possible cleanup

- `web/src/components/ui/code-block.tsx`
- `web/src/components/ui/inline-code.tsx`

### Specs

- `web/web.spec.md`
- `web/src/src.spec.md`
- `web/src/components/message-renderers/message-renderers.spec.md`
- `web/src/components/message-renderers/roles/roles.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/components/ui/ui.spec.md`
- `web/src/features/threads/threads.spec.md` if timeline stream state semantics change
- `bud.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Raw HTML behavior becomes more permissive than today | Medium | High | Explicitly set `skipHtml` or customize rehype plugins to preserve current behavior |
| Bud file-open overrides accidentally replace code/Mermaid/math rendering | Medium | High | Override `inlineCode`, not `code`; avoid `pre` overrides in v1 |
| Streamdown controls do not fit the compact chat column | Medium | Medium | Configure controls narrowly, then style via CSS variables and `data-streamdown` selectors |
| Mermaid/math/code blocks still cause height changes after completion | Medium | Medium | Treat as real block finalization; only add resize scroll anchoring if validation still shows bounce |
| Tailwind misses Streamdown plugin classes in production | Medium | High | Add explicit v4 `@source` entries and verify production build output |
| Existing `remark-breaks` behavior changes | Medium | Medium | Include `remark-breaks` with Streamdown unless intentionally removed after visual review |
| Draft file opens lack persisted message path context | Medium | Low | Send only `client_id` for draft rows; include `message_id` once the canonical row exists |
| Scoped CSS depends on Streamdown internal selector stability | Low | Medium | Inspect actual `data-streamdown` selectors before styling and keep overrides limited to documented/stable structure where possible |

## Rollout Strategy

1. Land dependencies, imports, and Tailwind sources first.
2. Replace the renderer internals while keeping exports stable.
3. Cut the timeline draft branch over to the shared renderer.
4. Validate plugin UI and link/file behavior.
5. Remove old dependencies and update specs only after the replacement is proven.
6. Tighten rich block styling as a client-side follow-up without changing renderer ownership.

## Definition Of Done

- [x] implementation follows the phase specs
- [x] automated web tests pass
- [x] `pnpm --dir /Users/adam/bud/web build` passes
- [x] file-open helper behavior is covered by tests
- [x] manual validation scenarios in [validation-checklist.md](./validation-checklist.md) are run or explicitly deferred
- [x] old markdown dependencies are removed or intentionally retained with a note
- [x] all affected specs are updated
- [x] follow-up work is captured if residual bounce remains
