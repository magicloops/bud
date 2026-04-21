# contexts

React context providers for global application state.

## Purpose

Provides shared state across the component tree without prop drilling:
- Authenticated browser user/session state
- Bud online/offline status
- Layout preferences (thread panel visibility)

## Files

### `bud-route-context.tsx`

Route-scoped shared state for the `/$budId` workbench layout.

**Context Value**:
```typescript
{
  threads: ThreadSummary[]
  upsertThreadSummary: (thread) => void
  patchThreadSummary: (threadId, patch) => void
  removeThreadSummary: (threadId) => void
}
```

**Exports**:
- `BudRouteContext` - Raw React context used by the Bud route provider
- `useBudRouteContext()` - Consumer hook for nested thread routes

**Usage**:
- `/$budId.tsx` provides the mutable thread-summary state
- `/$budId/$threadId.tsx` consumes it to merge canonical thread detail and streamed `thread.title` updates into the thread list and top bar

### `auth-session-context.tsx`

Authenticated browser-session context object and consumer hook.

**Exports**:
- `AuthSessionContext`
- `useAuthSession()`
- `AuthSessionContextValue` type

### `auth-session-provider.tsx`

Authenticated browser-session provider seeded from the root route loader.

**Context Value**:
```typescript
{
  currentUser: ApiCurrentUser | null
  isAuthenticated: boolean
  setCurrentUser: (user: ApiCurrentUser | null) => void
}
```

**Provider**: `AuthSessionProvider`

**Hook**: `useAuthSession()`

**Behavior**:
- Receives `initialCurrentUser` from `__root.tsx`
- Keeps the app shell aware of the current authenticated user
- Powers the authenticated empty-state and login-route bounce behavior

### `bud-status-context.tsx`

Bud-status context object and consumer hook.

**Exports**:
- `BudStatusContext`
- `useBudStatus()`
- `BudStatus` / `BudStatusContextValue` types

### `bud-status-provider.tsx`

Real-time bud online/offline status tracking.

**Type**: `BudStatus = 'online' | 'offline'`

**Context Value**:
```typescript
{
  statuses: Record<string, BudStatus>  // budId → status
  updateStatus: (budId: string, status: BudStatus) => void
}
```

**Provider**: `BudStatusProvider`

**Hook**: `useBudStatus()`

**Usage**:
```typescript
// In component receiving SSE events
const { updateStatus } = useBudStatus()
updateStatus(budId, 'online')

// In BudRail displaying status
const { statuses } = useBudStatus()
const isOnline = statuses[bud.id] === 'online'
```

### `layout-context.tsx`

Layout context object and consumer hook.

**Exports**:
- `LayoutContext`
- `useLayout()`
- `LayoutContextValue` type

### `layout-provider.tsx`

Layout UI preferences with persistence.

**Context Value**:
```typescript
{
  threadPanelOpen: boolean
  setThreadPanelOpen: (open: boolean) => void
  toggleThreadPanel: () => void
}
```

**Provider**: `LayoutProvider`

**Hook**: `useLayout()`

**Persistence**: Saves to `localStorage.threadPanelOpen`

**Default**: `true` (panel open)

**Usage**:
```typescript
// In WorkspaceTopBar
const { toggleThreadPanel } = useLayout()
<Button onClick={toggleThreadPanel}>Menu</Button>

// In BudLayout
const { threadPanelOpen } = useLayout()
{threadPanelOpen && <ThreadPanel ... />}
```

## Provider Tree

Contexts are wrapped at the app root:
```tsx
<ThemeProvider>
  <AuthSessionProvider>
    <LayoutProvider>
      <BudStatusProvider>
        <RouterProvider />
      </BudStatusProvider>
    </LayoutProvider>
  </AuthSessionProvider>
</ThemeProvider>
```

## Dependencies

| Import | Purpose |
|--------|---------|
| `react` | Context API |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
