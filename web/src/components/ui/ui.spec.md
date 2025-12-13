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

## Dependencies

| Import | Purpose |
|--------|---------|
| `@radix-ui/react-slot` | Polymorphic `asChild` support |
| `class-variance-authority` | Variant-based class management |
| `@/lib/utils` | `cn()` class name utility |

## Styling Approach

Uses shadcn/ui patterns:
- CSS variables for theming (`--primary`, `--destructive`, etc.)
- CVA for type-safe variants
- Tailwind for utility classes
- Dark mode via `dark:` variants

---

*Referenced by: [../components.spec.md](../components.spec.md)*
