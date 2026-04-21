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

Shared markdown renderer using `react-markdown` with:

**Features**:
- GitHub Flavored Markdown (`remark-gfm`) - tables, task lists, strikethrough
- Line breaks (`remark-breaks`)
- Syntax highlighting (`react-syntax-highlighter` with `oneDark` theme)
- External links open in new tabs

**Code Block Handling**:
- Fenced code blocks (````lang`) use `CodeBlock` component with syntax highlighting and copy button on hover
- Inline code uses `InlineCode` component with click-to-copy; long code wraps instead of truncating for proper baseline alignment

**Styling**:
- Uses Tailwind Typography (`prose`) classes
- Dark mode support (`dark:prose-invert`)
- Custom styling for headings, paragraphs, links

**Performance**:
- Memoized with `React.memo`
- Markdown still renders synchronously, but heavy fenced-code highlighting is now lazy-loaded inside `CodeBlock` so plain prose stays on the initial thread-route path

## Dependencies

| Import | Purpose |
|--------|---------|
| `react-markdown` | Markdown parsing and rendering |
| `remark-gfm` | GitHub Flavored Markdown |
| `remark-breaks` | Soft line breaks |
| `@/components/ui/inline-code` | Click-to-copy inline code |
| `@/components/ui/code-block` | Syntax-highlighted code blocks with copy |
| `../types` | Component type definitions |

---

*Referenced by: [../message-renderers.spec.md](../message-renderers.spec.md)*
