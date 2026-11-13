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
Schedule reviews show the local schedule, no-catch-up behavior and "No personal data"
when no scopes are requested; contact sources appear only for new-contact rules.
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
versioned saves. Future data types are explicitly unavailable. The per-source
sections are `data-sources.tsx`; this file keeps the Contacts import status and
troubleshooting.

### `data-sources.tsx`

One card per data source from `GET /api/data/sources` (bud-mobile
`plan/data-sources-ux`): the account's switch (`PUT /api/data/sources/:source`, kept at
the last confirmed value on failure), what is stored, each phone's iOS permission as it
last reported (read-only: permission is changed on the phone), who can read, and a browse
link. Text comes from `lib/data-sources.ts`.

Each card also has "Read in the last week" (plan phase 3): the document's `recent_access`
groups, with a link to the conversation an agent's reads happened in. "Show every read and
change" loads `GET /api/data/access?source=` a page at a time into a table (when, who, what,
result) and `GET /api/data/sources/:source/changes` into a list. The log holds no content,
so neither does the table.

`message-renderers/tools/source-request.tsx` renders the agent's request for a data source
(tool `data_source_request`, plan phase 2b) as one card: the purpose in a fixed sentence, one
button, "Turn on *Source*", which calls `POST /api/data/source-requests/:id/allow` (the switch
and the agent's permission together), and "Not now". When no phone has reported that it can
collect, it says to continue on the iPhone, shows each phone's reported state and polls until
that changes. After a click, nothing left means `granted`; the service settles the answer. A
closed request is one line with a link to Data sources. `SourceUnavailableContent` adds a
"Turn on" link under a personal-data read refused for a setting (`unavailable_source`),
chosen by `getToolContentRenderer(toolName, payload)`. The question form has no source kind.

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

Browser discovery now belongs to `features/browser/pane.tsx` and the workbench
Browser tab, separate from this data/automation modal. Remote frames never enter
chat state.

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

Automation review cards/details now distinguish Create automation from Update
existing automation using server review_operation metadata, with neutral fallback.
Replacement approval uses Update. Destination labels say This conversation,
New conversation each time, or Another conversation with its title (ID fallback).
Shared presentation helpers live in automation-proposal-summary.tsx; render tests
cover operation/destination labels and older-service fallback.

Automation proposal summaries additionally distinguish inherited policy from
explicit overrides and show server-computed current model/reasoning and fallback
warnings. They explain retirement fallback separately from offline local waits.
Render tests cover inherited presentation without stale explicit reasoning.

### `health-screen.tsx`

Owner view at `/data/health`: last 14 nights of sleep (browser timezone; asleep
and stage minutes, the chosen source and other recording sources) and 30 days of
workouts (newest first, Load more), each with last-received coverage. Each load
is a generation: Refresh aborts an in-flight Load more, and stale pages never
change rows, cursor, error or loading state. States that HealthKit hides denied
access. `data-screen.tsx` adds a Health source summary, a Browse health link and
agent Health toggles (per type, shown only when the service advertises
`supported_health_types`). App access requests and agent summaries show health
types.

`data-screen.tsx` Data sources also shows a Location summary (last received and
latest visit) from `/api/data/status`, pointing to the mobile Location section
for permission.

### `location-screen.tsx`

Owner view at `/data/location`:
- a last-known line from `/api/data/location/recent` (a fix reads "Here:
  <address>", a point is marked approximate);
- a day picker and the day's visits (`/api/data/location/visits`, local-day
  window, oldest first);
- a MapKit JS map of the selected visit (`VisitMap`, with its accuracy circle;
  the OpenStreetMap embed when maps are unavailable), with "Save as place" when
  the visit isn't at a saved place; the last-known fix or visit has it too;
- a Places section listing saved places (address under the name, radius,
  "saved by an agent") with "View on map / Move" and delete;
- the Geoapify / OpenStreetMap attribution (`PlaceDataAttribution`), since
  visit names and addresses come from the service's Geoapify lookups.

"Save as place" and "View on map / Move" open the pin editor
(`place-pin-editor.tsx`): create is a `POST`, edit a `PUT` with only the changed
fields (`placeUpdateBody`), since moving or resizing restarts the place's
presence. Labels come from `lib/location-format.ts`; places load through
`lib/places.ts`.

### `place-pin-editor.tsx`

The place pin editor (Phase 9), used by the location screen and by place
questions (`workbench/question-request-card.tsx`):
- `PlacePinEditor`: MapKit JS map with a fixed pin at the visual centre (the
  user moves the map under it), the radius as a circle that follows the centre,
  an optional dashed accuracy circle for the starting reading, a search box
  (Phase 11: `GET /api/places/search` near the map centre, on Enter or the
  button; results show the linked Geoapify / OpenStreetMap attribution, and a
  429 or 503 shows a message while the map and pin keep working), a
  name field, an optional address field and a 50–2000 m radius slider (step 25).
  The address (Phase 10) is filled by a picked result's `address`,
  seeded from a question's `query` or a saved place's address, and editable;
  when the pin moves more than `ADDRESS_DROP_M` (50 m) from where it was set,
  the field clears with "Keep it" to restore it (anchor rules in
  `lib/place-pin.ts`). A start with `query` and no
  centre searches and centres on the first result, listing the others. Editing a
  saved place says that moving or resizing restarts its arrivals and departures.
  When maps are unavailable (`/api/maps/token` 503, or MapKit fails to load) it
  says so and still saves the starting coordinate with the chosen name and
  radius; with no starting coordinate there's nothing to save.
- `PlacePinDialog`: the editor in a native modal, portalled to `document.body`
  so its form never nests in the question form.
- `VisitMap`: a read-only MapKit map with a marker and accuracy circle, or the
  OpenStreetMap embed when maps are unavailable.
- `PlaceDataAttribution`: "Powered by Geoapify · © OpenStreetMap contributors",
  linked.

MapKit loading lives in `lib/mapkit.ts`; search helpers in
`lib/place-search.ts`; seeding, changed fields and answers in
`lib/place-pin.ts`. `place-pin-editor.test.tsx` mounts the editor with maps
unavailable; `place-pin-search.test.tsx` mounts it on a fake MapKit to cover
the seed search, filling the address from a pick, the `near` bias, and the
rate-limited and unavailable messages.
