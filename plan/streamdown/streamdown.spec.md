# streamdown

Implementation planning documents for migrating Bud's web message markdown renderer to Streamdown.

## Purpose

This folder turns [../../design/streamdown-message-rendering.md](../../design/streamdown-message-rendering.md) into an actionable phased implementation plan for the web client.

The plan assumes:

- the change is client-side only for the first pass
- backend SSE event names and payloads remain unchanged
- streaming assistant drafts and persisted assistant messages should use the same markdown renderer
- Bud's existing file-open affordances must survive the renderer migration
- Streamdown's code, Mermaid, and math plugins should be enabled
- Tailwind v4 must be configured with Streamdown `@source` directives
- final visual acceptance will be checked by humans against the already-running dev server
- rich block styling can be tightened in follow-up phases without changing backend stream semantics

## Files

### `implementation-spec.md`

Parent implementation spec for the Streamdown renderer migration.

Documents:

- current renderer mismatch
- fixed decisions
- phase sequencing
- affected files
- risks and definition of done

### `phase-1-dependencies-tailwind-and-api-confirmation.md`

Dependency and integration foundation phase covering:

- `streamdown` and plugin installation
- KaTeX CSS import
- Tailwind v4 `@source` configuration
- package export/API confirmation
- initial build sanity checks

### `phase-2-streamdown-renderer-foundation.md`

Shared renderer phase covering:

- replacing `MarkdownContent` internals with Streamdown
- code, Mermaid, and math plugin wiring
- Bud link and inline-code component overrides
- raw HTML and link-safety policy
- file-open helper preservation

### `phase-3-chat-timeline-streaming-cutover.md`

Timeline adoption phase covering:

- adding streaming renderer props
- removing the draft plain-text rendering branch
- passing `isStreaming` for draft assistant messages
- protecting draft file-open source metadata
- validating that draft-to-final no longer switches renderer families

### `phase-4-visual-controls-and-hardening.md`

Product hardening phase covering:

- Streamdown control configuration
- compact chat-column styling
- light/dark theme review
- code, Mermaid, and math visual behavior
- residual scroll-bounce triage

### `phase-5-cleanup-specs-and-validation.md`

Finalization phase covering:

- removal of old markdown/syntax-highlighter dependencies when safe
- spec updates
- automated verification
- manual validation checklist closure
- follow-up capture

### `phase-6-streamdown-rich-block-styling.md`

Rich block styling follow-up covering:

- compact code block density and border treatment
- explicit chat line-number behavior
- copy/control alignment
- Mermaid block styling
- table and math overflow checks
- scoped `.bud-markdown` and `data-streamdown` selector usage

### `phase-7-streamdown-mermaid-chrome.md`

Mermaid chrome refinement follow-up covering:

- removing the visible Mermaid label/header
- reducing Mermaid blocks to a single diagram surface border
- moving copy/fullscreen controls above the diagram surface
- showing Mermaid controls only on hover/focus on desktop/fine-pointer devices, with an invisible hover bridge preserving the pointer path to the controls
- keeping Mermaid controls visible on mobile/coarse-pointer devices
- preserving Streamdown's Mermaid plugin ownership and table styling behavior

### `phase-8-streamdown-table-chrome.md`

Table chrome refinement follow-up covering:

- moving table controls above the table surface
- showing table controls only on hover/focus on desktop/fine-pointer devices, with an invisible hover bridge preserving the pointer path to the controls
- keeping table controls visible on mobile/coarse-pointer devices
- preserving table copy behavior and semantic table rendering
- keeping wide-table horizontal overflow contained in the message column
- keeping table and Mermaid selectors aligned by behavior but structurally separate

### `phase-9-streamdown-code-copy-chrome.md`

Code copy chrome refinement follow-up covering:

- moving code copy controls above the code block surface
- showing code copy controls only on hover/focus on desktop/fine-pointer devices, with an invisible hover bridge preserving the pointer path to the controls
- keeping code copy controls visible on mobile/coarse-pointer devices
- preserving Streamdown's code plugin ownership and copy behavior
- preserving the compact dark code surface treatment for the copy control background instead of reusing the lighter Mermaid/table control background
- keeping wide-code horizontal overflow and no-language code-block behavior intact
- implemented as a scoped CSS-only pass in `web/src/index.css`

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Automated and manual verification checklist for the plan.

## Dependencies

- [../../design/streamdown-message-rendering.md](../../design/streamdown-message-rendering.md) - source design document
- [../../debug/assistant-message-render-bounce.md](../../debug/assistant-message-render-bounce.md) - bug investigation motivating renderer unification
- [../../reference/streamdown/getting-started.md](../../reference/streamdown/getting-started.md) - Streamdown install and Tailwind setup
- [../../reference/streamdown/configuration.md](../../reference/streamdown/configuration.md) - Streamdown props and plugin configuration
- [../../reference/streamdown/customize-components.md](../../reference/streamdown/customize-components.md) - component override behavior
- [../../reference/streamdown/animation.md](../../reference/streamdown/animation.md) - animation configuration and fast-streaming guidance
- [../../reference/streamdown/plugins-code.md](../../reference/streamdown/plugins-code.md) - code plugin setup
- [../../reference/streamdown/plugins-mermaid.md](../../reference/streamdown/plugins-mermaid.md) - Mermaid plugin setup
- [../../reference/streamdown/plugins-math.md](../../reference/streamdown/plugins-math.md) - math plugin setup
- [../../web/src/components/message-renderers/message-renderers.spec.md](../../web/src/components/message-renderers/message-renderers.spec.md) - message renderer module contract
- [../../web/src/components/workbench/workbench.spec.md](../../web/src/components/workbench/workbench.spec.md) - chat timeline behavior

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This plan intentionally defers any backend activity-event changes. If renderer unification does not fully remove perceived bounce, follow-up work should evaluate resize-driven bottom anchoring in `ChatTimeline`.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
