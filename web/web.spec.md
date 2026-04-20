# web

React frontend for the Bud application.

## Purpose

Provides a web-based chat interface for interacting with Buds. Features include:
- Better Auth-based browser sign-in
- Settings page for username management, linked providers, and sign-out
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

The package manifest pins the Node runtime expected by the Vite 7 toolchain: Node `20.19+` or `22.12+`.

## Configuration Files

### `.env.example`

Checked-in template for local frontend setup.

Recommended local development:
- set `VITE_API_BASE_URL=http://localhost:3000`
- optionally keep `VITE_API_PROXY_TARGET=http://localhost:3000` if you still want proxied `/.well-known/*` / `/api/*` routes available through the Vite origin for targeted auth-topology checks
- prefer direct backend-origin API/SSE traffic locally because each open thread view holds both agent and terminal SSE streams, and proxy-mode same-browser multi-tab testing can starve short-lived fetches
- local iOS auth still treats `http://localhost:5173` as the public auth origin; use the proxy path only when you explicitly need browser/mobile-visible `5173` routing parity for auth and discovery flows
- the prototype deployment recommendation is to keep `VITE_API_BASE_URL` unset there as well and rely on one public origin that routes `/api/*`, `/.well-known/*`, and `/ws` to the service

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
| `VITE_API_BASE_URL` | API server URL for cross-origin | unset (`same origin` when omitted) |
| `VITE_API_PROXY_TARGET` | Dev proxy target for `/api/*` and `/.well-known/*` | `http://localhost:3000` |
| `VITE_MOBILE_CLAIM_CALLBACK_ALLOWED_PREFIXES` | Comma-separated allowlist of hosted mobile-claim callback prefixes | `chat.bud.app://claim/` |
| `VITE_ROUTER_DEVTOOLS` | Enable TanStack Router devtools | `false` |

Current deployment guidance still favors leaving `VITE_API_BASE_URL` unset in browser-facing deployed environments so auth and API traffic remain same-origin. The direct backend-origin recommendation applies to local browser development only.

## Key Features

### Real-time Terminal

- xterm.js terminal emulator
- SSE streaming from `/api/threads/:id/terminal/stream`
- Explicit browser keyboard/paste translation, then batching to `/api/threads/:id/terminal/input`
- Automatic reconnection with exponential backoff
- History backfill on connect

### Chat Interface

- Message timeline with role-based rendering
- Stable `client_id`-first message identity across optimistic sends, `/agent/state` bootstrap, agent SSE, and canonical transcript rows
- Tool call visualization (terminal.run, etc.)
- Markdown with syntax highlighting
- Agent streaming via SSE

### Browser Auth

- `/login` route for GitHub and Google OAuth
- `/auth/mobile` hosted OAuth login route for native/mobile authorization requests
- `/auth/mobile/consent` hosted consent route for forced/non-trusted OAuth flows
- `/settings` route for profile management and provider linking
- Root app shell resolves `/api/me` before rendering authenticated state
- Shared credential-aware `fetch` helper for cookie auth
- Shared auth-aware `EventSource` creation for SSE streams
- Better Auth OAuth Provider client plugin preserves signed `oauth_query` state when hosted auth pages start social sign-in
- Session-expiry redirects now stop background reconnect/poll loops once auth has expired
- Hosted Bud claim pages can optionally hand control back into the native app when allowlisted mobile callback params are present

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
| `better-auth` | Browser auth client |
| `@better-auth/oauth-provider` | Hosted OAuth Provider client plugin |
| `xterm`, `xterm-addon-fit` | Terminal |
| `uuid` | UUIDv7 `client_id` generation for browser-created message identities |
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
