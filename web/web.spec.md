# web

React frontend for the Bud application.

## Purpose

Provides a web-based chat interface for interacting with Buds. Features include:
- Multi-bud navigation with sidebar
- Thread-based conversations
- Real-time terminal streaming (xterm.js)
- Agent message rendering with tool call visualization
- Dark/light theme support
- Neobrutalist UI design

## Technology Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| React | 19.x | UI framework |
| TypeScript | 5.9 | Type safety |
| Vite | 7.x | Build tool & dev server |
| TanStack Router | 1.x | File-based routing |
| Tailwind CSS | 4.x | Utility styling |
| xterm.js | 5.x | Terminal emulation |

## Project Structure

```
web/
├── src/               → Application source
│   ├── main.tsx       → Entry point
│   ├── index.css      → Global styles & theme
│   ├── components/    → React components
│   ├── contexts/      → React context providers
│   ├── lib/           → Utility functions
│   ├── routes/        → TanStack Router routes
│   └── assets/        → Bundled static assets
├── public/            → Static assets (unprocessed)
├── index.html         → HTML entry point
├── vite.config.ts     → Vite configuration
├── tsconfig.json      → TypeScript configuration
├── package.json       → Dependencies & scripts
└── components.json    → shadcn/ui configuration
```

## Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `vite` | Start development server |
| `build` | `tsc -b && vite build` | Type check & production build |
| `lint` | `eslint .` | Run ESLint |
| `preview` | `vite preview` | Preview production build |

## Configuration Files

### `vite.config.ts`

Vite build configuration with:
- React plugin (`@vitejs/plugin-react`)
- TanStack Router plugin (`@tanstack/router-plugin`)
- Tailwind CSS plugin (`@tailwindcss/vite`)
- Path aliases (`@/` → `src/`)

### `tsconfig.json`

TypeScript configuration with:
- Strict mode enabled
- Path aliases for `@/` imports
- Composite project references

### `components.json`

shadcn/ui CLI configuration:
- Component style preferences
- Tailwind CSS integration
- Import alias configuration

## Subfolders

### `src/` → [src/src.spec.md](./src/src.spec.md)

React application source code.

### `public/` → [public/public.spec.md](./public/public.spec.md)

Static assets served without processing.

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `VITE_API_BASE_URL` | API server URL for cross-origin | (same origin) |
| `VITE_ROUTER_DEVTOOLS` | Enable TanStack Router devtools | `false` |

## Key Features

### Real-time Terminal

- xterm.js terminal emulator
- SSE streaming from `/api/threads/:id/terminal/stream`
- Input forwarding to `/api/threads/:id/terminal/input`
- Automatic reconnection with exponential backoff
- History backfill on connect

### Chat Interface

- Message timeline with role-based rendering
- Tool call visualization (terminal.run, etc.)
- Markdown with syntax highlighting
- Agent streaming via SSE

### Theming

- OKLCH color system
- Per-bud accent colors
- Dark/light mode toggle
- CSS custom properties for runtime theming

### UI Design

Neobrutalist patterns:
- Thick black borders (`border-3`, `border-4`)
- Hard shadows (`shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]`)
- Hover lift effects
- High contrast colors
- Monospace typography

## Dependencies

### Runtime

| Package | Purpose |
|---------|---------|
| `react`, `react-dom` | React 19 |
| `@tanstack/react-router` | Routing |
| `xterm`, `xterm-addon-fit` | Terminal |
| `react-markdown` | Markdown |
| `react-syntax-highlighter` | Code highlighting |
| `@microlink/react-json-view` | JSON display |
| `lucide-react` | Icons |
| `tailwindcss` | Styling |
| `class-variance-authority` | Variants |
| `clsx`, `tailwind-merge` | Class utilities |
| `@radix-ui/react-slot` | Polymorphic components |

### Development

| Package | Purpose |
|---------|---------|
| `vite` | Build tool |
| `typescript` | Type checking |
| `eslint` | Linting |
| `@vitejs/plugin-react` | React Fast Refresh |
| `@tanstack/router-plugin` | Route generation |
| `@tailwindcss/vite` | Tailwind integration |

---

*Referenced by: [../bud.spec.md](../bud.spec.md)*
