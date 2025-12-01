# Phase 2 Review: Backend Terminal Manager + Data Model

**Reviewed:** 2025-11-30
**Status:** ✅ COMPLETE
**Design Doc:** `plan/persistent-terminal.md` Section 12, Phase 2

---

## Scope

Phase 2 deliverables from design doc:
- [ ] Database schema: bud_terminal, terminal_output, terminal_input_log
- [ ] TerminalManager: state tracking, output storage, SSE streaming
- [ ] Gateway: forward terminal_* frames with unified envelope
- [ ] REST/SSE endpoints for terminal control

---

## Implementation Review

### 1. Database Schema ✅

**Files:**
- `service/src/db/schema.ts` (lines 246-311)
- `service/drizzle/migrations/0004_smart_joystick.sql`

#### bud_terminal Table

| Column | Type | Expected | Implemented | Status |
|--------|------|----------|-------------|--------|
| bud_id | text | PK, FK to bud | ✅ | ✅ |
| state | text | none/creating/ready/active/idle/closed | ✅ default 'none' | ✅ |
| tmux_session_name | text | session identifier | ✅ | ✅ |
| pid | integer | shell process ID | ✅ | ✅ |
| shell | text | /bin/bash, /bin/zsh, etc | ✅ | ✅ |
| cols, rows | integer | terminal dimensions | ✅ default 200x50 | ✅ |
| started_at | timestamptz | when created | ✅ | ✅ |
| last_input_at | timestamptz | last input time | ✅ | ✅ |
| last_output_at | timestamptz | last output time | ✅ | ✅ |
| last_activity_at | timestamptz | last any activity | ✅ | ✅ |
| closed_at | timestamptz | when closed | ✅ | ✅ |
| output_log_bytes | bigint | current stored bytes | ✅ | ✅ |
| total_input_bytes | bigint | cumulative input | ✅ | ✅ |
| total_output_bytes | bigint | cumulative output | ✅ | ✅ |

**Indexes:**
- `bud_terminal_state_idx` on state
- `bud_terminal_last_activity_idx` on lastActivityAt

#### terminal_output Table

| Column | Type | Expected | Implemented | Status |
|--------|------|----------|-------------|--------|
| bud_id | text | FK to bud_terminal | ✅ | ✅ |
| seq | bigint | sequence number | ✅ composite PK | ✅ |
| data | bytea | raw output bytes | ✅ | ✅ |
| byte_offset | bigint | position in stream | ✅ | ✅ |
| created_at | timestamptz | when received | ✅ | ✅ |

**Indexes:**
- Primary key on `(bud_id, seq)`
- `terminal_output_offset_idx` on `(bud_id, byte_offset)`

#### terminal_input_log Table

| Column | Type | Expected | Implemented | Status |
|--------|------|----------|-------------|--------|
| id | uuid | PK | ✅ | ✅ |
| bud_id | text | FK to bud_terminal | ✅ | ✅ |
| data | bytea | input sent | ✅ | ✅ |
| source | text | user/agent/system | ✅ | ✅ |
| run_id | text | optional run context | ✅ | ✅ |
| user_id | text | optional user | ✅ | ✅ |
| created_at | timestamptz | when sent | ✅ | ✅ |

**Indexes:**
- `terminal_input_log_bud_idx` on `(bud_id, created_at)`

### 2. TerminalManager ✅

**File:** `service/src/runtime/terminal-manager.ts` (402 lines)

| Method | Signature | Implemented | Status |
|--------|-----------|-------------|--------|
| `ensureTerminal` | `(budId, config?) → Promise<{ok, error?}>` | Lines 57-97 | ✅ |
| `sendInput` | `(budId, data, opts) → Promise<{ok}>` | Lines 99-135 | ✅ |
| `sendInterrupt` | `(budId) → Promise<{ok}>` | Lines 137-152 | ✅ |
| `handleTerminalStatus` | `(budId, payload) → Promise<void>` | Lines 154-193 | ✅ |
| `handleTerminalOutput` | `(budId, payload) → Promise<void>` | Lines 195-270 | ✅ |
| `handleTerminalReady` | `(budId, assessment) → Promise<void>` | Lines 272-279 | ✅ |
| `fetchStatus` | `(budId) → Promise<{state, info}>` | Lines 298-324 | ✅ |
| `tailOutput` | `(budId, maxBytes) → Promise<{data, totalBytes}>` | Lines 326-356 | ✅ |
| `getLatestReadiness` | `(budId) → assessment | null` | Lines 281-283 | ✅ |
| `waitForReadiness` | `(budId, timeoutMs) → Promise<assessment | null>` | Lines 285-296 | ✅ |

**Key Features:**
- UPSERT pattern for idempotent state updates
- Soft cap enforcement: 100MB default (`config.terminalOutputSoftCapBytes`)
- Event emission to TerminalEventBus for SSE
- Input audit logging to terminal_input_log
- In-memory readiness cache with polling support

### 3. Terminal Event Bus ✅

**File:** `service/src/runtime/event-bus.ts` (82 lines)

| Feature | Expected | Implemented | Status |
|---------|----------|-------------|--------|
| Event emission | `emit(budId, event)` | Lines 25-40 | ✅ |
| SSE attachment | `attach(budId, reply) → detach` | Lines 42-76 | ✅ |
| Event buffering | Last N events per channel | 1000 events (line 21) | ✅ |
| Buffer replay | Send buffered on attach | Lines 60-62 | ✅ |

**Event Types Emitted:**
- `terminal.status` - state changes
- `terminal.output` - output chunks
- `terminal.ready` - readiness assessments
- `terminal.input` - input sent (for audit)

### 4. Gateway Integration ✅

**File:** `service/src/ws/gateway.ts`

| Feature | Expected | Implemented | Status |
|---------|----------|-------------|--------|
| Schema validation | Zod schemas for terminal_* | Lines 117-145 | ✅ |
| Unified envelope | `{type, proto, id, ts}` | TerminalEnvelopeSchema | ✅ |
| Message routing | switch on type | Lines 321-329 | ✅ |
| handleTerminalStatus | Dispatch to manager | Lines 429-446 | ✅ |
| handleTerminalOutput | Dispatch to manager | Lines 448-476 | ✅ |
| handleTerminalReady | Dispatch to manager | Lines 478-491 | ✅ |

**Validation Schemas:**
```typescript
TerminalStatusSchema (lines 117-133)
TerminalOutputSchema (lines 135-140)
TerminalReadySchema (lines 142-145)
```

### 5. REST Endpoints ✅

**File:** `service/src/routes/terminals.ts` (76 lines)

| Endpoint | Method | Purpose | Implemented | Status |
|----------|--------|---------|-------------|--------|
| `/api/terminals/:budId/ensure` | POST | Create/ensure terminal | Lines 15-27 | ✅ |
| `/api/terminals/:budId` | GET | Fetch status | Lines 29-33 | ✅ |
| `/api/terminals/:budId/history` | GET | Fetch output tail | Lines 35-46 | ✅ |
| `/api/terminals/:budId/input` | POST | Send input | Lines 48-65 | ✅ |
| `/api/terminals/:budId/interrupt` | POST | Send Ctrl+C | Lines 67-74 | ✅ |

**Response Formats:**
- ensure: `{ok: true}` or `{error: "..."}` (503)
- status: `{state, info: {...}}`
- history: `{bud_id, bytes, total_bytes_available, data_base64}`
- input: `{ok: true}` or `{error: "..."}` (503)
- interrupt: `{ok: true}` or `{error: "..."}` (503)

### 6. SSE Streaming ✅

**File:** `service/src/server.ts` (lines 97-116)

| Feature | Expected | Implemented | Status |
|---------|----------|-------------|--------|
| SSE endpoint | `GET /api/terminals/:budId/stream` | Line 97 | ✅ |
| Event bus attach | Register reply for events | Line 99 | ✅ |
| Buffer replay | Send buffered on connect | Via event bus | ✅ |
| Heartbeat | Periodic keep-alive | **Added**: 1s dev, 5s prod | ✅ |
| Cleanup | Detach on close | Lines 112-115 | ✅ |

**Heartbeat Implementation:**
```typescript
const heartbeatMs = process.env.NODE_ENV === "production" ? 5000 : 1000;
const heartbeatInterval = setInterval(() => {
  reply.sse({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) });
}, heartbeatMs);
```

### 7. Configuration ✅

**File:** `service/src/config.ts` (lines 42-49)

| Config | Default | Purpose |
|--------|---------|---------|
| `terminalEnabled` | true | Feature flag |
| `terminalOutputSoftCapBytes` | 100MB | Max stored per Bud |
| `terminalOutputBackfillBytes` | 4KB | History fetch default |
| `terminalOutputInflightMax` | 128 | Flow control |
| `terminalOutputRetentionDays` | 7 | DB cleanup window |

---

## Gaps & Notes

### Minor Gaps (Not Blocking)

1. **Input Log Silent Failures**: Input recording in try/catch silently swallows DB errors (line 371-373)
   - Impact: Audit trail may be incomplete on DB errors
   - Severity: Low (audit is optional)

2. **No terminal_disconnected Event**: Relies on heartbeat timeout to detect disconnects
   - Current: Heartbeat mechanism handles detection
   - Impact: None (heartbeat works)

3. **Readiness Not Persisted**: Only kept in memory Map
   - Design: Intentional - agent only needs current state
   - Impact: None

### Implementation Notes

- **Soft cap enforcement**: Warns when output exceeds cap, stores up to cap
- **UPSERT pattern**: Uses `onConflictDoUpdate` for idempotent state changes
- **Heartbeat addition**: Recent enhancement for stale connection detection
- **Proto version**: 0.2 for terminal envelope

---

## Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| Database tables created with all fields | ✅ |
| TerminalManager tracks state and output | ✅ |
| Gateway routes terminal_* frames | ✅ |
| REST endpoints functional | ✅ |
| SSE streaming works with buffering | ✅ |
| Soft caps enforced | ✅ |

---

## File References

| File | Lines | Purpose |
|------|-------|---------|
| `service/src/db/schema.ts` | 246-311 | Table definitions |
| `service/drizzle/migrations/0004_smart_joystick.sql` | - | Migration SQL |
| `service/src/runtime/terminal-manager.ts` | all | Core terminal logic |
| `service/src/runtime/event-bus.ts` | 1-82 | SSE event bus |
| `service/src/ws/gateway.ts` | 117-145, 321-329, 429-491 | WS frame handling |
| `service/src/routes/terminals.ts` | all | REST endpoints |
| `service/src/server.ts` | 97-116 | SSE stream setup |
| `service/src/config.ts` | 42-49 | Terminal config |

---

## Verdict

**Phase 2: ✅ COMPLETE**

All core deliverables implemented and working. Database schema matches design, TerminalManager has all required methods, gateway correctly routes frames, and REST/SSE endpoints are functional. Recent heartbeat enhancement improves resilience.
