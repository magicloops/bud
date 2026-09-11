# routes

TanStack Router file-based routing for the Bud web application.

## Purpose

Defines the application's route structure using TanStack Router's file-based routing convention. Routes handle data loading, navigation, and layout composition.

## Files

### `__root.tsx`

Root layout component wrapping all routes.

**Route**: `createRootRoute()`

**Provider Hierarchy**:
```tsx
<ThemeProvider>
  <AuthSessionProvider>
    <LayoutProvider>
      <BudStatusProvider>
        <Outlet />
        {/* Optional DevTools */}
      </BudStatusProvider>
    </LayoutProvider>
  </AuthSessionProvider>
</ThemeProvider>
```

**Features**:
- Loads `/api/me` before rendering the app shell
- Wraps app in context providers (theme, auth session, layout, bud status)
- Seeds `AuthSessionProvider` from `fetchCurrentUser()` in the root loader so child routes can rely on a single browser-session source of truth
- Conditional router devtools via `VITE_ROUTER_DEVTOOLS=true`
- `<Outlet />` renders child routes
- Installs a branded root `errorComponent` so uncaught loader errors render a Bud-styled recovery page with a home action instead of TanStack Router's generic fallback

### `index.tsx`

**Route**: `/`

Authenticated root index with auto-redirect to first bud.

**Behavior**:
```typescript
loader: async () => {
  const buds = await apiFetchJson('/api/buds')
  if (buds.length > 0) {
    throw redirect({ to: '/$budId', params: { budId: buds[0].bud_id } })
  }
}
```

**Fallback**: Shows an authenticated empty state if the signed-in user has no Buds.
**Auth Handling**: Uses `redirectOnUnauthorized: false` plus a shared `toLoginRedirect(...)` helper so loader redirects stay explicit.

### `login.tsx`

**Route**: `/login`

Public browser login route for OAuth entry.

**Features**:
- Supports GitHub and Google sign-in through Better Auth
- Accepts `?redirect=` return targets
- Bounces already-authenticated users back into the app shell
- Reuses the same route shape for device-claim resume after OAuth login
- Now renders through the shared hosted-auth shell used by the mobile OAuth pages

### `auth.mobile.tsx`

**Route**: `/auth/mobile`

Hosted mobile OAuth login route used as Better Auth `loginPage`.

**Features**:
- Reuses the same GitHub/Google entry surface as `/login`
- Detects Better Auth's signed `oauth_query` from the browser URL
- Preserves OAuth resume state through social sign-in via the Better Auth OAuth Provider client plugin
- If the browser already has a Bud session, resumes the authorization request by sending the browser back to `/api/auth/oauth2/authorize` without the consumed `login` prompt
- Shows request metadata such as client ID, scopes, and redirect URI so forced/manual tests are easier to inspect

### `auth.mobile.consent.tsx`

**Route**: `/auth/mobile/consent`

Hosted mobile consent route used as Better Auth `consentPage`.

**Features**:
- Parses the same signed OAuth request metadata as `/auth/mobile`
- Redirects anonymous browsers back through `/auth/mobile` while preserving the signed query string
- Posts approve/deny actions to `/api/auth/oauth2/consent`
- Handles Better Auth redirect responses and returns control to the native client/app callback
- Exists even when trusted first-party clients usually skip consent, so `prompt=consent` remains testable

### `data.tsx`

Authenticated `/data` Data sources route delegates management/import status to DataScreen, linked from Settings. Contact records live separately at `/data/contacts`. Uses the shared credential-aware transport and root viewer gate. State remounts per owner and requests abort on view/query changes. Uses canonical first-party data APIs, bounded pages, and observed-time/source-visibility labels. Owner-wide agent read permission controls save optimistic versions with explicit reload/conflict handling. Contact detail fetches nearest location evidence within ±24 hours of first detection and labels uncertainty/accuracy; OpenStreetMap loads only after the user selects Show pin.

Agent permission toggles save immediately; history saves on blur/Enter. Requests
are serialized, owner-remounted, and guarded after unmount. Failed/uncertain
saves restore the last confirmed values and require reload before further edits.

Contact field toggles use `supported_contact_fields` from the owner's grant
response and save explicit `fields` immediately. Older services show their
legacy coverage without offering unsupported controls. Requests carry only
version, scopes, history and supported field choices. The existing authenticated
viewer, owner-keyed remount, server owner lookup and updater stamp govern these
changes; no client-supplied owner or new endpoint is introduced.

Contact detail and expandable historical revisions share structured address and
labeled website display. Absent fields report uncollected; empty arrays report
observed empty. URLs render as selectable plain text without navigation/fetching,
and postal addresses are explicitly separate from sensor location evidence.
Source guidance points to the mobile expanded-collection toggle and excludes
pictures/notes; search is described in terms of collected fields.

The Data sources page presents bounded app permission/key inventory,
refreshing serially every five seconds. Cards show the immutable purpose,
scopes/fields/history/precision, private destination and installation fingerprint,
with requesting-conversation links. Allow is the explicit decision and requires the server app-key capability; decline/revoke remain independently available.
Mutations use expected versions and retain the identical retry body after an
uncertain response. Cards retain request identity across version changes, and owner-page remount plus
unmount guards prevent late responses from updating another view. Inline transcript controls are implemented; browser interaction validation remains open.

The `/data` route accepts a validated `request` search parameter to review one
exact permission through the owner-scoped detail endpoint, independent of list
pagination. Changing the request remounts its review state; View all returns to
inventory. Legacy exact-request links remain supported; canonical chat requests use inline Allow/Deny and optional details.

Import status displays owner-wide failed-record/reconciliation counts and up to
ten recent unfinished scan reasons, with guidance to retry retained original
uploads on the source phone. New optional fields tolerate older services. Refresh
withholds stale import status until the current request succeeds. A reconciliation
scan is not represented as repairing missing predecessors.

Unfinished diagnostics include only pending, repair-pending and invalid scans;
closed superseded scans stay in API history without appearing as failures. When
original uploads are unavailable, guidance points to the explicit phone Repair
control, distinct from ordinary reconciliation.

Source presentation separates received-data status from current phone connectivity.
Refresh received data only refetches existing APIs; mobile owns collection and OS
permissions. Scan IDs/reasons and repair guidance are collapsed under Troubleshooting.
Agent and app permission panels are independently expandable; an exact request link
opens app permissions for review. No authorization, owner scoping or wire changes.

### `data_.contacts.tsx`

Independent `/data/contacts` route using DataScreen in browse mode. The trailing
underscore makes it a sibling rather than requiring an Outlet in management.
Contacts search/detail/history/location remain owner-scoped; type navigation
reserves clearly unavailable Location, Health and Photos browsers.

### `automations.tsx`

Authenticated `/automations`, linked directly from Settings. Validated `rule` search selects an exact rule (or new draft) and preserves selection across reload/back navigation. Trigger attribution links open its editor and activity. Detail reads still resolve through the existing owner-authorized API; no new management authority is introduced. The screen is titled Automations, with source/access/execution limits grouped under Advanced settings while activation review retains all effective values. Lists owner-scoped rules and edits shared drafts with owned Bud/model/thread/source selectors, requested scopes/history and work limits. Preserves unavailable stored model choices; never substitutes on save. New drafts retain one creation key and freeze uncertain request bodies for explicit retry. Editor remounts on owner/rule changes and guards responses after unmount. Optimistic conflicts require reloading saved state. Shows active definition separately, pause with separate queued/active cancellation choices, and bounded delivery history with canonical invocation state and conversation links. Activation review displays the saved instruction, target, scope/history and limits, requires acknowledgement and matching saved draft, and follows the server activation capability. Existing-contact controls preview the saved draft or active revision, require explicit processing/rerun/standing-work consent, and preserve uncertain capture bodies for retry. Bounded request history and progress recover cross-device receipts, show canonical group states and conversation links, and support cancellation without implying remote commands stopped. Browser interaction and mobile parity remain in progress. Builds verified; browser interaction validation remains open.

Automation reviews also appear in the shared inventory under Needs your review.
Validated `proposal` search selects the exact owner-authorized immutable review,
independent of rule pagination. Pending inventory refreshes serially; the shared
review component handles single-action enable/decline and uncertain retries.
The owner-keyed page prevents requests and decision state surviving account switches.

### `settings.tsx`

**Route**: `/settings`

Authenticated account settings route.

**Features**:
- Loads through the same `/api/me` auth gating as the rest of the app shell
- Uses `useRequireAuthenticatedUser(...)` against root-seeded auth-session state instead of duplicating a route loader auth fetch
- Edits the Bud-owned `profile.username` via `PATCH /api/me/profile`
- Shows provider-backed avatar with initials fallback
- Shows linked-account state for GitHub and Google
- Settings cards use one compact section heading, without a repeated title below it.
- The page background matches the thread panel's secondary tint; account identity has no pill, and the borderless username input retains a screen-reader label and keyboard focus ring.
- Starts explicit provider linking through Better Auth client actions
- Uses the shared mutation-status component for username save feedback, provider-link redirect/error state, and sign-out failure display
- Provides separate Data sources and Automations navigation entries; destination APIs retain their existing viewer authorization and owner-scoped reads, with no new writes or row stamping.
- Signs the browser session out through Better Auth and returns to `/login`

### `devices.claim.$flowId.tsx`

**Route**: `/devices/claim/$flowId`

Public device-claim landing page for QR/link onboarding.

**Behavior**:
- Loads safe claim metadata from `/api/device-auth/flows/:flowId`
- If the browser is anonymous and the claim is pending, redirects into `/login` using the full current claim URL so callback params survive login resume
- If the browser is authenticated and the claim is pending, auto-posts approval to `/api/device-auth/flows/:flowId/approve`
- After approval starts, revalidates the flow until the service reports the canonical `approved` or `completed` state so the page stays in sync with Bud reconnects
- If allowlisted `source=ios` + `mobile_callback_url` params are present, successful approval/completion redirects back into the app with `flow_id` and `bud_id`
- If an allowlisted `mobile_error_callback_url` is present, terminal claim failures such as `expired` or `rejected` can redirect back into the app with Bud-owned error fields
- Otherwise auto-navigates to `/$budId` after successful approval/completion, but keeps the success UI and manual Bud link as a fallback if the user returns to the page or the redirect is interrupted
- Never displays `device_secret`; it only shows claim status and a Bud deep-link after approval

**Mobile UX**:
- Optimized for phone QR scans
- Renders immediate device summary/status without requiring the authenticated app shell
- Supports hosted-to-native app handoff without changing the underlying device-auth approval API

### `$budId.tsx`

**Route**: `/$budId`

Main bud layout with sidebar navigation.

**Loader**:
```typescript
loader: async ({ params }) => {
  const [buds, threads] = await Promise.all([
    apiFetchJson('/api/buds'),
    apiFetchJson(`/api/threads?bud_id=${params.budId}`),
  ])
  return { buds, bud, threads }
}
```

**Features**:
- Explicit loader-level auth redirect handling via `toLoginRedirect(...)`
- Fetches all buds and threads for current bud in parallel
- Converts API responses to UI types (`BudProfile`, `ThreadSummary`); rows pass through `withFallbackAccentColors` first, so a missing `accent_color` (older service) is assigned positionally by creation order — never by list index, since the list order follows `last_seen_at`
- Owns mutable thread-summary state so child routes can upsert canonical thread detail, apply streamed `thread.title` updates, optimistically patch thread model preferences, and remove deleted rows without waiting for a parent-loader refresh
- Applies bud accent color theming via CSS custom properties
- Owns the Bud settings modal state (`{ open, tab }`; `BudSettingsModal` with general/sessions/device tabs) and applies a saved row instantly via a `budOverrides` map merged over loader data, then `router.invalidate()` so the loader catches up (overrides clear on every reload)
- Routes the Bud rail account-settings button into `/settings`
- Terminal sessions are a tab of the Bud settings modal (Layers button opens it directly on that tab)
- Surfaces thread-panel delete success/failure as a visible shared mutation-status banner above the Bud outlet
- Renders `BudRail`, `ThreadPanel`, and child routes via `<Outlet />` wrapped in a Bud-route React context provider for thread-summary mutations

**State**:
- `budSettings` - `{ open, tab }` for the Bud settings modal
- `budOverrides` - `bud_id → ApiBud` rows saved from the modal, merged over `rawBuds`
- `threads` - Mutable thread summaries seeded from loader data
- `threadPanelStatus` - Shared delete-thread success/error banner state
- Derived: `activeThreadId` from child route match

**Navigation Handlers**:
| Handler | Action |
|---------|--------|
| `handleSelectBud(id)` | Navigate to `/$budId` |
| `handleSelectThread(threadId)` | Navigate to `/$budId/$threadId` or `/$budId` |
| `handleThreadDeleted()` | Navigate back to `/$budId` |
| `handleNavigateToThread(threadId)` | Navigate to specific thread |
| `handleOpenBudSettings(tab)` / `handleCloseBudSettings()` | Open the settings modal on a tab / close it |
| `handleBudUpdated(bud)` | Apply a saved bud row locally and invalidate the router |
| `upsertThreadSummary(thread)` | Merge canonical thread detail or stream-driven title updates into local Bud state |
| `patchThreadSummary(threadId, patch)` | Apply targeted local mutations such as model-preference changes to an existing summary |
| `removeThreadSummary(threadId)` | Remove a thread row immediately after delete |

**Theming**:
```typescript
useEffect(() => {
  document.documentElement.style.setProperty('--bud-accent-vibrant', palette.vibrant)
  document.documentElement.style.setProperty('--bud-accent-muted', palette.muted)
  document.documentElement.style.setProperty('--bud-accent-soft', palette.soft)
}, [palette])
```

## Subfolders

### `$budId/` → [budId.spec.md](./$budId/budId.spec.md)

Nested routes for thread views:
- `/$budId/` (index) - Redirect to most recent thread or `/new`
- `/$budId/new` - New thread creation view using shared `WorkspaceShell`, catalog-backed model/reasoning loading, initial thread preference persistence, and browser-generated UUIDv7 `client_id` on first send
- `/$budId/$threadId` - Existing thread conversation using the same shared shell plus `/messages` + `/agent/state` bootstrap, Bud environment status, context budget meter refresh, bounded-resume agent SSE, persisted selector changes, `client_id`-first message reconciliation, a user-clicked file viewer pane, and an owned proxied web-view pane

## Route Tree

```
/                    → index.tsx (auth-aware redirect to first bud)
/auth/mobile         → auth.mobile.tsx (hosted mobile OAuth login)
/auth/mobile/consent → auth.mobile.consent.tsx (hosted mobile OAuth consent)
/login               → login.tsx (OAuth entry)
/settings            → settings.tsx (profile, linked accounts, sign-out)
/devices/claim/$flowId → devices.claim.$flowId.tsx (public claim route with login resume)
/$budId              → $budId.tsx (bud layout)
  ├── /             → $budId/index.tsx (redirect to most recent thread or /new)
  ├── /new          → $budId/new.tsx (new thread creation)
  └── /$threadId    → $budId/$threadId.tsx (thread view)
```

**Auto-Selection Behavior**: When navigating to `/$budId/`, users are automatically redirected to either:
- The most recent thread (sorted by `last_activity_at`) if threads exist
- `/$budId/new` if no threads exist

This ensures users always land on meaningful content rather than an empty view.

## Generated Files

### `routeTree.gen.ts`

Auto-generated by TanStack Router plugin. Contains:
- Type-safe route tree
- Route path inference
- Parameter type definitions

**Note**: Do not edit manually in normal operation - regenerated on build. During Node-version mismatches in this repo, it may be temporarily updated in-place to match newly added routes until the router plugin can run again.

## Dependencies

| Import | Purpose |
|--------|---------|
| `@tanstack/react-router` | Routing primitives |
| `@/components/auth-page-shell` | Shared hosted auth chrome and social provider buttons |
| `@/components/workbench/*` | Layout components |
| `@/components/bud-settings-modal` | Bud settings modal (general / sessions / device tabs) |
| `@/contexts/*` | App context hooks |
| `@/lib/theme-colors` | Palette generation |
| `@/lib/transport` / `@/lib/auth-api` / `@/lib/api-types` / `@/lib/route-auth` | Split API/auth helpers |
| `@/lib/file-paths` | Conservative transcript file-reference parsing payloads |
| `@/lib/terminal-input` | Browser terminal key/paste translation and unsupported-input logging |
| `@/lib/oauth-provider` | Hosted mobile OAuth query parsing and authorize-resume helpers |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
# Existing-contact review integration

`automations.tsx` accepts validated `bp_` proposal links alongside activation IDs.
Its owner-keyed pending-review inventory includes both independent endpoints;
older servers returning 404 for existing-contact inventory preserve activation
review support. The shared review component selects the dedicated endpoint and
capability and displays Process reviewed contacts rather than activation.

## Automation deletion

The saved automation editor places Delete automation at the bottom, after delivery
history, with a named confirmation
explaining queued/active cancellation and retained history. The authenticated
owner-bound POST includes the observed version, shares mutation/unmount guards,
and returns to refreshed inventory only after success. Conflicts require reload;
uncertain deletion can be retried. Deleted detail links render historical delivery
and bootstrap activity with no editing/activation controls.


## Phases 15–16

Settings, Data sources, Contacts and Automations share SettingsNavigation and
restrained theme-aware controls. Automation inventory accepts `bud_id`,
`thread_id` and `state` search filters, applies them on the server before the
100-rule owner cap, and preserves them while selecting a rule. Context links
provide a return conversation. Older servers lacking `context_filter` show an
unavailable state instead of an incorrectly unfiltered list. See phase 15 for the
additive REST contract. No daemon, SSE or database schema change.

Automation model editors now default to Use conversation model / Use default
model, with explicit picker overrides. Origin is carried from authorized chat
context. List rows show active resolution and amber warnings; editing/review uses
the separate draft resolution. History shows the frozen invocation model/warning.
Changing unrelated settings preserves selection mode; changing Bud clears origin.

## Streaming presentation update — September 9, 2026

The existing thread route ignores empty assistant deltas for progress suppression
while still reconciling them into message state. Dispatching a new send can show
progress despite the prior invocation's terminal status. Existing owner-scoped
loader, stream authorization and reset/timer cleanup paths remain the boundary;
no new route, persistence or authorization behavior is introduced.

## Activity snapshot reconciliation

The thread route drives spinner suppression from service output activity, not
message start/done handlers. Working transitions can begin an automated live turn
without a local send. An activity revision invalidates snapshot/bootstrap fetches
started before a newer live transition or final, preventing older phase and
activity values from overwriting the stream. Existing thread ownership and SSE
authorization are unchanged. See [design](../../../design/assistant-output-activity.md).
