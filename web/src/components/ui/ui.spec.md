# ui

Base UI components - shadcn/ui inspired primitives.

## Purpose

Provides foundational UI components with consistent styling using Tailwind CSS and class-variance-authority (CVA) for variant management.

## Files

### `button.tsx`

Configurable button component with variants.

**Variants**:

| Variant | Description |
|---------|-------------|
| `default` | Primary background with primary text |
| `destructive` | Red/danger styling |
| `outline` | Border with transparent background |
| `secondary` | Secondary background |
| `ghost` | Transparent until hovered |
| `link` | Text-only with underline on hover |

**Sizes**:

| Size | Description |
|------|-------------|
| `default` | h-9, standard padding |
| `sm` | h-8, reduced padding |
| `lg` | h-10, larger padding |
| `icon` | 36x36px square |
| `icon-sm` | 32x32px square |
| `icon-lg` | 40x40px square |

**Props**:
- All standard `<button>` props
- `variant` - Visual style
- `size` - Button size
- `asChild` - Render as child element (via Radix Slot)

**Features**:
- Focus ring styling
- Disabled state styling
- SVG icon handling
- aria-invalid styling for form validation

**Usage**:
```tsx
<Button variant="destructive" size="sm">
  Delete
</Button>
```

### `tooltip.tsx`

Radix-based tooltip component following shadcn/ui patterns.

**Exports**:
- `TooltipProvider` - Context provider for tooltips
- `Tooltip` - Root component
- `TooltipTrigger` - Element that triggers tooltip
- `TooltipContent` - Tooltip content with animations

**Features**:
- Smooth fade/zoom animations
- Configurable side offset
- Portal rendering for proper stacking
- Dark mode support

**Usage**:
```tsx
<TooltipProvider>
  <Tooltip>
    <TooltipTrigger>Hover me</TooltipTrigger>
    <TooltipContent>Tooltip content</TooltipContent>
  </Tooltip>
</TooltipProvider>
```

### `inline-code.tsx`

Inline code component with click-to-copy functionality.

**Props**:
- `children` - Code content to display
- `className` - Optional additional classes

**Features**:
- Click to copy content to clipboard
- Visual feedback on copy (green ring)
- Pointer cursor on hover
- Proper baseline alignment with surrounding text
- Long code wraps instead of overflowing (via `overflow-wrap: break-word`)

**Usage**:
```tsx
<InlineCode>some_variable_name</InlineCode>
```

**Implementation Notes**:
- Uses simple `display: inline` (default) for proper baseline alignment
- NO `inline-block` - this breaks baseline alignment with surrounding text
- `overflow-wrap: break-word` allows long code to wrap instead of overflow
- Copies via `navigator.clipboard.writeText()`

### `code-block.tsx`

Syntax-highlighted code block with copy button.

**Props**:
- `code` - The code string to display
- `language` - Programming language for syntax highlighting
- `className` - Optional additional classes

**Features**:
- Syntax highlighting via `react-syntax-highlighter` with `oneDark` theme
- Copy button appears on hover (top-right)
- Visual feedback on copy (checkmark icon, green tint)

**Usage**:
```tsx
<CodeBlock code="const x = 1" language="javascript" />
```

## Dependencies

| Import | Purpose |
|--------|---------|
| `@radix-ui/react-slot` | Polymorphic `asChild` support |
| `@radix-ui/react-tooltip` | Tooltip primitives |
| `class-variance-authority` | Variant-based class management |
| `lucide-react` | Icons (Copy, Check) |
| `react-syntax-highlighter` | Code syntax highlighting |
| `@/lib/utils` | `cn()` class name utility |

## Styling Approach

Uses shadcn/ui patterns:
- CSS variables for theming (`--primary`, `--destructive`, etc.)
- CVA for type-safe variants
- Tailwind for utility classes
- Dark mode via `dark:` variants

---

*Referenced by: [../components.spec.md](../components.spec.md)*
