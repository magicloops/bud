# roles

Role-based message content renderers for chat messages.

## Purpose

Provides components for rendering message content based on the sender's role (user, assistant). Uses a registry pattern for easy extension.

## Files

### `index.ts`

Registry mapping roles to their renderers:

```typescript
export const roleContentRenderers: Record<string, MessageContentRenderer> = {
  assistant: AssistantContent,
  user: UserContent,
}
```

**Extension**: Add new roles by creating a component file and registering it here.

### `assistant.tsx`

Re-exports `MarkdownContent` as `AssistantContent`. Currently uses same renderer as user messages.

### `user.tsx`

Re-exports `MarkdownContent` as `UserContent`. Currently uses same renderer as assistant messages.

### `markdown-content.tsx`

Shared markdown renderer using `streamdown` with:

**Features**:
- Streamdown `mode="streaming"` for assistant drafts and `mode="static"` for persisted rows
- Streaming drafts use Streamdown's streaming parser and `isAnimating` control state without Streamdown text-reveal animation or caret chrome
- GitHub Flavored Markdown from Streamdown defaults - tables, task lists, strikethrough
- Line breaks (`remark-breaks`)
- Syntax highlighting through `@streamdown/code`, configured with the dark GitHub theme in both light and dark app themes so Bud's compact dark code surface keeps readable token colors
- Mermaid diagrams through `@streamdown/mermaid`
- Math rendering through `@streamdown/math` and KaTeX CSS
- Raw HTML is explicitly skipped instead of rendered as live HTML
- External links open in new tabs
- When `fileActions` are supplied, local Markdown links and inline-code path candidates render explicit file-open controls; external links and low-confidence inline code remain inert/normal
- The renderer can restrict allowed file path kinds and render unsupported local links inert, which lets Markdown file previews open absolute POSIX links without letting relative preview links navigate to same-origin 404s
- Long local file paths and link labels wrap inside the message bubble so the file-open control remains visible instead of forcing horizontal scroll
- Local file-link actions render a plain-text label inside the link action so
  inline-code path affordances cannot produce nested `<button>` markup

**Code Block Handling**:
- Fenced code blocks (````lang`) use Streamdown's code plugin with copy controls, no visible code-block header, no chat line numbers, and no Bud `code`/`pre` override
- Code block chrome is compacted through scoped CSS: a dark code surface, reduced `0.85em` code text, hidden Streamdown language header, block-level line wrappers even when line numbers are disabled, softened borders, Streamdown code-block containment overrides, and above-surface copy controls that use the code surface's dark treatment while hiding until hover/focus on mouse-capable devices
- Inline code uses `InlineCode` component with click-to-copy; long code wraps instead of truncating for proper baseline alignment
- Inline file candidates keep the copyable code treatment and add a separate open-file button; the path text can wrap independently from the button, and rendering never opens a file session by itself

**Styling**:
- Uses scoped `.bud-markdown` styles and Streamdown `data-streamdown` selectors for compact chat layout
- Rich block overrides live as unlayered CSS in `web/src/index.css` so they beat Streamdown's Tailwind utility chrome while preserving plugin-owned rendering
- Tailwind v4 scans Streamdown core and plugin packages via `@source` directives in `web/src/index.css`
- Custom styling for headings, paragraphs, links, top-level block spacing, list item density, rich block overflow, code copy controls with desktop hover bridges, Mermaid and table single-surface chrome with desktop hover controls, transparent above-surface control shells, narrow hover bridges, and KaTeX display math

**Performance**:
- Memoized with `React.memo`
- Streamdown receives stable plugin and control objects; rich code/Mermaid/math rendering remains owned by the plugin pipeline

### `markdown-file-actions.ts`

Pure helper seam for the Markdown renderer's file-open affordances.

**Exports**:
- `getMarkdownLinkFileCandidate(...)`
- `getMarkdownLinkAction(...)`
- `getInlineCodeFileCandidate(...)`
- `createFileOpenClickHandler(...)`

**Coverage**:
- `markdown-file-actions.test.ts` verifies local Markdown links, absolute POSIX links, inert preview-local links, inline-code file candidates, external/unsafe forms, and proves click handlers are lazy until invoked

## Dependencies

| Import | Purpose |
|--------|---------|
| `streamdown` | Streaming/static Markdown rendering |
| `@streamdown/code` | Shiki-backed code block rendering |
| `@streamdown/mermaid` | Mermaid diagram rendering |
| `@streamdown/math` | KaTeX math rendering plugin |
| `remark-breaks` | Soft line breaks |
| `@/components/ui/inline-code` | Click-to-copy inline code |
| `../types` | Component type definitions |

---

*Referenced by: [../message-renderers.spec.md](../message-renderers.spec.md)*
