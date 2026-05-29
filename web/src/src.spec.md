# src

React application source code for the Bud web interface.

## Purpose

Contains all TypeScript/React source code for the Bud web UI, including components, routing, contexts, utilities, and styling.

## Files

### `main.tsx`

Application entry point.

**Responsibilities**:
- Creates TanStack Router instance from generated route tree
- Renders app into `#root` DOM element
- Wraps in React StrictMode

```typescript
import { routeTree } from './routeTree.gen'

const router = createRouter({ routeTree })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
```

**Type Registration**:
```typescript
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
```

### `index.css`

Global styles and CSS custom properties.

**Tailwind Setup**:
```css
@import "tailwindcss";
@source "../node_modules/streamdown/dist/*.js";
@source "../node_modules/@streamdown/code/dist/*.js";
@source "../node_modules/@streamdown/mermaid/dist/*.js";
@source "../node_modules/@streamdown/math/dist/*.js";
@import "tw-animate-css";
```

Streamdown core CSS and KaTeX CSS are imported once from `main.tsx` before the app theme CSS.

`index.css` also owns Bud's scoped Streamdown rich-block overrides under `.bud-markdown`. Those code, Mermaid, table, and math selectors are intentionally left outside Tailwind layers so they can override Streamdown's package utility classes without replacing the Streamdown plugin components.

**Theme System** (OKLCH colors):

| Category | Variables |
|----------|-----------|
| Core | `--background`, `--foreground`, `--card`, `--popover` |
| Semantic | `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive` |
| UI | `--border`, `--input`, `--ring` |
| Charts | `--chart-1` through `--chart-5` |
| Sidebar | `--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, etc. |
| Avatar | `--avatar-1` through `--avatar-5` |
| Custom | `--chat-bg`, `--chat-message`, `--terminal-bg`, `--terminal-text` |
| Bud | `--bud-accent-vibrant`, `--bud-accent-muted`, `--bud-accent-soft` |

**Dark Mode**: `.dark` class applies alternate OKLCH values.

**Font Families**:
- `--font-sans`: Inter, SF Pro Display, system-ui
- `--font-mono`: JetBrains Mono, SFMono-Regular, Menlo

**Base Styles**:
```css
@layer base {
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background text-foreground font-sans; }
  html, body { overscroll-behavior: none; }
}
```

**Streamdown Rich Blocks**:
- top-level Markdown blocks use compact `0.75rem` spacing, while list items use `calc(var(--spacing) * 0.25)` vertical padding and preserve nested-list indentation
- code blocks use a compact dark surface with reduced `0.85em` code text, no chat line numbers, and above-surface copy controls that use the code surface's dark button treatment; the scoped override also disables Streamdown's code-block paint containment so those controls can render outside the block
- Streamdown copy/action controls are tightened for the chat column, with code copy controls hidden until hover/focus on mouse-capable devices and protected by a narrow hover bridge
- Mermaid diagrams use a single bordered diagram surface with no visible label/header; copy/fullscreen controls sit above the surface, hide until hover/focus on fine-pointer devices with a narrow hover bridge for pointer travel, and remain visible on coarse-pointer devices
- tables use a single bordered table surface with contained overflow; copy controls sit above the surface in a transparent positioning shell, hide until hover/focus on fine-pointer devices with a narrow hover bridge for pointer travel, and remain visible on coarse-pointer devices
- KaTeX display math is constrained to the message column

### `routeTree.gen.ts`

Auto-generated route tree by TanStack Router plugin.

**Note**: Do not edit - regenerated on build/dev server start.

## Subfolders

### `components/` → [components/components.spec.md](./components/components.spec.md)

React components: UI primitives, workbench layouts, message renderers.

### `contexts/` → [contexts/contexts.spec.md](./contexts/contexts.spec.md)

React context providers for global state plus the Bud-route shared thread-summary context.

### `features/` → [features/features.spec.md](./features/features.spec.md)

Feature-owned runtime modules extracted from large routes.

### `lib/` → [lib/lib.spec.md](./lib/lib.spec.md)

Utility functions: split API/auth helpers, model loading, terminal helpers, theme colors, class name utilities.

### `routes/` → [routes/routes.spec.md](./routes/routes.spec.md)

TanStack Router file-based route definitions.

### `assets/` → [assets/assets.spec.md](./assets/assets.spec.md)

Static assets bundled by Vite.

## Architecture

```
main.tsx
    │
    └── RouterProvider
            │
            └── __root.tsx (providers)
                    │
                    ├── ThemeProvider
                    ├── AuthSessionProvider (seeded from root `/api/me` loader)
                    ├── LayoutProvider
                    └── BudStatusProvider
                            │
                            └── Routes
                                ├── /auth/mobile
                                ├── /auth/mobile/consent
                                ├── /login
                                ├── /settings
                                ├── /devices/claim/$flowId
                                ├── / (auth-aware entry)
                                └── /$budId (layout)
                                    ├── index (redirect to most recent thread or `/new`)
                                    ├── new (new thread workspace)
                                    └── $threadId (thread view)
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `react`, `react-dom` | React 19 |
| `@tanstack/react-router` | File-based routing |
| `better-auth` | Browser auth client |
| `tailwindcss` | Utility CSS |
| `tw-animate-css` | Animation utilities |
| `lucide-react` | Icons |
| `xterm`, `xterm-addon-fit` | Terminal emulation |
| `streamdown`, `@streamdown/code`, `@streamdown/mermaid`, `@streamdown/math` | Streaming-safe Markdown with code, diagram, and math plugins |
| `katex` | KaTeX CSS for math output |
| `react-syntax-highlighter` | File-viewer source preview highlighting |
| `@microlink/react-json-view` | JSON visualization |
| `class-variance-authority` | Variant styling |
| `clsx`, `tailwind-merge` | Class name utilities |

---

*Referenced by: [../web.spec.md](../web.spec.md)*
