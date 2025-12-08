# Implementation Plan: Thread-Scoped Terminal Sessions

_Created: 2025-12-07_

## Overview

Transform the terminal system from **Bud-scoped** (one shared terminal per Bud) to **thread-scoped** (each chat thread owns its own terminal session). This enables:

1. Independent terminal sessions per conversation
2. Session isolation between threads
3. Session inventory and management
4. **Future: Each thread assigned to a dedicated VM instance**

**Related docs**:
- `plan/unified-session-terminal.md` - Original thread-scoped design
- `plan/persistent-terminal.md` - Current Bud-scoped implementation
- `PR_READINESS.md` - Current state assessment

---

## Key Concepts

### Terminology

| Term | Definition | Example |
|------|------------|---------|
| **Bud Identity** | Logical entity representing a configured agent with repos, settings, context | "My Dev Bud" |
| **Bud Instance** | Physical process running on a machine (local daemon or VM) | `bud_inst_01HXY...` |
| **Terminal Session** | A tmux session owned by a thread, running on a specific instance | `sess_01ABC...` |

### Core Principle: 1 Thread = 1 Session

Each thread has exactly **one** terminal session. The agent always interacts with a single session per conversation. This keeps the model simple and predictable.

The **instance assignment** is the variable:
- **Open source / dev mode**: Multiple threads share one Bud instance
- **Future cloud mode**: Each thread gets a dedicated VM instance

---

## Architecture Evolution

### Current: Single Instance, Single Shared Session

All threads share one terminal - no isolation.

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Thread A  │────▶│                  │────▶│   tmux      │
├─────────────┤     │  Single Bud      │     │  (shared)   │
│   Thread B  │────▶│  Instance        │────▶│             │
└─────────────┘     └──────────────────┘     └─────────────┘
```

### Phase 2 (This Plan): Single Instance, One Session per Thread

Multiple threads on same instance, but each has its own isolated session.

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Thread A  │────▶│                  │────▶│ tmux sess_A │
├─────────────┤     │  Single Bud      │     ├─────────────┤
│   Thread B  │────▶│  Instance        │────▶│ tmux sess_B │
├─────────────┤     │  (shared)        │     ├─────────────┤
│   Thread C  │────▶│                  │────▶│ tmux sess_C │
└─────────────┘     └──────────────────┘     └─────────────┘
```

### Phase 3 (Future): Dedicated Instance per Thread

Each thread gets its own VM with one session.

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Thread A  │────▶│  VM Instance A   │────▶│ tmux sess_A │
└─────────────┘     └──────────────────┘     └─────────────┘
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Thread B  │────▶│  VM Instance B   │────▶│ tmux sess_B │
└─────────────┘     └──────────────────┘     └─────────────┘
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Thread C  │────▶│  VM Instance C   │────▶│ tmux sess_C │
└─────────────┘     └──────────────────┘     └─────────────┘
```

---

## Data Model

### New Table: `terminal_session`

Create a dedicated table for terminal sessions:

```sql
-- Migration: 0006_terminal_sessions.sql

CREATE TABLE terminal_session (
  -- Identity
  session_id TEXT PRIMARY KEY,  -- e.g., "sess_01HXYZ..."
  thread_id UUID UNIQUE REFERENCES thread(thread_id) ON DELETE SET NULL,  -- 1:1 with thread

  -- Assignment
  bud_id TEXT NOT NULL REFERENCES bud(bud_id) ON DELETE CASCADE,
  instance_id TEXT,  -- NULL = default instance; future: specific VM

  -- tmux details
  tmux_session_name TEXT,  -- e.g., "s_01HXYZ" (derived from session_id)

  -- State
  state TEXT NOT NULL DEFAULT 'pending',  -- pending, creating, ready, active, idle, closed

  -- Config
  shell TEXT,
  cwd TEXT,
  cols INTEGER NOT NULL DEFAULT 200,
  rows INTEGER NOT NULL DEFAULT 50,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  last_input_at TIMESTAMPTZ,
  last_output_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,

  -- Stats
  total_input_bytes BIGINT NOT NULL DEFAULT 0,
  total_output_bytes BIGINT NOT NULL DEFAULT 0,
  output_log_bytes BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX terminal_session_bud_idx ON terminal_session(bud_id, state);
CREATE INDEX terminal_session_instance_idx ON terminal_session(instance_id) WHERE instance_id IS NOT NULL;

-- Output storage keyed by session
CREATE TABLE terminal_session_output (
  session_id TEXT NOT NULL REFERENCES terminal_session(session_id) ON DELETE CASCADE,
  byte_offset BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, byte_offset)
);

CREATE INDEX terminal_session_output_seq_idx ON terminal_session_output(session_id, seq);

-- Input log keyed by session
CREATE TABLE terminal_session_input_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES terminal_session(session_id) ON DELETE CASCADE,
  data BYTEA NOT NULL,
  source TEXT NOT NULL,  -- 'agent', 'user', 'system'
  run_id TEXT,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX terminal_session_input_log_idx ON terminal_session_input_log(session_id, created_at);
```

**Key design decisions:**
- `thread_id` is `UNIQUE` - enforces 1:1 relationship
- New tables (not modifying `bud_terminal`) - clean break, no migration complexity
- `instance_id` ready for future VM assignment

### Schema (TypeScript)

```typescript
// service/src/db/schema.ts

export const terminalSessionTable = pgTable(
  "terminal_session",
  {
    sessionId: text("session_id").primaryKey(),
    threadId: uuid("thread_id")
      .unique()  // 1:1 with thread
      .references(() => threadTable.threadId, { onDelete: "set null" }),

    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    instanceId: text("instance_id"),  // NULL = default instance

    tmuxSessionName: text("tmux_session_name"),
    state: text("state").notNull().default("pending"),

    shell: text("shell"),
    cwd: text("cwd"),
    cols: integer("cols").notNull().default(200),
    rows: integer("rows").notNull().default(50),

    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    lastInputAt: timestamp("last_input_at", { withTimezone: true }),
    lastOutputAt: timestamp("last_output_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    totalInputBytes: bigint("total_input_bytes", { mode: "number" }).notNull().default(0),
    totalOutputBytes: bigint("total_output_bytes", { mode: "number" }).notNull().default(0),
    outputLogBytes: bigint("output_log_bytes", { mode: "number" }).notNull().default(0),
  },
  (table) => ({
    budIdx: index("terminal_session_bud_idx").on(table.budId, table.state),
    instanceIdx: index("terminal_session_instance_idx").on(table.instanceId),
  })
);
```

---

## Protocol Changes

### `terminal_ensure` Frame

Add `session_id` to specify which session to create/attach:

```typescript
interface TerminalEnsureMessage extends TerminalEnvelope {
  type: "terminal_ensure";
  session_id: string;  // Required: e.g., "sess_01HXYZ..."
  config?: {
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  };
}
```

### `terminal_status` Response

Include session info and resumed flag:

```typescript
interface TerminalStatusMessage extends TerminalEnvelope {
  type: "terminal_status";
  session_id: string;
  state: TerminalState;
  resumed: boolean;  // true if reattached to existing tmux session
  info?: {
    tmux_session?: string;
    pid?: number;
    cwd?: string;
    cols?: number;
    rows?: number;
  };
}
```

### All Terminal Frames Include session_id

```typescript
interface TerminalInputMessage extends TerminalEnvelope {
  type: "terminal_input";
  session_id: string;
  data: string;
  await_ready: { ... };
}

interface TerminalOutputMessage extends TerminalEnvelope {
  type: "terminal_output";
  session_id: string;
  seq: number;
  data: string;
  byte_offset: number;
}

interface TerminalReadyMessage extends TerminalEnvelope {
  type: "terminal_ready";
  session_id: string;
  assessment: ReadinessAssessment;
  // ...
}
```

---

## Bud Changes

### Multi-Session Terminal Manager

```rust
// Current: single session
struct TerminalState {
    sender: Option<OutboundSender>,
    handle: Option<Arc<TerminalHandle>>,
}

// New: multiple sessions (one per thread assigned to this instance)
struct TerminalState {
    sender: Option<OutboundSender>,
    sessions: HashMap<String, Arc<TerminalHandle>>,  // session_id -> handle
}
```

### Session Naming

tmux session name derived deterministically from session_id:

```rust
fn tmux_session_name(session_id: &str) -> String {
    // Use session_id directly, truncate for tmux limits (256 chars, but keep short)
    let name = session_id.replace("sess_", "s_");
    if name.len() > 32 {
        name[..32].to_string()
    } else {
        name
    }
}
```

### Per-Session Log Paths

```rust
fn session_log_path(base_dir: &Path, session_id: &str) -> PathBuf {
    // ~/.bud/sessions/{session_id}/terminal.log
    base_dir.join("sessions").join(session_id).join("terminal.log")
}
```

### Handle `terminal_ensure` with Session ID

```rust
async fn handle_terminal_ensure(&self, frame: TerminalEnsureFrame) -> Result<()> {
    let session_id = frame.session_id;

    let mut state = self.inner.lock().await;

    // Check if we already have this session in memory
    if let Some(handle) = state.sessions.get(&session_id) {
        // Already tracking, just send current status
        self.send_status_for_session(&session_id, handle, false).await?;
        return Ok(());
    }

    // Create or reattach tmux session
    let tmux_name = tmux_session_name(&session_id);
    let log_path = session_log_path(&self.config.log_dir, &session_id);

    let session_exists = check_tmux_session(&tmux_name).await;
    let resumed = session_exists;

    if !session_exists {
        create_tmux_session(&tmux_name, &frame.config).await?;
    }

    // Set up pipe-pane for output capture
    setup_pipe_pane(&tmux_name, &log_path).await?;

    // Create handle and start output watcher
    let handle = Arc::new(TerminalHandle::new(
        session_id.clone(),
        tmux_name,
        log_path,
        // ...
    ));

    state.sessions.insert(session_id.clone(), handle.clone());

    // Send status with resumed flag
    self.send_status_for_session(&session_id, &handle, resumed).await?;

    Ok(())
}
```

### Route All Terminal Frames by session_id

```rust
// terminal_input
async fn handle_input(&self, frame: TerminalInputFrame) -> Result<()> {
    let state = self.inner.lock().await;
    let handle = state.sessions.get(&frame.session_id)
        .ok_or_else(|| anyhow!("session not found: {}", frame.session_id))?;
    // ... send to tmux session
}

// terminal_resize, terminal_interrupt, etc. - same pattern
```

---

## Service Changes

### New: TerminalSessionManager

```typescript
// service/src/runtime/terminal-session-manager.ts

export class TerminalSessionManager {
  private readonly events: TerminalEventBus;
  private readonly gateway: WsGateway;
  private readonly readiness = new Map<string, { assessment; updatedAt }>();
  private readonly lastOffsets = new Map<string, number>();

  // Session lifecycle
  async createSessionForThread(threadId: string, budId: string): Promise<string>;
  async ensureSession(sessionId: string): Promise<{ ok: boolean; resumed: boolean; error?: string }>;
  async closeSession(sessionId: string): Promise<void>;

  // Session lookup
  async getSessionForThread(threadId: string): Promise<TerminalSession | null>;
  async listSessionsForBud(budId: string): Promise<TerminalSession[]>;

  // Terminal operations
  async sendInput(sessionId: string, data: Buffer, options?: { source?: string }): Promise<{ ok: boolean }>;
  async sendInterrupt(sessionId: string): Promise<{ ok: boolean }>;
  async sendResize(sessionId: string, cols: number, rows: number): Promise<{ ok: boolean }>;
  async waitForReadiness(sessionId: string, timeoutMs?: number): Promise<ReadinessAssessment | null>;
  async tailOutput(sessionId: string, maxBytes: number): Promise<{ data: Buffer; totalBytes: number }>;

  // Event handlers (from Bud via gateway)
  handleTerminalStatus(budId: string, sessionId: string, payload: TerminalStatusMessage): void;
  handleTerminalOutput(budId: string, sessionId: string, payload: TerminalOutputMessage): void;
  handleTerminalReady(budId: string, sessionId: string, payload: TerminalReadyMessage): void;
}
```

### Session Creation Flow

```typescript
async createSessionForThread(threadId: string, budId: string): Promise<string> {
  // Check if thread already has a session
  const existing = await db.query.terminalSessionTable.findFirst({
    where: eq(terminalSessionTable.threadId, threadId),
  });
  if (existing) {
    return existing.sessionId;
  }

  const sessionId = `sess_${ulid()}`;
  const tmuxSessionName = this.tmuxSessionName(sessionId);

  await db.insert(terminalSessionTable).values({
    sessionId,
    threadId,
    budId,
    instanceId: null,  // Default instance (future: assign from pool)
    tmuxSessionName,
    state: "pending",
  });

  return sessionId;
}
```

### Agent Service Integration

```typescript
// service/src/agent/agent-service.ts

private async executeTerminalCall(threadId: string, directive: ...): Promise<...> {
  // Get or create session for this thread (1:1 relationship)
  let session = await this.terminalSessionManager.getSessionForThread(threadId);

  if (!session) {
    const bud = await this.fetchBudForThread(threadId);
    const sessionId = await this.terminalSessionManager.createSessionForThread(threadId, bud.budId);
    session = await this.terminalSessionManager.getSessionForThread(threadId);
  }

  // Ensure session is running on Bud instance
  const { ok, resumed, error } = await this.terminalSessionManager.ensureSession(session.sessionId);
  if (!ok) {
    throw new Error(error ?? "Failed to ensure terminal session");
  }
  if (resumed) {
    this.logger.info({ sessionId: session.sessionId }, "Resumed existing terminal session");
  }

  // Execute terminal operation
  if (directive.tool === "terminal.run") {
    return this.executeTerminalRun(session.sessionId, directive);
  }
  // ... other tools
}
```

---

## API Changes

### New Endpoints

```typescript
// Thread terminal (1:1)
POST /api/threads/:threadId/terminal          // Create/ensure terminal for thread
GET  /api/threads/:threadId/terminal          // Get terminal session info
GET  /api/threads/:threadId/terminal/stream   // SSE stream for terminal output
POST /api/threads/:threadId/terminal/input    // Send input
POST /api/threads/:threadId/terminal/interrupt
POST /api/threads/:threadId/terminal/resize
GET  /api/threads/:threadId/terminal/history  // Get terminal history

// Session direct access (by sessionId)
GET  /api/sessions/:sessionId                 // Get session details
DELETE /api/sessions/:sessionId               // Close session

// Bud inventory (for Bud page)
GET  /api/buds/:budId/sessions                // List all sessions on this Bud
```

### Example: Ensure Terminal for Thread

```typescript
// POST /api/threads/:threadId/terminal
server.post("/api/threads/:threadId/terminal", async (request, reply) => {
  const { threadId } = request.params as { threadId: string };

  const thread = await db.query.threadTable.findFirst({
    where: eq(threadTable.threadId, threadId),
  });
  if (!thread) {
    return reply.code(404).send({ error: "thread_not_found" });
  }

  // Get or create session
  let session = await terminalSessionManager.getSessionForThread(threadId);
  const created = !session;

  if (!session) {
    const sessionId = await terminalSessionManager.createSessionForThread(threadId, thread.budId);
    session = await terminalSessionManager.getSessionForThread(threadId);
  }

  // Ensure running on Bud
  const { ok, resumed, error } = await terminalSessionManager.ensureSession(session.sessionId);
  if (!ok) {
    return reply.code(503).send({ error: error ?? "terminal_unavailable" });
  }

  return {
    session_id: session.sessionId,
    bud_id: session.budId,
    state: session.state,
    created,
    resumed,
  };
});
```

### SSE Stream by Thread

```typescript
// GET /api/threads/:threadId/terminal/stream
server.get("/api/threads/:threadId/terminal/stream", async (request, reply) => {
  const { threadId } = request.params as { threadId: string };

  const session = await terminalSessionManager.getSessionForThread(threadId);
  if (!session) {
    return reply.code(404).send({ error: "no_terminal_session" });
  }

  // Attach to session's event channel
  const detach = terminalEvents.attach(session.sessionId, reply);
  request.raw.on("close", detach);

  // Start heartbeat...
});
```

---

## Frontend Changes

### Bud Page Component

New page to view Bud details and all sessions running on it:

```typescript
// web/src/components/workbench/bud-page.tsx

export function BudPage({ budId, budProfile }: BudPageProps) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);

  useEffect(() => {
    fetch(`/api/buds/${budId}/sessions`)
      .then(r => r.json())
      .then(data => setSessions(data.sessions));
  }, [budId]);

  return (
    <div className="flex flex-col h-full">
      <BudHeader profile={budProfile} />

      <div className="flex-1 overflow-auto p-4">
        <h3 className="text-lg font-semibold mb-4">Active Sessions</h3>

        {sessions.length === 0 ? (
          <p className="text-muted-foreground">
            No active sessions. Start a chat to create one.
          </p>
        ) : (
          <div className="space-y-2">
            {sessions.map(session => (
              <SessionCard
                key={session.sessionId}
                session={session}
                onNavigate={() => navigateToThread(session.threadId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

### Thread Terminal Connection

Connect terminal by thread (resolves to that thread's session):

```typescript
// web/src/App.tsx

useEffect(() => {
  if (!threadId) {
    setTerminalConnection('disconnected');
    return;
  }

  let cancelled = false;

  const connect = async () => {
    // Ensure terminal exists for this thread
    const resp = await fetch(`/api/threads/${threadId}/terminal`, { method: 'POST' });
    if (!resp.ok || cancelled) return;

    const { session_id, resumed, created } = await resp.json();

    if (resumed) {
      console.log('[terminal] Resumed existing session', session_id);
    } else if (created) {
      console.log('[terminal] Created new session', session_id);
    }

    // Connect to thread's terminal stream
    const source = new EventSource(`/api/threads/${threadId}/terminal/stream`);
    terminalEventSourceRef.current = source;
    // ... rest of SSE handling
  };

  connect();

  return () => {
    cancelled = true;
    terminalEventSourceRef.current?.close();
  };
}, [threadId]);
```

### Session Indicator in Thread List

Show which threads have active terminal sessions:

```typescript
// In thread list item
<div className="flex items-center gap-2">
  <span>{thread.title ?? 'Untitled'}</span>
  {thread.has_terminal_session && (
    <span
      className="w-2 h-2 rounded-full bg-green-500"
      title="Active terminal session"
    />
  )}
</div>
```

---

## Implementation Phases

### Phase 1: Database Schema

- [ ] Create migration `0006_terminal_sessions.sql`
- [ ] Add TypeScript schema for new tables
- [ ] Keep old `bud_terminal` tables (backward compatibility)

### Phase 2: Bud Multi-Session Support

- [ ] Add `session_id` to all terminal frame types
- [ ] Implement `HashMap<String, TerminalHandle>` for multiple sessions
- [ ] Dynamic tmux session naming
- [ ] Per-session log paths (`~/.bud/sessions/{session_id}/`)
- [ ] Route all terminal frames by session_id

### Phase 3: TerminalSessionManager

- [ ] Create `TerminalSessionManager` class
- [ ] Session lifecycle: create, ensure, close
- [ ] Session lookup by threadId
- [ ] Session-keyed in-memory state (readiness, offsets)

### Phase 4: API Endpoints

- [ ] `POST/GET /api/threads/:threadId/terminal`
- [ ] `GET /api/threads/:threadId/terminal/stream`
- [ ] `POST /api/threads/:threadId/terminal/input`
- [ ] `GET /api/buds/:budId/sessions`
- [ ] Update gateway to route by session_id

### Phase 5: Agent Integration

- [ ] Update `executeTerminalCall` to use TerminalSessionManager
- [ ] Create session on first terminal tool use for thread
- [ ] All terminal operations use sessionId

### Phase 6: Frontend

- [ ] BudPage component with session list
- [ ] Thread-based terminal connection (by threadId)
- [ ] Session indicator in thread list
- [ ] Handle `resumed` status in UI

---

## Migration Strategy

### Backward Compatibility

1. **Old Bud**: Works with `session_id = "default"` (falls back to single session)
2. **Old `bud_terminal` data**: Remains in place, not migrated
3. **New sessions**: Use `terminal_session` table exclusively
4. **Feature flag**: `THREAD_SCOPED_SESSIONS=true` (default off initially)

### Rollout

1. Deploy schema changes
2. Deploy Bud with multi-session support
3. Deploy service with TerminalSessionManager
4. Deploy frontend changes
5. Enable feature flag
6. Monitor
7. Eventually deprecate old `bud_terminal` code path

---

## Future: Dedicated VM per Thread

When ready for VM pools, the `instance_id` column enables:

```typescript
async createSessionForThread(threadId: string, budId: string): Promise<string> {
  const sessionId = `sess_${ulid()}`;

  // Future: Allocate a VM instance for this thread
  const instanceId = await this.allocateInstance(budId);

  await db.insert(terminalSessionTable).values({
    sessionId,
    threadId,
    budId,
    instanceId,  // Dedicated VM for this thread
    // ...
  });

  return sessionId;
}
```

The service routes `terminal_ensure` to the correct instance based on `instanceId`.

---

## Open Questions

1. **Session limit per Bud**: Max concurrent sessions on one instance?
   - **Recommendation**: 20 initially, configurable

2. **Orphaned sessions**: Thread deleted, session exists?
   - **Recommendation**: Mark orphaned, cleanup after 7 days

3. **Instance assignment** (future): How to allocate VMs?
   - **Recommendation**: Defer until multi-instance is implemented

---

## Appendix: Key Files

| Component | File | Changes |
|-----------|------|---------|
| Schema | `service/src/db/schema.ts` | New `terminalSession*` tables |
| Migration | `service/migrations/0006_terminal_sessions.sql` | DDL |
| Session Manager | `service/src/runtime/terminal-session-manager.ts` | New file |
| Routes | `service/src/routes/threads.ts` | Terminal endpoints |
| Routes | `service/src/routes/buds.ts` | Session inventory |
| Agent | `service/src/agent/agent-service.ts` | Session integration |
| Gateway | `service/src/ws/gateway.ts` | Session routing |
| Bud | `bud/src/main.rs` | Multi-session support |
| Frontend | `web/src/App.tsx` | Thread-based terminal |
| Frontend | `web/src/components/workbench/bud-page.tsx` | New component |
