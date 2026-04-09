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
@plugin "@tailwindcss/typography";
@import "tw-animate-css";
```

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

### `routeTree.gen.ts`

Auto-generated route tree by TanStack Router plugin.

**Note**: Do not edit - regenerated on build/dev server start.

## Subfolders

### `components/` → [components/components.spec.md](./components/components.spec.md)

React components: UI primitives, workbench layouts, message renderers.

### `contexts/` → [contexts/contexts.spec.md](./contexts/contexts.spec.md)

React context providers for global state plus the Bud-route shared thread-summary context.

### `lib/` → [lib/lib.spec.md](./lib/lib.spec.md)

Utility functions: API helpers, theme colors, class name utilities.

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
                    ├── AuthSessionProvider
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
                                    ├── index (new thread)
                                    └── $threadId (thread view)
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `react`, `react-dom` | React 19 |
| `@tanstack/react-router` | File-based routing |
| `better-auth` | Browser auth client |
| `tailwindcss` | Utility CSS |
| `@tailwindcss/typography` | Prose styling |
| `tw-animate-css` | Animation utilities |
| `lucide-react` | Icons |
| `xterm`, `xterm-addon-fit` | Terminal emulation |
| `react-markdown` | Markdown rendering |
| `react-syntax-highlighter` | Code highlighting |
| `@microlink/react-json-view` | JSON visualization |
| `class-variance-authority` | Variant styling |
| `clsx`, `tailwind-merge` | Class name utilities |

---

*Referenced by: [../web.spec.md](../web.spec.md)*
