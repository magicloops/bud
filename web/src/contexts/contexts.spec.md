# contexts

React context providers for global application state.

## Purpose

Provides shared state across the component tree without prop drilling:
- Bud online/offline status
- Layout preferences (thread panel visibility)

## Files

### `bud-status-context.tsx`

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
  <BudStatusProvider>
    <LayoutProvider>
      <RouterProvider />
    </LayoutProvider>
  </BudStatusProvider>
</ThemeProvider>
```

## Dependencies

| Import | Purpose |
|--------|---------|
| `react` | Context API |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
