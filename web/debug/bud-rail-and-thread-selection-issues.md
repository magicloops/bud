# Bug: Bud Rail Status and Thread Selection Issues

## Problem Statement

Two issues with the current route-based implementation:

1. **Bud Rail Status Indicator**: When a bud goes offline, the green indicator in the sidebar (BudRail) stays green until page refresh. It should immediately show red/orange when the bud disconnects.

2. **Thread Selection Lost**: After refactoring to TanStack Router file-based routes, threads are no longer visually selected in the ThreadPanel. The `activeThreadId` is always `null` in the parent `$budId.tsx` layout.

---

## Issue 1: Bud Rail Status Not Updating in Real-Time

### Current Implementation

In `components/workbench/bud-rail.tsx` (lines 70-73):

```typescript
<span
  className="absolute bottom-2 right-2 h-3 w-3 rounded-full border border-black"
  style={{ backgroundColor: bud.status === 'online' ? '#16a34a' : '#f97316' }}
/>
```

The `bud.status` comes from the `BudProfile` prop, which is derived from loader data in `$budId.tsx`:

```typescript
// In $budId.tsx loader
const budsResp = await fetch('/api/buds')
const buds = (await budsResp.json()) as ApiBud[]
```

**The problem**: Loader data is fetched once at route load time. When a bud goes offline:
1. Service emits `terminal.bud_offline` event via SSE
2. Terminal overlay updates correctly (handled by `$threadId.tsx`)
3. But BudRail's `bud.status` is stale from the initial load

### Potential Fixes

#### Option A: Subscribe to Bud Status via SSE in Parent Layout

Add a dedicated SSE stream or use the existing terminal SSE to listen for bud status changes at the `$budId.tsx` level.

**Pros**: Real-time updates, consistent with terminal approach
**Cons**: Requires new SSE endpoint or event type, adds complexity

#### Option B: Poll for Bud Status Periodically

Add a useEffect that periodically fetches `/api/buds` to refresh status.

**Pros**: Simple to implement
**Cons**: Not real-time, adds load to service

#### Option C: Share Bud Status State via Context

Create a `BudStatusContext` that:
1. Holds current bud statuses
2. Is updated by terminal SSE events (`bud_online`/`bud_offline`)
3. Is consumed by BudRail

**Pros**: Single source of truth, leverages existing SSE
**Cons**: Requires context setup, child-to-parent state flow is awkward

#### Option D: Lift Bud Status Updates to Layout via Callback

Pass a callback from `$budId.tsx` to child that updates bud status when SSE events arrive.

```typescript
// In $budId.tsx
const [budStatuses, setBudStatuses] = useState<Record<string, string>>({})

// Pass to Outlet context
<Outlet context={{ onBudStatusChange: (budId, status) => setBudStatuses(prev => ({...prev, [budId]: status})) }} />
```

**Pros**: No new context needed
**Cons**: Requires outlet context wiring

### Recommended Fix

**Option C (Context)** is the cleanest approach. The `bud_online`/`bud_offline` events are already being received in `$threadId.tsx`. We can:

1. Create a `BudStatusContext` in a new file
2. Wrap the app in this context provider
3. Update the context from terminal SSE event handlers
4. Have BudRail consume the context for real-time status

---

## Issue 2: Thread Selection Not Visible

### Current Implementation

In `$budId.tsx` (lines 117-125):

```typescript
<ThreadPanel
  threads={threads}
  activeThreadId={null} // Will be overridden by child route  <-- BUG: Never overridden!
  onSelectThread={handleSelectThread}
  ...
/>
```

The comment says "Will be overridden by child route" but this never happens. The ThreadPanel is rendered in the parent layout (`$budId.tsx`) while the `threadId` param is only available in the child route (`$threadId.tsx`).

### Why This Happened

In TanStack Router's nested file-based routing:
- `$budId.tsx` renders the layout (BudRail + ThreadPanel + Outlet)
- `$threadId.tsx` is the child route rendered inside `<Outlet />`
- The parent cannot access child route params directly

### Potential Fixes

#### Option A: Access threadId in Parent via Route Matching

TanStack Router allows accessing child route params via `useMatches()`:

```typescript
// In $budId.tsx
import { useMatches } from '@tanstack/react-router'

function BudLayout() {
  const matches = useMatches()
  // Find the $threadId route match
  const threadMatch = matches.find(m => m.routeId === '/$budId/$threadId')
  const threadId = threadMatch?.params?.threadId ?? null

  return (
    <ThreadPanel
      activeThreadId={threadId}
      ...
    />
  )
}
```

**Pros**: Clean, uses router APIs correctly
**Cons**: Slightly fragile if route IDs change

#### Option B: Use Outlet Context to Pass threadId Up

Child route sets context that parent reads... but this doesn't work because parent renders before child.

**Not viable** - parent needs the value before child mounts.

#### Option C: Move ThreadPanel to Child Route

Render ThreadPanel inside `$threadId.tsx` and `$budId/index.tsx` instead of the parent layout.

**Cons**: Duplicates ThreadPanel across routes, loses layout benefits

#### Option D: Use URL Params Directly

The parent can parse the URL directly:

```typescript
const pathname = window.location.pathname
const match = pathname.match(/\/([^/]+)\/([^/]+)/)
const threadId = match?.[2] ?? null
```

**Cons**: Fragile, doesn't use router properly

### Recommended Fix

**Option A (useMatches)** is the correct approach. TanStack Router provides `useMatches()` specifically for this use case - accessing params/data from child routes.

```typescript
import { useMatches } from '@tanstack/react-router'

function BudLayout() {
  const matches = useMatches()

  // Get threadId from child route if it exists
  const activeThreadId = useMemo(() => {
    const threadMatch = matches.find(m =>
      m.routeId === '/$budId/$threadId' && m.params?.threadId
    )
    return (threadMatch?.params as { threadId?: string })?.threadId ?? null
  }, [matches])

  return (
    <ThreadPanel
      activeThreadId={activeThreadId}
      ...
    />
  )
}
```

---

## Implementation Plan

### Phase 1: Fix Thread Selection (Quick Win)

1. Import `useMatches` from `@tanstack/react-router` in `$budId.tsx`
2. Extract `threadId` from matched child routes
3. Pass to ThreadPanel

### Phase 2: Fix Bud Status Real-Time Updates

1. Create `contexts/bud-status-context.tsx`
   - Export `BudStatusProvider` and `useBudStatus` hook
   - Store `Record<string, 'online' | 'offline'>`

2. Wrap app in `BudStatusProvider` (in `__root.tsx` or `main.tsx`)

3. Update `$threadId.tsx` to call `useBudStatus().updateStatus(budId, status)` when:
   - `terminal.bud_offline` event received
   - `terminal.bud_online` event received

4. Update `bud-rail.tsx` to use context:
   ```typescript
   const { statuses } = useBudStatus()
   const status = statuses[bud.id] ?? bud.status  // Context overrides initial
   ```

---

## Summary

| Issue | Root Cause | Fix |
|-------|------------|-----|
| Bud status not updating | Loader data is stale, no real-time updates | Create BudStatusContext, update from SSE events |
| Thread not selected | Parent can't access child route params | Use `useMatches()` to get threadId from child |
