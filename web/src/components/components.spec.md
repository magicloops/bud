# components

React components for the Bud web interface.

## Purpose

Provides all UI components: base primitives, workbench layouts, message renderers, modals, and utilities.

## Files

### `auth-page-shell.tsx`

Shared hosted-auth layout and provider actions used by `/login`, `/auth/mobile`, and `/auth/mobile/consent`.

**Exports**:
- `AuthPageShell` - common neobrutalist auth card chrome with badge/title/description/error treatment
- `AuthDetailPanel` - dashed metadata panel used for return targets, client IDs, scopes, and redirect URIs
- `SocialSignInActions` - shared GitHub/Google OAuth buttons with pending-state handling
- `SocialAuthProvider` - provider union (`github | google`)

**Purpose**:
- keeps the browser login and mobile OAuth pages visually aligned
- centralizes the provider button styling instead of duplicating it across routes
- gives the consent screen the same auth-shell treatment without coupling it to sign-in behavior

### `theme-provider.tsx`

Theme context provider for light/dark/system mode.

**Type**: `Theme = 'dark' | 'light' | 'system'`

**Features**:
- Persists to localStorage (`bud-ui-theme`)
- Applies CSS class to `<html>` element
- Respects `prefers-color-scheme` for system mode
- While `theme === 'system'`, listens for `prefers-color-scheme` changes so the UI updates live when the OS theme flips

**Hook**: `useTheme()` - Returns `{ theme, setTheme }`

### `bud-sessions-modal.tsx`

Modal dialog for viewing and managing terminal sessions on a bud.

**Props**:
- `budId`, `budName` - Bud identification
- `isOpen`, `onClose` - Modal state
- `onNavigateToThread` - Navigation callback

**Features**:
- Fetches sessions from `/api/buds/:id/sessions`
- Shows session state, thread link, output stats
- Delete session with confirmation
- Bud online/offline indicator
- Auto-refresh on open
- Uses the shared mutation-status banner for visible close-session success/failure feedback and retryable load failures instead of collapsing every action error into a blank/error-only modal body

**Session Info Displayed**:
- Session ID (truncated)
- State with color indicator
- Linked thread title
- Last activity time
- Output bytes

### `debug-panel.tsx`

Development-only debug overlay.

**Shows**:
- budId, threadId, sessionId
- Terminal state and connection status
- Copy JSON / Log buttons

**Visibility**: Only in `import.meta.env.DEV`

### `route-error-screen.tsx`

Branded full-page recovery screen for uncaught route errors.

**Features**:
- Replaces TanStack Router's default generic crash UI for root-level route errors
- Translates owned-route `404` failures such as `bud_not_found` into user-facing copy
- Offers a primary "Return Home" action back to `/`
- Preserves Bud's existing neobrutalist card treatment so permission failures feel intentional rather than accidental

## Subfolders

### `ui/` → [ui/ui.spec.md](./ui/ui.spec.md)

Base UI primitives (Button) using shadcn/ui patterns.

### `workbench/` → [workbench/workbench.spec.md](./workbench/workbench.spec.md)

Main application components: bud rail, thread panel, chat timeline, command composer, terminal views.

### `message-renderers/` → [message-renderers/message-renderers.spec.md](./message-renderers/message-renderers.spec.md)

Registry-based rendering for chat messages by role and tool type.

## Component Patterns

### Neobrutalist Design

Components follow neobrutalist UI patterns:
- Thick black borders (`border-3`, `border-4`)
- Hard shadows (`shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]`)
- Hover lift effects (`hover:-translate-y-0.5`)
- Bold typography (monospace fonts, uppercase labels)
- High contrast colors

### State Colors

Consistent color scheme for states:
| State | Color |
|-------|-------|
| Online/Active | Green (`#16a34a`) |
| Ready/Idle | Blue (`#60a5fa`) |
| Pending/Creating | Yellow (pulsing) |
| Offline/Closed | Orange/Gray |
| Error | Red |

### CSS Custom Properties

Components use bud-specific CSS variables:
- `--bud-accent-vibrant` - Primary accent
- `--bud-accent-muted` - Subdued accent
- `--bud-accent-soft` - Background accent
- `--chat-bg` - Chat area background
- `--sidebar` - Sidebar background

## Dependencies

| Import | Purpose |
|--------|---------|
| `react` | Core React |
| `lucide-react` | Icon library |
| `@radix-ui/react-slot` | Polymorphic components |
| `class-variance-authority` | Variant styling |
| `@/lib/utils` | Utilities (cn) |
| `@/lib/api` | API helpers |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
