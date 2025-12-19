# Debug: Inline Code Overflow in Chat Messages

## Environment

- Web UI: React + Tailwind CSS
- Markdown: react-markdown with remark-gfm
- Container: Fixed width chat panel (w-96 = 384px)

## Symptom

Inline code (text wrapped in backticks like \`some_long_variable_name\`) extends past the parent message container, ignoring overflow boundaries. Long code snippets break the layout and extend past the visible area.

## Current Implementation

### Container Hierarchy

```
ChatTimeline (w-96 = 384px fixed width)
└── article (message card, rounded-xl border-3, p-3)
    └── div.relative
        └── div (overflow-hidden only for vertical truncation)
            └── MarkdownContent
                └── div.prose (max-w-none)
                    └── <code> elements (inline)
```

### Message Rendering (chat-timeline.tsx:210-218)

```tsx
<div className="relative">
  <div
    ref={(node) => { contentRefs.current[message.id] = node }}
    className={cn(isOverflowing && !isMessageExpanded && 'max-h-[500px] overflow-hidden')}
  >
    {contentNode}
  </div>
  {/* Fade gradient for vertical overflow */}
</div>
```

The `overflow-hidden` is applied **conditionally** and only for **vertical** overflow (max-height).

### Inline Code Styling (markdown-content.tsx:49-56)

```tsx
<code
  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]"
  {...props}
>
  {children}
</code>
```

No overflow handling - renders as inline element that extends past container.

### Prose Container (markdown-content.tsx:19)

```tsx
<div className="prose prose-sm dark:prose-invert max-w-none ...">
```

`max-w-none` removes prose width constraints, relying on parent for sizing.

## Root Cause

1. **Inline elements don't respect parent overflow**: CSS `overflow: hidden` on a parent doesn't clip inline children that extend beyond the container width
2. **No word-break on code**: Long strings in `<code>` elements don't break
3. **Fixed container width**: Chat panel is 384px but code can be arbitrarily long

## Design Requirements

1. **Fade effect**: Long code should fade at the edge of the container
2. **Hover to reveal**: User should be able to see full content on hover
3. **Copyable**: User should be able to copy the full text

## Solution Options

### Option 1: CSS Truncation with Hover Expand

Use `max-width` + `text-overflow: ellipsis` with hover state to show full:

```tsx
<code
  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]
             inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap
             hover:max-w-none hover:whitespace-normal hover:overflow-visible"
  title={children} // Shows full text on hover (native tooltip)
>
  {children}
</code>
```

**Pros**: Pure CSS, simple
**Cons**: `inline-block` may disrupt text flow, native tooltip is basic

### Option 2: Gradient Fade with Hover Overlay

Apply gradient mask to container, show full content in popover on hover:

```tsx
<span className="relative inline-block max-w-[200px]">
  <code className="...">
    {truncatedContent}
  </code>
  <span className="absolute right-0 top-0 h-full w-8 bg-gradient-to-l from-muted to-transparent" />
  {/* Hover: show tooltip/popover with full content */}
</span>
```

**Pros**: Visual fade effect, full control
**Cons**: More complex, needs hover state management

### Option 3: Break Long Words

Allow code to break mid-word:

```tsx
<code
  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] break-all"
>
  {children}
</code>
```

**Pros**: Simplest, no truncation
**Cons**: May look odd when words break mid-string

### Option 4: Scrollable Code Spans

Make long inline code horizontally scrollable:

```tsx
<code
  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]
             inline-block max-w-full overflow-x-auto whitespace-nowrap"
>
  {children}
</code>
```

**Pros**: All content accessible, familiar pattern
**Cons**: May be awkward for inline content

### Option 5: Custom InlineCode Component with Tooltip

Create a smart component that:
- Detects if content is truncated
- Shows fade effect when truncated
- Shows full content in Radix tooltip on hover

```tsx
const InlineCode = ({ children }) => {
  const ref = useRef()
  const [isTruncated, setIsTruncated] = useState(false)

  useEffect(() => {
    if (ref.current) {
      setIsTruncated(ref.current.scrollWidth > ref.current.clientWidth)
    }
  }, [children])

  const code = (
    <code
      ref={ref}
      className="... max-w-full overflow-hidden text-ellipsis whitespace-nowrap inline-block align-bottom"
    >
      {children}
    </code>
  )

  if (isTruncated) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{code}</TooltipTrigger>
        <TooltipContent>
          <code className="font-mono text-sm">{children}</code>
        </TooltipContent>
      </Tooltip>
    )
  }

  return code
}
```

**Pros**: Best UX, smart truncation, proper tooltip
**Cons**: More complex, needs Radix tooltip integration

## Recommended Approach

**Option 5** (Custom InlineCode Component) provides the best user experience:

1. Shows truncated code with ellipsis for long content
2. Tooltip on hover reveals full content
3. Full content is selectable/copyable from tooltip
4. No disruption to text flow for short code
5. Consistent with the existing vertical overflow fade pattern

### Implementation Steps

1. Create `InlineCode` component in `web/src/components/ui/inline-code.tsx`
2. Use Radix `Tooltip` from existing shadcn/ui setup
3. Update `markdown-content.tsx` to use `InlineCode` for inline code blocks
4. Style to match existing code block appearance

## Affected Files

| File | Role |
|------|------|
| `web/src/components/message-renderers/roles/markdown-content.tsx` | Current inline code rendering |
| `web/src/components/ui/inline-code.tsx` | New component (to create) |
| `web/src/components/workbench/chat-timeline.tsx` | Message container |

---

*Created: 2024-12-18*
*Status: RESOLVED*
*Resolution: Created `InlineCode` (click-to-copy, word-wrap) and `CodeBlock` (syntax highlighting, copy button)*
*Note: Initial truncation approach broke baseline alignment; final solution uses simple inline display with `overflow-wrap: break-word`. See `debug/inline-code-vertical-alignment.md` for full analysis.*
