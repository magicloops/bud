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
thread panel header (gear or Bud name) on **General**; `initialTab` still
allows opening on any tab. Escape and the backdrop close it;
`role="dialog"` + `aria-labelledby`.

**Props**:
- `bud: ApiBud` - full API row (name, display_name, accent_color, os/arch/version, status, last_seen_at)
- `isOpen`, `initialTab: 'general' | 'sessions' | 'device'`, `onClose`
- `onNavigateToThread` - Sessions tab thread links
- `onBudUpdated(bud)` - fired with the server row after a successful save

**General tab**:
- Display-name input (placeholder = daemon `name`; Reset clears it so the
  daemon name shows again), a swatch row of the `BUD_ACCENT_PRESETS`
  (`DEFAULT_AVATAR_COLORS` + `BUD_ACCENT_GRAY`, a preset-only neutral that
  auto-assignment never hands out) plus a "custom" swatch, and a hue slider (`accentColorForHue`: the
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

### `automation-proposal-review.tsx`

Shared immutable automation activation review and summary. Owner-keyed parents
mount by proposal ID; the component fetches the human-authorized detail and
capability, polls serially, and aborts reads/ignores writes after unmount.
One Enable automation action approves the saved proposal; decline remains
available independently. Unknown mutation outcomes retain the exact version and
idempotency key for retry. Terminal server state replaces pending decisions.
Compact inline actions expose the consequential scope; the shared native dialog exposes full instructions, target, sources, scopes/history and limits without a second decision controller.
Decision rows put red Deny left, blue borderless View details center, and green
Enable/Process contacts right; uncertain outcomes retain the original retry.

The same component also handles validated `bp_` existing-contact review IDs through
the separate existing-contact endpoint and capability. It rejects a mismatched
returned identity/kind before enabling approval. The action is Process reviewed
contacts, preserves the frozen decision on uncertain retries, and displays the
captured bootstrap receipt after approval. Existing-contact summaries include
frozen contact/group counts, active revision, selection/search/limit, batching,
source filter and explicit repeat consequences. Render tests cover both grouping
modes and exclusion policies. No activation endpoint is used for these reviews.

### `automation-proposal-summary.tsx` / `automation-proposal-summary.test.tsx`

Pure saved-definition review presentation, shared with the interactive review.
Server-rendered tests verify full instruction, target, scope/history and limit
visibility without an approval checkbox or automatic actions.
Run the JSX render tests from web with `pnpm exec tsx --tsconfig tsconfig.app.json
--test src/components/automation-proposal-summary.test.tsx`.

### `settings-layout.tsx` / `settings-layout.css`

Shared SettingsNavigation and scoped, theme-token-based management controls.
Account settings, Data sources, Browse data and Automations share modest borders,
small shadows, responsive spacing and focus states. Full-page settings surfaces
share the thread panel's secondary background tint; inline reviews and dialogs
retain their own surface background.

### `data-screen.tsx`

Owner-remounted source/access management and the separate Contacts browser.
Management loads status without fetching contact inventory; browsing uses existing
owner-scoped search/detail/history/location APIs. Agent grants retain immediate
versioned saves. Future data types are explicitly unavailable.

### `app-data-permissions.tsx`

Owner-keyed callers use one exact-request or paged inventory loader and shared
AppPermissionCard. Allow/Deny requires no checkbox. Inventory rows expand in
place; chat details open a dialog. Status derives from both request and key,
separating pending, allowed/setup, active and revoked. Pending/active rows sort
ahead of history within each server page without changing pagination cursors.
Expected versions and identical uncertain retry bodies remain bound to the
original action; confirmed failures expose refresh. Card identity stays request
stable across polling and settlement.
Inline pending rows use the same Deny/details/Allow action order and colors as
automation reviews, preserving decision and retry guards.

### `review-details.tsx`

Read-only native HTML dialog with accessible title, focus trapping, Escape/Close
and inert background. Opening/dismissing never submits a decision.

### `chat-data-context.tsx`

Owner/thread-remounted Automations and Data access modal, opened by a Workflow icon beside the
transcript toggle, labeled “Automations & data access.” Native dialog supplies focus trapping, Escape/Close and inert
background; Automations and Data access load only while open, with reads aborted
on close. Authorizes
thread context before reading active-target automation filters or the owner's
agent grant/source receipts. Explicitly labels account-wide agent access, unknown
states and server receipts. Links preserve filters and the return conversation.
The section switcher forms the header without a duplicate title; an icon closes
the dialog, automation rows separate names from status, and the footer holds
management and refresh actions. The dialog retains an accessible name.

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
