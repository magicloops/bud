# Design: Unified Thread Sessions & Terminal View

## 0. Context / Problem Statement

Our Workbench currently exposes **two** shell surfaces:

1. **Run-based terminal (legacy):** chat messages trigger the `shell.run` tool, the backend records `run` rows, Bud executes one-off commands, and the terminal pane replays per-run transcripts via `/api/runs/:id/stream`.
2. **Interactive session (beta):** a separate card launches `/api/sessions` + `/term` WebSocket, giving the user a live PTY with writer/spectator semantics and attach tokens.

This split forces users (and the agent) to pick the “right” surface, duplicates logging/storage, and prevents GPT from seamlessly using the PTY. The desired end-state: **every conversation thread owns exactly one long-lived session**, and the Workbench shows a single terminal that always represents that session. Chat messages stay high-level; runs are kept only for backwards-compatibility and headless automation.

## 1. Goals & Non-goals

**Goals**
- Single terminal surface per thread, backed by an automatically managed session.
- Chat/agent tool calls stream commands into the session; no more one-off run executions in the UI.
- Writer/spectator semantics preserved so users can take over from the agent at any time.
- Architecture remains open to future tmux durability (Phase 4.8+).

**Non-goals (for this iteration)**
- Removing `/api/runs` or breaking existing automation — legacy APIs stay functional, but Workbench stops using them.
- Implementing tmux adoption or multi-session rosters (tracked separately).
- Comprehensive session history exports (we’ll scope transcript downloads in a later pass).

## 2. Current Divergence Snapshot

| Concern | Run Terminal | Interactive Session |
|---------|--------------|---------------------|
| Transport | `/api/runs/:id/stream` SSE, Bud `run_*` frames | `/term` WS + `/api/sessions/:id/stream` SSE, Bud `session_*` frames |
| Lifecycle | `run` row per tool call | `session` row with attach tokens |
| UI | Primary terminal pane | Secondary card (“Interactive session (beta)”) |
| Agent loop | Uses `shell.run` | Not integrated |
| Persistence | `run_log` per run | `session_log` per session |

Threads can therefore accumulate many runs plus zero or more sessions with no linkage, and the agent has no way to “type” into the PTY.

## 3. Proposed Approach — Thread-Scoped Session Terminal

1. **Thread↔Session pointer:** add `current_session_id` to `thread`. Opening a thread auto-creates a session if none exists, else attaches to the existing one. Sessions are long-lived by default (idle/hard TTLs set to “effectively infinite”) and persist across client disconnects.
2. **Agent tool adapter:** replace `shell.run` dispatches with a session writer. When the Responses API calls our “shell” tool, the backend acquires the writer lease on the thread-owned session, writes the command(s) into the PTY, tails the output (last _N_ lines/bytes + exit status) for the tool result, then releases the lease. `run_id` is dropped entirely in favor of session-scoped tool results.
3. **UI consolidation:** the Workbench terminal panel always reflects the thread’s session. The old “start session” button and legacy run terminal/history are removed; the terminal is always-on and attached to the thread’s session, with a simple timeline of command markers.
4. **Manual input:** users can still type directly into the PTY without explicitly “acquiring” a lease; the thread owns the writer lease and the agent borrows it for tool calls. Keystrokes are not chat messages, but we log lightweight “manual intervention” markers and optionally feed the most recent tail into the next agent turn for context.

This approach gives a clean 1:1 mapping (thread ↔ session), keeps the chat above the PTY, and lets both agent and user collaborate on the same shell.

## 4. Technical Considerations & Open Questions

### 4.1 Thread→Session Mapping
- Schema change: `thread.current_session_id` + index for lookups.
- Lifecycle policy: auto-create on first thread load; reuse on subsequent visits even if the web client/service disconnects. TTLs are raised to “effectively infinite” for the PoC; when a session does close, clear the pointer (history table optional later).

### 4.2 Agent/User Arbitration & Command Routing
- **Thread-owned writer lease:** The thread/session owns the lease. The agent borrows it per tool call; the user can type directly without an explicit “acquire” action. If the agent is mid-turn, the UI shows a stop button; user input can queue one pending message while the agent is running.
- **Input UX:** The chat textarea stays enabled during an agent turn so a single user message can queue; no explicit “acquire lease” action is required.
- **Agent as temporary writer:** Each tool call claims the writer lease, runs necessary commands (`cat`, `chmod`, `./script`, etc.), captures tail output, and releases immediately. If a user is actively typing, the agent waits/block until the lease is free.
- **User priority controls:** If the agent owns the lease, the UI displays “Agent is running commands…” plus a “Stop” (cancels Responses) and optional “Take control” if needed. Agent commands queue until the lease is available.
- **Manual typing context:** When users type directly, we log a timeline entry (“User typed manual commands”) and expose a bounded PTY tail (from `session_log`, truncated) so the next agent step can infer what changed.

### 4.3 Transport / Backend Plumbing
- `/term` currently assumes browser clients. For the agent we can either:
  1. Add a backend-resident `/term` client (WS) that attaches as the “agent writer”.
  2. Extend the Bud WSS protocol so the backend can send `session_input`/`session_resize` directly without going through `/term`.
- Option (2) avoids another WS hop but means the service must enforce writer leases before forwarding frames to Bud.

### 4.4 Chat Semantics & Tool Results
- Responses API expects structured tool responses; we should include:
  - Exit code / signal.
  - Default tail: last 200 lines per stream (or equivalent bounded bytes), ANSI-stripped; mark truncation with a prefix like “856 lines omitted…” when clipped and include counts for omitted lines/bytes.
  - Separate stdout/stderr tails and a flag for non-zero exit to hint the next turn.
- Multi-step plans: GPT may chain several tool calls; we need clear markers when a call finishes so the agent knows when to emit natural language back to the user.

### 4.5 Session Output & Transcript Handling
- Chat history remains user↔assistant text; **no per-command cards** live in the UI. The PTY pane shows the raw session stream, and we only feed the most recent truncated tail (e.g., 4 KB) back to the Responses API between tool calls.
- Timeline markers record “agent command” and “user manual input” events using `session_log` as source; keep this minimal so it’s easy to swap out later.
- For transcript downloads we’ll stub blob storage by writing capped chunks to temporary files, returning paths/URLs with TODOs to swap in real blob storage later.

### 4.6 Testing & Observability
- Integration tests: “open thread → session auto-creates → agent runs command → user takes writer → agent resumes”.
- Telemetry updates: metrics for `session.bytes_in/out`, `writer_rotations`, `agent_lease_seconds`, crash counts, etc., to ensure arbitration works.

## 5. Clarified Decisions & Remaining Unknowns

1. **Agent/User coordination UX**
   - The chat “Send” button doubles as the “Stop” button. Pressing it during an active Responses call cancels the turn, relinquishes the writer lease, and leaves any PTY processes running for the user to manage manually.
   - When the agent owns the lease, show an inline banner with a “Take control” button (invokes `/take-writer`). Users may queue **one** additional instruction client-side; it dispatches automatically once the current turn stops.
   - Manual PTY input is logged as a lightweight timeline entry and we can optionally append the latest tail to the next agent turn.

2. **Session lifetime**
   - Set idle/hard TTLs extremely high so sessions effectively stay open indefinitely until the user stops them (tmux durability can revisit this later).

3. **Command representation**
   - No discrete per-command cards; the chat log suffices. The PTY pane is the canonical transcript, with truncated snippets sent back to the model as needed.

4. **Transcript storage**
   - Stub with temporary files + TODO for blob storage.

5. **Automation & queuing**
   - `/api/runs` and `run_id` usage in the UI/agent are removed for the unified terminal. Workbench enforces the single-stop workflow; users may queue one chat input client-side while an agent turn runs.

6. **Error recovery**
   - If the session crashes, display a modal explaining data loss risk and prompt the user to confirm a restart (creating a new session and updating `current_session_id`). For the PoC we keep sessions long-lived and avoid tearing them down on stop/cancel; stop only aborts the current Responses call.

**Remaining unknowns:** how aggressive we should be with throttling when users type while the agent is queued.

## 6. Implementation Plan / Phases

1. **Phase 1 — Schema & Infrastructure**
   - Add `thread.current_session_id`, indices, and helper APIs.
   - Auto-create sessions on thread load; raise default TTLs to “effectively infinite.”

2. **Phase 2 — Agent Session Writer**
   - Implement backend writer lease acquisition, command injection, tail capture, and single-stop button behavior.
   - Wire the Responses loop to use the session instead of `/api/runs`.

3. **Phase 3 — UI Consolidation**
   - Replace the legacy run terminal with the session-driven pane and shared send/stop button.
   - Surface agent-in-progress banners, “Take control” UX, single-message queue indicator, and crash modal.

4. **Phase 4 — Logging & Export Stub**
   - Implement PTY tail truncation, temporary file exports, telemetry, and doc/QA updates.

These phases produce reviewable slices while marching toward the unified session-centric experience.
