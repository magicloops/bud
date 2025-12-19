# Plan: Inline Code Overflow Fix

> **STATUS: COMPLETED (with revised approach)**
>
> The original truncation approach (`inline-block` + `text-overflow: ellipsis`) broke baseline alignment with surrounding text. Final solution uses simple inline display with `overflow-wrap: break-word` - long code wraps instead of truncating.
>
> See `debug/inline-code-vertical-alignment.md` for full analysis of why truncation was abandoned.

## Context

- Debug doc: `debug/inline-code-overflow.md`
- Issue: Inline code (`backticks`) in chat messages overflows past the fixed-width container (384px)
- Original goal: Truncate long code with fade/ellipsis, show full content on hover via tooltip
- **Final solution**: Long code wraps to next line; click-to-copy for all inline code

## Final Implementation

The `InlineCode` component:
1. Uses simple `display: inline` for proper baseline alignment
2. Uses `overflow-wrap: break-word` so long code wraps instead of overflowing
3. Click anywhere to copy content to clipboard
4. Visual feedback (green ring) on successful copy

## Original Objective (Superseded)

~~Create a smart `InlineCode` component that:~~
1. ~~Truncates long inline code with ellipsis~~
2. ~~Shows tooltip on hover when truncated~~
3. ~~Allows copying full text from tooltip~~
4. ~~Maintains text flow alignment for short code~~

## Design Approach

### CSS Strategy

Use `inline-block` with truncation properties:

```css
code {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: text-bottom; /* maintain baseline alignment */
}
```

- **Short code**: Renders inline, doesn't hit max-width
- **Long code**: Truncates at container edge with ellipsis

### Truncation Detection

After render, compare dimensions to detect overflow:

```typescript
const isTruncated = element.scrollWidth > element.clientWidth
```

Only wrap in Tooltip when content is actually truncated.

### Tooltip Behavior

- Trigger: hover (standard delay)
- Content: Full code text in monospace
- Allow text selection/copying from tooltip
- Match existing UI styling

## Implementation Steps

### Step 1: Install Radix Tooltip

```bash
cd web && pnpm add @radix-ui/react-tooltip
```

### Step 2: Create Tooltip Component

Create `web/src/components/ui/tooltip.tsx` following shadcn/ui pattern:

```tsx
import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md",
        "animate-in fade-in-0 zoom-in-95",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "data-[side=bottom]:slide-in-from-top-2",
        "data-[side=left]:slide-in-from-right-2",
        "data-[side=right]:slide-in-from-left-2",
        "data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
```

### Step 3: Create InlineCode Component

Create `web/src/components/ui/inline-code.tsx`:

```tsx
import { memo, useRef, useState, useEffect, type ReactNode } from "react"
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./tooltip"
import { cn } from "@/lib/utils"

type InlineCodeProps = {
  children: ReactNode
  className?: string
}

export const InlineCode = memo(function InlineCode({ children, className }: InlineCodeProps) {
  const codeRef = useRef<HTMLElement>(null)
  const [isTruncated, setIsTruncated] = useState(false)

  useEffect(() => {
    const element = codeRef.current
    if (!element) return

    // Check if content overflows
    const checkTruncation = () => {
      setIsTruncated(element.scrollWidth > element.clientWidth)
    }

    checkTruncation()

    // Re-check on resize (container might change)
    const observer = new ResizeObserver(checkTruncation)
    observer.observe(element)

    return () => observer.disconnect()
  }, [children])

  const codeElement = (
    <code
      ref={codeRef}
      className={cn(
        // Base styling (matches existing)
        "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]",
        // Truncation styling
        "inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap",
        // Alignment to maintain text flow
        "align-text-bottom",
        // Cursor hint when truncated
        isTruncated && "cursor-help",
        className
      )}
    >
      {children}
    </code>
  )

  if (!isTruncated) {
    return codeElement
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          {codeElement}
        </TooltipTrigger>
        <TooltipContent
          className="max-w-[min(400px,90vw)] break-all font-mono text-xs"
          side="top"
        >
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})
```

**Key implementation details:**

1. **ResizeObserver**: Re-checks truncation when container resizes
2. **align-text-bottom**: Keeps inline-block aligned with surrounding text
3. **cursor-help**: Visual hint that hovering reveals more
4. **TooltipProvider per instance**: Avoids needing global provider
5. **max-w-[min(400px,90vw)]**: Tooltip won't exceed 400px or 90% viewport
6. **break-all**: Allows long strings to wrap in tooltip

### Step 4: Update MarkdownContent

Update `web/src/components/message-renderers/roles/markdown-content.tsx`:

```tsx
import { InlineCode } from "@/components/ui/inline-code"

// In the components prop for react-markdown:
code: ({ className, children, ...props }) => {
  const match = className?.match(/language-(\w+)/)
  if (match) {
    // Fenced code block - keep existing SyntaxHighlighter logic
    const code = String(children).replace(/\n$/, '')
    return (
      <SyntaxHighlighter ...>
        {code}
      </SyntaxHighlighter>
    )
  }
  // Inline code - use new component
  return <InlineCode {...props}>{children}</InlineCode>
},
```

### Step 5: Update Spec Files

Update `web/src/components/ui/ui.spec.md` (or create if doesn't exist) with:
- Tooltip component documentation
- InlineCode component documentation

Update `web/src/components/message-renderers/roles/roles.spec.md` with:
- Note about InlineCode usage in markdown rendering

## Files to Create

| File | Purpose |
|------|---------|
| `web/src/components/ui/tooltip.tsx` | Radix tooltip wrapper |
| `web/src/components/ui/inline-code.tsx` | Smart truncating inline code |

## Files to Modify

| File | Changes |
|------|---------|
| `web/package.json` | Add `@radix-ui/react-tooltip` dependency |
| `web/src/components/message-renderers/roles/markdown-content.tsx` | Use InlineCode for inline code |

## Testing Plan

1. **Short code**: `code` renders inline, no truncation, no tooltip
2. **Medium code**: `some_variable_name` may or may not truncate depending on context
3. **Long code**: `some_really_long_variable_name_that_definitely_overflows` truncates with ellipsis
4. **Hover**: Tooltip shows full text when truncated
5. **Copy**: Can select and copy text from tooltip
6. **Resize**: Truncation updates when window/panel resizes
7. **Multiple in line**: "Use `short` and `a_very_long_code_block` together" works correctly

## Edge Cases

1. **Code with special chars**: Ensure `<script>alert('xss')</script>` renders safely
2. **Very narrow container**: Should still truncate gracefully
3. **Code at line boundary**: Multiple truncated codes in same line
4. **Mobile/touch**: Tooltip should work with tap (Radix handles this)

## Rollback Plan

If issues arise, revert to previous inline code styling by:
1. Removing InlineCode import from markdown-content.tsx
2. Restoring original `<code>` element

---

*Created: 2024-12-18*
*Related: debug/inline-code-overflow.md*
