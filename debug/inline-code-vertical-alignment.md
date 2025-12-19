# Debug: Inline Code Vertical Alignment

## Environment

- Component: `web/src/components/ui/inline-code.tsx`
- Context: Rendered inside markdown content with Tailwind Typography (`prose`) classes
- Parent: `web/src/components/message-renderers/roles/markdown-content.tsx`

## Symptom

Inline code elements have their TEXT appearing "higher" than surrounding text. The text INSIDE the code element doesn't align with adjacent non-code text on the same line - it appears shifted upward.

Example: "Found the latest file in `plan/`" - the word "plan/" inside the code appears elevated compared to "Found the latest file in".

## Current Implementation

```tsx
<code
  className={cn(
    // Base styling
    "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] before:content-none after:content-none",
    // Truncation styling
    "inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap",
    // Alignment
    "align-text-bottom",
    // ...
  )}
>
```

### Current CSS Properties

| Property | Value | Effect |
|----------|-------|--------|
| `display` | `inline-block` | Required for `text-overflow: ellipsis` to work |
| `overflow` | `hidden` | Required for truncation - **AFFECTS BASELINE** |
| `py-0.5` | `padding: 0.125rem 0` (2px) | Adds 4px total vertical height |
| `px-1.5` | `padding: 0 0.375rem` | Horizontal padding (not affecting height) |
| `text-[0.85em]` | `font-size: 0.85em` | Slightly smaller than parent |
| `font-mono` | Monospace font | May have different metrics than prose font |
| `align-text-bottom` | `vertical-align: text-bottom` | Aligns bottom of element with bottom of text |
| `rounded` | `border-radius: 0.25rem` | Visual only, no layout effect |

## Root Cause Analysis (Revised - Round 2)

### ACTUAL ROOT CAUSE: We Added `inline-block` Where There Was None!

Comparing the working (old) vs broken (current) HTML:

**Working (old) - simple inline element:**
```html
<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">plan/</code>
```

**Broken (current) - inline-block with truncation:**
```html
<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]
             inline-block max-w-full overflow-x-clip text-ellipsis
             whitespace-nowrap align-text-bottom ...">plan/</code>
```

The old version was a **plain `display: inline`** element (the default for `<code>`). It:
- Naturally participates in text flow
- Has automatic baseline alignment with surrounding text
- No special overflow/truncation handling

When we added `inline-block` for truncation support, we fundamentally changed how the element participates in line layout.

### Why `inline-block` Breaks Alignment

1. **Inline elements**: Baseline is determined by the text content inside - it just flows with the text naturally

2. **Inline-block elements**: Creates a block formatting context inside. The baseline becomes:
   - The baseline of the last line box (if `overflow: visible`)
   - The bottom margin edge (if `overflow` is anything else)

3. **Our truncation requires**: `inline-block` + `overflow: hidden/clip` + `white-space: nowrap` + `text-overflow: ellipsis`

4. **The conflict**: We can't have CSS text truncation AND perfect baseline alignment simultaneously with a single element.

### Previous Hypothesis (Partially Correct but Not Root Cause)

The `overflow: hidden` baseline shift (CSS 2.1 spec) IS real, but:
- Even `overflow: clip` doesn't fully fix it
- Even `overflow: visible` on an `inline-block` has different baseline behavior than a true `inline` element
- The core issue is `inline-block` itself, not just the overflow property

### Why `overflow: clip` Didn't Fix It

While `overflow: clip` theoretically shouldn't change the baseline like `overflow: hidden`, the fundamental issue is that `inline-block` elements have different baseline calculation than `inline` elements, regardless of overflow setting. The element's internal block formatting context creates subtle alignment differences.

## Possible Solutions (Revised)

### Option A: Remove Truncation, Add Word Wrap, Keep Click-to-Copy (Recommended)

**Change**: Remove all truncation-related styles, return to simple inline `<code>`, add `overflow-wrap: break-word` to handle long content

```tsx
<code
  className={cn(
    // Base styling (same as original working version)
    "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] before:content-none after:content-none",
    // Allow long code to wrap instead of overflow
    "[overflow-wrap:break-word]",
    // Click-to-copy styling (NO inline-block, NO overflow, NO truncation)
    "cursor-pointer hover:bg-muted/80 active:scale-[0.98] transition-all",
    copied && "ring-2 ring-green-500/50 bg-green-500/10",
  )}
  onClick={handleCopy}
>
```

**How `overflow-wrap: break-word` works**:
- Short code: stays on one line, flows naturally with text
- Long code that fits: stays on one line
- Long code that would overflow: wraps to next line at a break point
- Maintains `display: inline` throughout

**Pros**:
- Perfect baseline alignment (matches original working version)
- Simple implementation
- No CSS hacks or workarounds
- Click-to-copy still works
- ALL content visible (no truncation/hiding)
- No overflow past container

**Cons**:
- Very long code (like `some_really_long_variable_name`) may break mid-word
- No ellipsis indicator that content continues

**Trade-off Assessment**:
- Breaking mid-word is rare (most code is short)
- When it happens, all content is still visible and readable
- Far better than: overflow, misaligned baselines, or hidden content
- Click-to-copy provides the primary UX value

### Option B: Conditional Truncation via JavaScript

**Change**: Only apply truncation styles after detecting overflow

```tsx
// Render initially as inline
// Use ref to measure actual vs container width
// Only add truncation classes if overflow detected
const needsTruncation = measureOverflow(codeRef)

className={cn(
  "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]",
  needsTruncation && "inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap",
)}
```

**Pros**:
- Short code gets perfect alignment
- Long code gets truncation

**Cons**:
- Complex implementation
- Potential layout flash/reflow
- Race condition between measurement and render
- Still has alignment issue when truncation IS applied

### Option C: Two-Element Wrapper Structure

**Change**: Outer inline element for alignment, inner for truncation

```tsx
<span className="inline align-baseline">
  <code className="inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap ...">
    {children}
  </code>
</span>
```

**Pros**:
- Attempts to separate concerns

**Cons**:
- Doesn't actually work - inner inline-block still affects line height
- More complex DOM
- Semantically incorrect (`<span>` wrapping `<code>`)

### Option D: Accept Misalignment as Trade-off

**Change**: Keep current implementation, accept the visual compromise

**Pros**:
- Truncation works
- No code changes needed

**Cons**:
- Visually incorrect alignment
- Affects readability of mixed text/code content
- User has explicitly flagged this as unacceptable

### Option E: CSS Hacks (Negative Margins, etc.)

**Change**: Use magic numbers to force alignment

```tsx
"inline-block ... align-middle -mt-[2px] -mb-[1px]"
```

**Cons**:
- Fragile, font-dependent magic numbers
- May break with theme/font changes
- Treating symptoms, not cause
- Not recommended

## Recommended Solution

**Option A (Remove Truncation, Add Word Wrap)** is recommended because:

1. **Alignment is more important than truncation**: Misaligned text affects ALL inline code; truncation only matters for the rare very-long code snippet

2. **Original implementation worked**: The pre-InlineCode version had correct alignment with simple inline styling

3. **`overflow-wrap: break-word` handles overflow**: Long code wraps instead of extending past container - all content visible

4. **Click-to-copy is the main feature**: Users can still copy content; truncation was secondary

5. **No CSS limitations or hacks**: Clean, maintainable, robust to future changes

### Proposed Implementation

```tsx
export const InlineCode = memo(function InlineCode({ children, className }: InlineCodeProps) {
  const codeRef = useRef<HTMLElement>(null)
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    const text = codeRef.current?.textContent
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [])

  return (
    <code
      ref={codeRef}
      onClick={handleCopy}
      className={cn(
        // Base styling - simple inline element (NO inline-block!)
        "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] before:content-none after:content-none",
        // Allow long code to wrap instead of overflow
        "[overflow-wrap:break-word]",
        // Click-to-copy styling
        "cursor-pointer hover:bg-muted/80 active:scale-[0.98] transition-all",
        // Copied feedback
        copied && "ring-2 ring-green-500/50 bg-green-500/10",
        className
      )}
      title="Click to copy"
    >
      {children}
    </code>
  )
})
```

Key changes:
1. Remove `inline-block`
2. Remove `max-w-full overflow-x-clip text-ellipsis whitespace-nowrap`
3. Remove `align-text-bottom`
4. Remove truncation detection logic (no longer needed)
5. Add `[overflow-wrap:break-word]` to handle long content
6. Keep click-to-copy functionality
7. Keep copied feedback styling

## Testing Plan

1. Short inline code: `x` - should align with surrounding text
2. Medium inline code: `someVariable` - same alignment
3. Long truncated code: `someReallyLongVariableName...` - should not affect line height
4. Multiple on same line: `a` and `b` together - consistent alignment
5. Mixed with bold/italic: `code` in *italic* text - no jumping
6. Different parent font sizes: Test in headings vs body text

## Files to Modify

| File | Change |
|------|--------|
| `web/src/components/ui/inline-code.tsx` | Update className with new alignment styles |

---

*Created: 2024-12-18*
*Updated: 2024-12-18*
*Status: RESOLVED - Implemented Option A*
*Root Cause: Adding `inline-block` for truncation changes how element participates in line layout*
*Fix: Removed `inline-block` and truncation, added `overflow-wrap: break-word`, kept click-to-copy*
