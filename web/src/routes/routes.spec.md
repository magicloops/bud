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
- Conditional router devtools via `VITE_ROUTER_DEVTOOLS=true`
- `<Outlet />` renders child routes
- Installs a branded root `errorComponent` so uncaught loader errors render a Bud-styled recovery page with a home action instead of TanStack Router's generic fallback

### `index.tsx`

**Route**: `/`

Authenticated root index with auto-redirect to first bud.

**Behavior**:
```typescript
beforeLoad: async () => {
  await fetchCurrentUser()
}

loader: async () => {
  const buds = await apiFetchJson('/api/buds')
  if (buds.length > 0) {
    throw redirect({ to: '/$budId', params: { budId: buds[0].bud_id } })
  }
}
```

**Fallback**: Shows an authenticated empty state if the signed-in user has no Buds.

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

### `settings.tsx`

**Route**: `/settings`

Authenticated account settings route.

**Features**:
- Loads through the same `/api/me` auth gating as the rest of the app shell
- Edits the Bud-owned `profile.username` via `PATCH /api/me/profile`
- Shows provider-backed avatar with initials fallback
- Shows linked-account state for GitHub and Google
- Starts explicit provider linking through Better Auth client actions
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
- Auth guard runs before child thread loaders
- Fetches all buds and threads for current bud in parallel
- Converts API responses to UI types (`BudProfile`, `ThreadSummary`)
- Owns mutable thread-summary state so child routes can upsert canonical thread detail, apply streamed `thread.title` updates, and remove deleted rows without waiting for a parent-loader refresh
- Applies bud accent color theming via CSS custom properties
- Manages sessions modal state
- Routes the Bud rail account-settings button into `/settings`
- Keeps terminal sessions as a separate modal action
- Renders `BudRail`, `ThreadPanel`, and child routes via `<Outlet />` wrapped in a Bud-route React context provider for thread-summary mutations

**State**:
- `sessionsModalOpen` - Modal visibility
- `threads` - Mutable thread summaries seeded from loader data
- Derived: `activeThreadId` from child route match

**Navigation Handlers**:
| Handler | Action |
|---------|--------|
| `handleSelectBud(id)` | Navigate to `/$budId` |
| `handleSelectThread(threadId)` | Navigate to `/$budId/$threadId` or `/$budId` |
| `handleThreadDeleted()` | Navigate back to `/$budId` |
| `handleNavigateToThread(threadId)` | Navigate to specific thread |
| `upsertThreadSummary(thread)` | Merge canonical thread detail or stream-driven title updates into local Bud state |
| `patchThreadSummary(threadId, patch)` | Apply targeted local mutations to an existing summary |
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
- `/$budId/new` - New thread creation view with browser-generated UUIDv7 `client_id` on first send
- `/$budId/$threadId` - Existing thread conversation with `/messages` + `/agent/state` bootstrap, bounded-resume agent SSE, and `client_id`-first message reconciliation

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
| `@/components/bud-sessions-modal` | Sessions management |
| `@/contexts/*` | App context hooks |
| `@/lib/theme-colors` | Palette generation |
| `@/lib/api` | API types and utilities |
| `@/lib/oauth-provider` | Hosted mobile OAuth query parsing and authorize-resume helpers |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
