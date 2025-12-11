# Phase 8: Frontend Thread & Session UX Improvements

_Status: Planning_

## Overview

Implement a full-featured frontend UX for thread and session management, including:
- URL routing with TanStack Router (type-safe, first-class search params)
- Session state visibility in thread list
- Dev-only debug panel
- Thread deletion with session cleanup
- Clear "new thread" mode UX

---

## Current State Analysis

### State Management

All state lives in `App.tsx` via `useState` hooks:

```typescript
const [budId, setBudId] = useState<string | null>(null)
const [threadId, setThreadId] = useState<string | null>(null)
const [threads, setThreads] = useState<ThreadSummary[]>([])
```

**No URL routing** - state is ephemeral, lost on refresh.

### Thread Selection Flow

1. User selects a Bud → `fetchThreads(budId)` loads threads
2. Auto-selects first thread if any exist
3. "New" button sets `threadId` to `null`
4. New thread created **lazily** when first message is sent

### Terminal Connection Flow

When `threadId === null`: terminal disconnects, shows "idle"
When `threadId` is set: ensures session, connects SSE, fetches history

---

## Architecture

### URL Structure

```
/                           → Landing / redirect to first Bud
/:budId                     → Bud selected, "new thread" mode
/:budId/:threadId           → Bud + thread selected
```

### Route Parameters

| Param | Type | Description |
|-------|------|-------------|
| `budId` | `string` | Bud identifier (e.g., `b_01ABC...`) |
| `threadId` | `string` | Thread identifier (UUID) |

### Search Params (Future)

TanStack Router has first-class search param support. Future use cases:
- `?debug=1` - Show debug panel
- `?view=terminal` or `?view=chat` - View mode
- `?reasoning=high` - Reasoning effort preset

---

## Implementation Plan

### Step 1: Install TanStack Router

```bash
cd web
pnpm add @tanstack/react-router
pnpm add -D @tanstack/router-plugin @tanstack/react-router-devtools
```

### Step 2: Configure Vite

```typescript
// web/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

export default defineConfig({
  plugins: [
    // Must be before react plugin
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
  ],
  // ... existing config
})
```

### Step 3: Create Route Structure

```
web/src/routes/
├── __root.tsx              # Root layout (providers, shell)
├── index.tsx               # / → redirect to first Bud
├── $budId.tsx              # /:budId layout (loads Bud, threads)
├── $budId/
│   ├── index.tsx           # /:budId → "new thread" mode
│   └── $threadId.tsx       # /:budId/:threadId → thread view
```

### Step 4: Route Definitions

#### Root Route (`__root.tsx`)

```typescript
import { createRootRoute, Outlet } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { ThemeProvider } from '@/components/theme-provider'

export const Route = createRootRoute({
  component: () => (
    <ThemeProvider>
      <Outlet />
      {import.meta.env.DEV && <TanStackRouterDevtools position="bottom-right" />}
    </ThemeProvider>
  ),
})
```

#### Index Route (`index.tsx`)

```typescript
import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    // Fetch buds and redirect to first one
    const resp = await fetch('/api/buds')
    const buds = await resp.json()
    if (buds.length > 0) {
      throw redirect({ to: '/$budId', params: { budId: buds[0].bud_id } })
    }
    return {}
  },
  component: () => <div>No Buds available. Please enroll a Bud first.</div>,
})
```

#### Bud Route (`$budId.tsx`)

```typescript
import { createFileRoute, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/$budId')({
  // Load Bud profile and threads
  loader: async ({ params }) => {
    const [budResp, threadsResp] = await Promise.all([
      fetch(`/api/buds/${params.budId}`),
      fetch(`/api/threads?bud_id=${params.budId}`),
    ])

    if (!budResp.ok) throw new Error('Bud not found')

    const bud = await budResp.json()
    const threads = await threadsResp.json()

    return { bud, threads }
  },
  component: BudLayout,
})

function BudLayout() {
  const { bud, threads } = Route.useLoaderData()
  const { budId } = Route.useParams()

  return (
    <div className="flex h-screen">
      <BudRail activeBudId={budId} />
      <ThreadPanel threads={threads} budId={budId} />
      <Outlet /> {/* Thread content or "new thread" view */}
    </div>
  )
}
```

#### Thread Route (`$budId/$threadId.tsx`)

```typescript
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/$budId/$threadId')({
  loader: async ({ params }) => {
    const [threadResp, messagesResp] = await Promise.all([
      fetch(`/api/threads/${params.threadId}`),
      fetch(`/api/threads/${params.threadId}/messages?limit=200`),
    ])

    if (!threadResp.ok) throw new Error('Thread not found')

    const thread = await threadResp.json()
    const messages = await messagesResp.json()

    return { thread, messages }
  },
  component: ThreadView,
})

function ThreadView() {
  const { thread, messages } = Route.useLoaderData()
  const { budId, threadId } = Route.useParams()

  // Terminal connection effect uses threadId from route
  useTerminalConnection(threadId)

  return (
    <div className="flex-1 flex flex-col">
      <ChatTimeline messages={messages} />
      <CommandComposer threadId={threadId} budId={budId} />
      <TerminalPane threadId={threadId} />
    </div>
  )
}
```

### Step 5: Update Entry Point

```typescript
// web/src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import './index.css'

const router = createRouter({ routeTree })

// Type registration for full type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
```

### Step 6: Navigation Helpers

```typescript
// web/src/lib/navigation.ts
import { useNavigate } from '@tanstack/react-router'

export function useAppNavigation() {
  const navigate = useNavigate()

  return {
    goToBud: (budId: string) => {
      navigate({ to: '/$budId', params: { budId } })
    },
    goToThread: (budId: string, threadId: string) => {
      navigate({ to: '/$budId/$threadId', params: { budId, threadId } })
    },
    goToNewThread: (budId: string) => {
      navigate({ to: '/$budId', params: { budId } })
    },
  }
}
```

---

## Session State in Thread List

### Backend Changes

Extend `GET /api/threads?bud_id=xxx` to include session info:

```typescript
// service/src/routes/threads.ts

server.get("/api/threads", async (request, reply) => {
  const { bud_id } = request.query as { bud_id?: string }

  // Join threads with terminal_session to get session state
  const threads = await db
    .select({
      thread_id: threadTable.threadId,
      bud_id: threadTable.budId,
      title: threadTable.title,
      created_at: threadTable.createdAt,
      last_activity_at: threadTable.lastActivityAt,
      // Session info from join
      has_terminal_session: sql<boolean>`terminal_session.session_id IS NOT NULL`,
      session_state: terminalSessionTable.state,
      session_id: terminalSessionTable.sessionId,
    })
    .from(threadTable)
    .leftJoin(
      terminalSessionTable,
      eq(threadTable.threadId, terminalSessionTable.threadId)
    )
    .where(
      and(
        bud_id ? eq(threadTable.budId, bud_id) : undefined,
        isNull(threadTable.deletedAt)
      )
    )
    .orderBy(desc(threadTable.lastActivityAt))

  return threads
})
```

### Frontend Display

```typescript
// web/src/components/workbench/thread-panel.tsx

type ThreadSummary = {
  thread_id: string
  bud_id: string
  title: string | null
  created_at: string
  last_activity_at?: string | null
  // New session fields
  has_terminal_session: boolean
  session_state?: 'pending' | 'creating' | 'ready' | 'active' | 'idle' | 'closed' | null
  session_id?: string | null
}

function SessionIndicator({ thread }: { thread: ThreadSummary }) {
  if (!thread.has_terminal_session) return null

  const stateColors: Record<string, string> = {
    active: 'bg-green-500',
    ready: 'bg-blue-500',
    idle: 'bg-yellow-500',
    creating: 'bg-purple-500 animate-pulse',
    pending: 'bg-gray-400',
    closed: 'bg-gray-300',
  }

  const color = stateColors[thread.session_state ?? 'pending'] ?? 'bg-gray-400'

  return (
    <span
      className={`w-2 h-2 rounded-full ${color}`}
      title={`Session: ${thread.session_state ?? 'unknown'}`}
    />
  )
}

// In thread list item
<div className="flex items-center gap-2">
  <SessionIndicator thread={thread} />
  <span className="line-clamp-1">{thread.title ?? 'Untitled'}</span>
</div>
```

---

## Debug Panel (Dev Only)

### Component

```typescript
// web/src/components/debug-panel.tsx
import { useState } from 'react'
import { useParams } from '@tanstack/react-router'

export function DebugPanel({
  sessionId,
  terminalState,
  terminalConnection,
}: {
  sessionId: string | null
  terminalState: string
  terminalConnection: string
}) {
  const [expanded, setExpanded] = useState(false)
  const params = useParams({ strict: false })

  if (!import.meta.env.DEV) return null

  return (
    <div className="fixed bottom-4 left-4 z-50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="bg-black text-white text-xs px-2 py-1 rounded font-mono"
      >
        {expanded ? '▼ Debug' : '▶ Debug'}
      </button>

      {expanded && (
        <div className="mt-2 bg-black/90 text-green-400 text-xs p-3 rounded font-mono max-w-md">
          <div className="space-y-1">
            <div><span className="text-gray-400">budId:</span> {params.budId ?? 'null'}</div>
            <div><span className="text-gray-400">threadId:</span> {params.threadId ?? 'null'}</div>
            <div><span className="text-gray-400">sessionId:</span> {sessionId ?? 'null'}</div>
            <div><span className="text-gray-400">terminalState:</span> {terminalState}</div>
            <div><span className="text-gray-400">terminalConn:</span> {terminalConnection}</div>
          </div>

          <div className="mt-3 pt-2 border-t border-gray-700">
            <button
              onClick={() => navigator.clipboard.writeText(JSON.stringify({
                budId: params.budId,
                threadId: params.threadId,
                sessionId,
                terminalState,
                terminalConnection,
              }, null, 2))}
              className="text-blue-400 hover:underline"
            >
              Copy to clipboard
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

### Integration

```typescript
// In thread view component
{import.meta.env.DEV && (
  <DebugPanel
    sessionId={currentSessionIdRef.current}
    terminalState={terminalState}
    terminalConnection={terminalConnection}
  />
)}
```

---

## Thread Deletion

### UI Component

```typescript
// web/src/components/workbench/thread-panel.tsx
import { Trash2 } from 'lucide-react'
import { useAppNavigation } from '@/lib/navigation'

function ThreadItem({
  thread,
  isActive,
  budId,
  onDeleted,
}: {
  thread: ThreadSummary
  isActive: boolean
  budId: string
  onDeleted: (threadId: string) => void
}) {
  const { goToNewThread } = useAppNavigation()
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()

    const hasSession = thread.has_terminal_session && thread.session_state !== 'closed'
    const message = hasSession
      ? 'Delete this thread? The active terminal session will be closed.'
      : 'Delete this thread?'

    if (!confirm(message)) return

    setDeleting(true)
    try {
      const resp = await fetch(`/api/threads/${thread.thread_id}`, {
        method: 'DELETE'
      })

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to delete')
      }

      onDeleted(thread.thread_id)

      // If we deleted the active thread, go to "new thread" mode
      if (isActive) {
        goToNewThread(budId)
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete thread')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <button className="group w-full ...">
      {/* ... thread content ... */}

      <button
        onClick={handleDelete}
        disabled={deleting}
        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/20 rounded"
        title="Delete thread"
      >
        <Trash2 className={`h-4 w-4 ${deleting ? 'animate-pulse' : ''}`} />
      </button>
    </button>
  )
}
```

---

## "New Thread" Mode

### Visual Indicator

When at `/:budId` (no threadId), show a "new thread" state:

```typescript
// web/src/routes/$budId/index.tsx

export const Route = createFileRoute('/$budId/')({
  component: NewThreadView,
})

function NewThreadView() {
  const { budId } = Route.useParams()

  return (
    <div className="flex-1 flex flex-col">
      {/* Empty chat timeline with prompt */}
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-lg font-medium">Start a new conversation</p>
          <p className="text-sm mt-1">Send a message to create a thread</p>
        </div>
      </div>

      {/* Command composer - creates thread on first message */}
      <CommandComposer budId={budId} threadId={null} />

      {/* Terminal pane shows placeholder */}
      <TerminalPane threadId={null} />
    </div>
  )
}
```

### Terminal Placeholder

```typescript
// When threadId is null
const terminalOverlayMessage = useMemo(() => {
  if (!threadId) {
    return 'Terminal session will be created when you start a conversation.'
  }
  // ... existing logic
}, [threadId, ...])
```

---

## Implementation Checklist

### Setup
- [ ] Install TanStack Router packages
- [ ] Configure Vite plugin
- [ ] Add `.vscode/settings.json` for generated file handling
- [ ] Update `.eslintignore` / `.prettierignore` for `routeTree.gen.ts`

### Routes
- [ ] Create `__root.tsx` with providers
- [ ] Create `index.tsx` with redirect logic
- [ ] Create `$budId.tsx` layout route
- [ ] Create `$budId/index.tsx` for new thread mode
- [ ] Create `$budId/$threadId.tsx` for thread view
- [ ] Update `main.tsx` to use RouterProvider

### Components
- [ ] Extract terminal logic into `useTerminalConnection` hook
- [ ] Create `DebugPanel` component (dev only)
- [ ] Update `ThreadPanel` with session indicators
- [ ] Update `ThreadPanel` with delete functionality
- [ ] Create navigation helpers

### Backend
- [ ] Extend `GET /api/threads` to include session info (LEFT JOIN)
- [ ] Ensure `DELETE /api/threads/:threadId` works correctly

### Cleanup
- [ ] Remove state management from `App.tsx`
- [ ] Remove legacy `/api/terminals/:budId/stream` endpoint
- [ ] Update all navigation to use router

---

## Testing Scenarios

### Scenario A: URL Persistence
1. Navigate to `/:budId/:threadId`
2. Refresh page
3. Verify same thread is loaded
4. Verify terminal reconnects to same session

### Scenario B: New Thread Flow
1. Navigate to `/:budId` (new thread mode)
2. Verify terminal shows placeholder message
3. Send a message
4. Verify thread is created
5. Verify URL updates to `/:budId/:newThreadId`
6. Verify terminal session is created

### Scenario C: Thread Deletion
1. Create thread with active session
2. Click delete button
3. Verify confirmation mentions session closure
4. Confirm deletion
5. Verify session state changes to "closed"
6. Verify redirect to new thread mode
7. Verify thread removed from list

### Scenario D: Session Indicators
1. Create multiple threads
2. Verify session dots appear for threads with sessions
3. Verify correct colors for different states
4. Switch between threads
5. Verify indicators update correctly

### Scenario E: Debug Panel
1. Enable dev mode
2. Verify debug panel appears
3. Navigate between threads
4. Verify panel shows correct IDs
5. Test copy to clipboard

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `web/package.json` | Modify | Add TanStack Router deps |
| `web/vite.config.ts` | Modify | Add router plugin |
| `web/src/main.tsx` | Modify | Use RouterProvider |
| `web/src/routes/__root.tsx` | Create | Root layout |
| `web/src/routes/index.tsx` | Create | Landing redirect |
| `web/src/routes/$budId.tsx` | Create | Bud layout |
| `web/src/routes/$budId/index.tsx` | Create | New thread view |
| `web/src/routes/$budId/$threadId.tsx` | Create | Thread view |
| `web/src/lib/navigation.ts` | Create | Navigation helpers |
| `web/src/hooks/useTerminalConnection.ts` | Create | Terminal hook |
| `web/src/components/debug-panel.tsx` | Create | Debug panel |
| `web/src/components/workbench/thread-panel.tsx` | Modify | Session indicators, delete |
| `web/src/App.tsx` | Delete/Archive | Logic moves to routes |
| `service/src/routes/threads.ts` | Modify | Add session JOIN |
| `service/src/server.ts` | Modify | Remove legacy endpoint |

---

## Notes

- TanStack Router provides type-safe routing with first-class TypeScript support
- File-based routing auto-generates route tree (`routeTree.gen.ts`)
- Router devtools included in dev mode for debugging
- Search params can be added later for view preferences, debug flags, etc.
- Consider adding TanStack Query for data fetching (future enhancement)

## Sources

- [TanStack Router Documentation](https://tanstack.com/router/latest)
- [Manual Setup Guide](https://tanstack.com/router/latest/docs/framework/react/installation/manual)
