# Plan: Auto-Select Most Recent Thread on Bud Load

## Context

- Related spec files:
  - `web/src/routes/routes.spec.md`
  - `web/src/components/workbench/workbench.spec.md`

## Problem Statement

When a user first loads the application or clicks on a Bud in the rail, they land on `/$budId/` which shows an empty "new thread" view. This requires an extra click to select a thread, even when threads exist.

**Current behavior:**
1. User clicks Bud in BudRail
2. Navigation to `/$budId/`
3. BudLayout renders with `activeThreadId = null`
4. User sees empty NewThreadView
5. User must manually click a thread to view it

**Desired behavior:**
1. User clicks Bud in BudRail
2. Navigation to `/$budId/`
3. Auto-redirect to `/$budId/$threadId` (most recent thread)
4. User immediately sees their most recent conversation
5. "New" button explicitly navigates to `/$budId/new`

## Architecture Analysis

### Current Flow

```
BudRail.onSelectBud(budId)
    ↓
navigate({ to: '/$budId', params: { budId } })
    ↓
$budId.tsx loader
  • fetch /api/threads?bud_id={budId}
    ↓
BudLayout renders
  • activeThreadId = null (derived from URL)
  • threads[] available from loader
    ↓
<Outlet /> → /$budId/index.tsx (NewThreadView)
```

### Key Code Locations

| File | Lines | Purpose |
|------|-------|---------|
| `web/src/routes/$budId.tsx` | 10-27 | Route loader fetches threads |
| `web/src/routes/$budId.tsx` | 41-46 | `activeThreadId` derived from URL |
| `web/src/routes/$budId.tsx` | 64-79 | Threads converted to `ThreadSummary[]` |
| `web/src/routes/$budId.tsx` | 106-112 | `handleSelectThread` navigation |
| `web/src/components/workbench/thread-panel.tsx` | 88-96 | Thread sorting logic |

### Thread Sorting (from ThreadPanel)

```typescript
const orderedThreads = useMemo(
  () =>
    [...threads].sort((a, b) => {
      const aTs = new Date(a.last_activity_at ?? a.created_at).getTime()
      const bTs = new Date(b.last_activity_at ?? b.created_at).getTime()
      return bTs - aTs  // Newest first
    }),
  [threads]
)
```

## Implementation Approach

### Rejected: useEffect with Intent Flag

The initial approach was to add a `useEffect` that auto-redirects, with a search param/state flag to indicate "intentional new thread" when the "New" button is clicked.

**Why rejected:**
- Implicit state management through URL flags
- Every navigation to `/$budId/` needs to know about the flag
- Easy to forget and break
- Logic becomes "auto-select unless magic flag" - a code smell
- Technical debt that accumulates over time

### Recommended: Explicit `/$budId/new` Route

Create a dedicated route for new thread creation, making the URL structure self-documenting:

```
/$budId/          → Redirect only (to most recent thread OR /new if none exist)
/$budId/new       → NewThreadView - stable, bookmarkable URL
/$budId/$threadId → ThreadView - stable, bookmarkable URL
```

**Key behavior of `/new`:**
- Stable URL - does NOT auto-redirect anywhere
- Shows "compose new thread" UI
- Thread is only created when user submits their first message
- After message submit → POST creates thread → navigate to `/$budId/$threadId`
- Can be bookmarked, shared, refreshed

**Why this is cleaner:**

| Aspect | Intent Flag Approach | Explicit `/new` Route |
|--------|---------------------|----------------------|
| Route responsibility | Mixed (redirect + UI) | Single (redirect OR UI) |
| "New" button logic | `navigate({ search: { new: true } })` | `navigate({ to: '/new' })` |
| URL semantics | `/$budId/?new=true` (implicit) | `/$budId/new` (explicit) |
| Breaking changes | Easy to forget flag | Hard to break |
| New developer understanding | "Why this flag?" | Self-documenting |

**Route specificity:** TanStack Router matches static segments (`/new`) before dynamic segments (`/$threadId`), so there's no conflict.

### Current vs Proposed File Structure

```
CURRENT:                          PROPOSED:
$budId/                           $budId/
├── index.tsx  # NewThreadView    ├── index.tsx  # Redirect only
└── $threadId.tsx # ThreadView    ├── new.tsx    # NewThreadView
                                  └── $threadId.tsx # ThreadView
```

**Each file has exactly one responsibility:**
- `index.tsx` → Compute most recent thread, redirect
- `new.tsx` → Render new thread UI
- `$threadId.tsx` → Render existing thread UI

## Implementation Details

### Step 1: Create `web/src/routes/$budId/new.tsx`

Move the current NewThreadView from `index.tsx` to a new `new.tsx` file:

```typescript
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/$budId/new')({
  component: NewThreadView,
})

function NewThreadView() {
  // ... existing NewThreadView code from index.tsx
}
```

### Step 2: Update `web/src/routes/$budId/index.tsx`

Convert to a redirect-only component:

```typescript
import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/$budId/')({
  loader: async ({ params }) => {
    // Fetch threads for this bud
    const resp = await fetch(`/api/threads?bud_id=${params.budId}`)

    // On error, throw - let error boundary handle it
    // Don't mask errors by redirecting to /new
    if (!resp.ok) {
      throw new Error('Failed to load threads')
    }

    const threads = await resp.json()

    // No threads - redirect to new thread view
    if (threads.length === 0) {
      throw redirect({ to: '/$budId/new', params: { budId: params.budId } })
    }

    // Find most recent thread (by last_activity_at, fallback to created_at)
    const mostRecent = threads.reduce((prev, curr) => {
      const prevTs = new Date(prev.last_activity_at ?? prev.created_at).getTime()
      const currTs = new Date(curr.last_activity_at ?? curr.created_at).getTime()
      return currTs > prevTs ? curr : prev
    })

    // Redirect to most recent thread
    throw redirect({
      to: '/$budId/$threadId',
      params: { budId: params.budId, threadId: mostRecent.thread_id }
    })
  },
  component: () => null, // Never renders - always redirects
})
```

**Key behaviors:**
- API error → throws, error boundary displays message (doesn't mask errors)
- No threads → redirects to `/new`
- Has threads → redirects to most recent
- Redirect happens in loader, before any render (no flash)

### Step 3: Update ThreadPanel "New" Button

In `web/src/components/workbench/thread-panel.tsx`:

```typescript
// Before
<button onClick={() => onSelectThread(null)}>New</button>

// After
<button onClick={() => navigate({ to: '/$budId/new', params: { budId } })}>New</button>
```

Or update the `onSelectThread(null)` handler in the parent to navigate to `/new`.

### Step 4: Update `handleSelectThread` in `$budId.tsx`

```typescript
const handleSelectThread = useCallback((threadId: string | null) => {
  if (threadId) {
    navigate({ to: '/$budId/$threadId', params: { budId, threadId } })
  } else {
    navigate({ to: '/$budId/new', params: { budId } })  // Changed from /$budId
  }
}, [navigate, budId])
```

### Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| No threads exist | `/$budId/` redirects to `/$budId/new` |
| User clicks "New" button | Navigates directly to `/$budId/new` |
| User clicks existing thread | Navigates to `/$budId/$threadId` |
| Direct URL to `/$budId/` | Redirects to most recent thread (or `/new`) |
| Direct URL to `/$budId/new` | Shows NewThreadView |
| Direct URL to `/$budId/$threadId` | Shows ThreadView |
| Bud changes | `/$budId/` redirects to new bud's most recent |

### Data Flow Consideration

The current `$budId.tsx` loader fetches threads for the parent layout. With the new `index.tsx` also needing threads for redirect logic, we have two options:

**Option A: Duplicate fetch in index.tsx (simple)**
- index.tsx fetches threads independently for redirect decision
- Slightly redundant but isolated and simple

**Option B: Use parent loader data (optimized)**
- index.tsx accesses threads from parent route's loader
- TanStack Router supports this via `routeContext` or `useRouteLoaderData`
- More complex but avoids duplicate fetch

**Recommendation:** Start with Option A for simplicity. The threads fetch is fast and cached. Optimize later if needed.

## Test Plan

### Manual Testing

1. **Navigate to `/$budId/` with threads**: Should redirect to most recent thread
2. **Navigate to `/$budId/` without threads**: Should redirect to `/$budId/new`
3. **Click "New" button**: Should navigate to `/$budId/new`, show NewThreadView
4. **Click thread in list**: Should navigate to `/$budId/$threadId`
5. **Direct URL to `/$budId/new`**: Should show NewThreadView
6. **Direct URL to `/$budId/$threadId`**: Should show ThreadView
7. **Switch buds**: Should redirect to new bud's most recent thread
8. **Browser back/forward**: History should be clean

### Edge Cases to Verify

- Bud with 0 threads → redirects to `/new`
- Bud with 1 thread → redirects to that thread
- Bud with many threads → redirects to most recent
- Thread with `last_activity_at = null` → uses `created_at` as fallback
- Rapid bud switching → no race conditions
- Create new thread → after submit, navigates to new thread ID

## Spec Files to Update

After implementation:

| Spec File | Updates |
|-----------|---------|
| `web/src/routes/routes.spec.md` | Add `/new` route, document auto-selection |
| `web/src/routes/$budId/budId.spec.md` | Add `new.tsx` file description |

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Route conflict `/new` vs `/$threadId` | TanStack Router matches static before dynamic - add test to verify |
| Duplicate thread fetch | Acceptable for simplicity (~25 lines vs complex context sharing) |
| Flash during redirect | Using loader `redirect` - happens before render |
| User bookmarks `/$budId/` | Works correctly - redirects to most recent thread |
| API error masked | Throw error on fetch failure, don't redirect to `/new` |

## Simplicity Analysis

| Metric | Value |
|--------|-------|
| New files | 1 (`new.tsx`) |
| New lines of code | ~25 (redirect logic in `index.tsx`) |
| Moved code | NewThreadView moves from `index.tsx` to `new.tsx` (no logic change) |
| Changed lines | ~3 (update `handleSelectThread` to use `/new`) |
| useEffect usage | None (redirect in loader) |
| Implicit state | None (URLs are self-documenting) |

## Preventing Divergence Between `/new` and `/$threadId`

### The Risk

Both `new.tsx` and `$threadId.tsx` render similar workspaces (chat panel, terminal area, command composer). If they diverge over time, bugs could appear in one but not the other.

### Already Shared (Low Risk)

These components are already extracted and shared:
- `CommandComposer` - message input
- `ChatTimeline` - message display
- `WorkspaceTopBar` - top bar

Changes to these automatically apply to both routes.

### Legitimately Different (Acceptable)

These aspects are intentionally different:
- **Terminal**: `/$threadId` has real terminal with SSE; `/new` has placeholder
- **State**: `/$threadId` loads existing messages; `/new` starts empty
- **Submit**: `/$threadId` adds message; `/new` creates thread then navigates

### Safeguards: Bidirectional Comments

**IMPORTANT:** Both route files MUST have comments pointing to each other. These comments are critical for maintainability and MUST NOT be removed.

In `new.tsx`:
```typescript
/**
 * New Thread View - workspace for composing a new thread
 *
 * RELATED FILE: See $threadId.tsx for the existing thread workspace.
 * These two routes share similar layout structure and components.
 * When modifying layout or shared behavior, check BOTH files.
 *
 * DO NOT REMOVE THIS COMMENT - it prevents accidental divergence.
 */
```

In `$threadId.tsx`:
```typescript
/**
 * Thread View - workspace for an existing thread
 *
 * RELATED FILE: See new.tsx for the new thread workspace.
 * These two routes share similar layout structure and components.
 * When modifying layout or shared behavior, check BOTH files.
 *
 * DO NOT REMOVE THIS COMMENT - it prevents accidental divergence.
 */
```

### Why Not Unify Into One Component?

We considered extracting a unified `ThreadWorkspace` component that handles both modes. This was rejected because:

1. `$threadId.tsx` is ~1000 lines with complex terminal/SSE logic
2. Adding `isNewThread` conditionals throughout would increase complexity
3. The routes serve legitimately different purposes
4. Shared UI components are already extracted

### Future Consideration

If we find ourselves making the same change in both files repeatedly, we should extract the common parts into a shared component. Until then, the bidirectional comments provide sufficient safeguard.

## Implementation Checklist

- [x] Create `web/src/routes/$budId/new.tsx` with NewThreadView
- [x] Add bidirectional comment to `new.tsx` pointing to `$threadId.tsx`
- [x] Add bidirectional comment to `$threadId.tsx` pointing to `new.tsx`
- [x] Update `web/src/routes/$budId/index.tsx` to redirect-only
- [x] Update `handleSelectThread(null)` in `$budId.tsx` to navigate to `/new`
- [x] Verify TanStack Router route generation (static `/new` matches before dynamic `/$threadId`)
- [x] Test all edge cases (build passes, route tree verified)
- [x] Update spec files (`routes.spec.md`, `budId.spec.md`)

## Alternative Approaches Considered

### 1. Intent Flag in URL/State (Rejected)

```typescript
navigate({ to: '/$budId', search: { new: true } })
```

**Rejected because:**
- Implicit state, easy to forget
- Every navigation needs to know about the flag
- Technical debt

### 2. Eager Thread Creation (Rejected)

Create thread on "New" click, navigate to thread ID.

**Rejected because:**
- Creates abandoned empty threads
- Requires cleanup job
- More API calls
- Loses "compose before committing" UX

### 3. useEffect Auto-Redirect (Considered)

```typescript
useEffect(() => {
  if (!activeThreadId && mostRecentThread) {
    navigate({ to: '/$budId/$threadId', replace: true })
  }
}, [...])
```

**Not chosen because:**
- Brief flash of NewThreadView before redirect
- Mixed responsibility (UI + redirect in same component)
- Loader redirect is cleaner

---

*Created: 2025-12-13*
*Updated: 2025-12-13* - Refined to use explicit `/new` route instead of intent flags
*Updated: 2025-12-14* - Implementation complete
*Status: Implemented*
