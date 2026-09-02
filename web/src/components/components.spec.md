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

### `bud-settings-modal.tsx`

Per-Bud settings dialog (`BudSettingsModal`) with three tabs. Opened from the
thread panel header: the Layers button lands on **Sessions**, the gear and the
Bud name land on **General**. Escape and the backdrop close it;
`role="dialog"` + `aria-labelledby`.

**Props**:
- `bud: ApiBud` - full API row (name, display_name, accent_color, os/arch/version, status, last_seen_at)
- `isOpen`, `initialTab: 'general' | 'sessions' | 'device'`, `onClose`
- `onNavigateToThread` - Sessions tab thread links
- `onBudUpdated(bud)` - fired with the server row after a successful save

**General tab**:
- Display-name input (placeholder = daemon `name`; Reset clears it so the
  daemon name shows again), a swatch row of the `DEFAULT_AVATAR_COLORS`
  presets plus a "custom" swatch, and a hue slider (`accentColorForHue`: the
  palette's fixed lightness/chroma, free hue — every result is an in-range
  `oklch(L C H)` string, so black text stays legible on the tinted chips and
  the server's range check accepts it; the track is an oklch gradient of the
  reachable colors)
- Save sends one `PATCH /api/buds/:budId` with only the changed fields
  (`display_name` as `null` to reset); button is disabled until dirty; Enter in
  the input saves; success/error via the shared mutation-status banner
- Renames write `display_name`, never `name` (`name` is daemon-driven)

**Sessions tab** (`SessionsTab`, the former Terminal Sessions modal body, behavior unchanged):
- Fetches `/api/buds/:id/sessions` on mount, shows state, thread link, output stats
- Close session with confirmation; bud online/offline gates the close button
- Mutation-status banner for close success/failure and retryable load failures

**Device tab**: read-only daemon name, Bud ID (copy button), platform, daemon
version, status, last seen.

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

Main application components: bud rail, thread panel, chat timeline, command
composer, terminal views, file viewer pane, and proxied web-view pane.

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
