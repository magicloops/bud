# Phase 2: Streamdown Renderer Foundation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented

---

## Objective

Replace the internals of Bud's shared markdown renderer with Streamdown while preserving the current file-open and link-safety behavior.

By the end of this phase:

- `MarkdownContent` renders through Streamdown
- persisted user and assistant messages still render statically
- code, Mermaid, and math plugins are wired
- Bud's Markdown link and inline-code file actions still work
- raw HTML behavior is explicitly decided rather than inherited accidentally

## Scope

### In Scope

- `web/src/components/message-renderers/roles/markdown-content.tsx`
- `web/src/components/message-renderers/types.ts`
- link and inline-code component overrides
- plugin configuration
- raw HTML/security configuration
- tests for helper-level file action behavior where practical

### Out Of Scope

- changing the assistant draft branch in `ChatTimelineMessage`
- deleting `CodeBlock`
- deleting `react-markdown` or syntax-highlighter dependencies
- extensive visual styling of Streamdown controls

## Implementation Tasks

### Task 1: Extend renderer props

Add an optional streaming flag:

```ts
export type MessageContentRendererProps = {
  content: string
  fileActions?: MessageFileActionContext
  isStreaming?: boolean
}
```

Keep this prop optional so existing role renderers and call sites remain tolerant during the transition.

### Task 2: Replace `MarkdownContent` internals

Keep the public export stable:

```ts
export const MarkdownContent = memo(function MarkdownContent(...) { ... })
```

Render with Streamdown:

```tsx
<Streamdown
  mode={isStreaming ? 'streaming' : 'static'}
  isAnimating={isStreaming}
  animated={isStreaming ? streamdownAnimation : undefined}
  caret={isStreaming ? 'block' : undefined}
  plugins={{ code, mermaid, math }}
  components={components}
>
  {content}
</Streamdown>
```

Memoize plugin/config/component objects where needed so streaming deltas do not recreate avoidable renderer configuration on every token.

Use explicit animation options instead of Streamdown's boolean `animated` shortcut. The default word-level stagger can visually trail fast provider deltas; Bud uses `blurIn`, `duration: 200`, `easing: "ease-out"`, and `stagger: 0` so new text animates without queuing behind later blocks.

### Task 3: Preserve line-break behavior

Current rendering uses `remark-breaks`. Streamdown default remark plugins include GFM but not necessarily `remark-breaks`.

Initial implementation should include `remark-breaks` with Streamdown unless visual review intentionally removes it:

```ts
remarkPlugins={[...Object.values(defaultRemarkPlugins), remarkBreaks]}
```

If Streamdown's exact plugin API requires a different shape, document and test that choice.

### Task 4: Preserve Bud link actions

Override `components.a` to keep the current behavior:

- file candidates render explicit file-open controls
- unsafe protocols render inert text
- unsupported local links can render inert when `inertLocalLinks` is set
- external links open with `target="_blank"` and `rel="noopener noreferrer"`

Reuse:

- `getMarkdownLinkAction(...)`
- `filePathCandidateDisplayPath(...)`
- `createFileOpenClickHandler(...)`

### Task 5: Preserve inline-code file actions

Override Streamdown's virtual `inlineCode` component rather than `code`.

The override should:

- use Bud's current `InlineCode` component for click-to-copy behavior, if it still fits
- detect file candidates with `getInlineCodeFileCandidate(...)`
- render a separate file-open button when a candidate is valid
- avoid nested button markup
- avoid replacing fenced-code rendering

### Task 6: Configure raw HTML behavior

Current `react-markdown` behavior does not intentionally render raw HTML as live HTML.

Choose and document one:

- set `skipHtml` if supported and sufficient
- supply `rehypePlugins` that omit raw HTML while preserving Streamdown safety plugins
- keep Streamdown defaults only after a deliberate security review

The implementation should not accidentally loosen raw HTML handling.

### Task 7: Configure controls conservatively

Use Streamdown controls deliberately:

```tsx
controls={{
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: false },
  mermaid: { fullscreen: true, copy: true, download: false, panZoom: false },
}}
```

Adjust exact shape to the installed package types. The default should be compact-chat friendly.

### Task 8: Keep file-open tests green

Run or update:

```bash
pnpm --dir /Users/adam/bud/web exec node --experimental-strip-types --test src/components/message-renderers/roles/markdown-file-actions.test.ts
```

If component-level tests are added later, keep them focused on lazy click-only behavior and link classification.

## Validation Checklist

- [ ] `MarkdownContent` uses Streamdown
- [ ] static user messages render without streaming animation
- [ ] static assistant messages render without streaming animation
- [ ] code plugin is passed to Streamdown
- [ ] Mermaid plugin is passed to Streamdown
- [ ] math plugin is passed to Streamdown
- [ ] `remark-breaks` behavior is retained or intentionally changed
- [ ] link override preserves file/external/unsafe/local behavior
- [ ] `inlineCode` override preserves copy and file-open behavior
- [ ] no `code` override replaces Streamdown's fenced-code plugin path
- [ ] raw HTML behavior is explicitly configured
- [ ] file action helper tests pass

## Exit Criteria

This phase is done when persisted markdown can render through Streamdown with Bud's custom link and inline-code behavior intact.
