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

1. **Thread↔Session pointer:** add `current_session_id` to `thread`. Opening a thread auto-creates a session if none exists, else attaches to the existing one.
2. **Agent tool adapter:** replace `shell.run` dispatches with a session writer. When the Responses API calls our “shell” tool, the backend acquires the writer lease, writes the command(s) into the PTY, tails the output (last _N_ lines/bytes + exit status) for the tool result, then releases the lease.
3. **UI consolidation:** the Workbench terminal panel always reflects the thread’s session. The old run terminal history is replaced by a “session timeline” (markers showing when the agent or user issued commands).
4. **Manual input:** users can still type directly into the PTY. Those keystrokes are not chat messages, but we record lightweight “manual intervention” markers and optionally feed the most recent tail into the next agent turn for context.

This approach gives a clean 1:1 mapping (thread ↔ session), keeps the chat above the PTY, and lets both agent and user collaborate on the same shell.

## 4. Technical Considerations & Open Questions

### 4.1 Thread→Session Mapping
- Schema change: `thread.current_session_id` + index for lookups.
- Lifecycle policy: when a session closes (user stops it, TTL expires), clear the pointer. Optionally store past sessions in a `thread_session` history table for auditing.

### 4.2 Agent/User Arbitration & Command Routing
- **Agent as temporary writer:** Each tool call claims the writer lease, runs necessary commands (`cat`, `chmod`, `./script`, etc.), captures tail output, and releases immediately.
- **User priority controls:** If the agent owns the lease, the UI displays “Agent is running commands…” plus a “Pause agent / Take control” button that invokes `/api/sessions/:id/take-writer`. Agent commands queue until the lease is available.
- **Manual typing context:** When users type directly, we log a timeline entry (“User typed manual commands”) and expose the most recent PTY tail (bounded) so the next agent step can infer what changed.
- **Unresolved questions:**
  - Exact UX for conflicts (banner vs. modal vs. toast).
  - Should users be able to issue a chat command like “/agent pause” to relinquish the lease?
  - Default tail size to send back to the LLM (lines vs. bytes) and whether it needs to be adaptive for verbose commands.

### 4.3 Transport / Backend Plumbing
- `/term` currently assumes browser clients. For the agent we can either:
  1. Add a backend-resident `/term` client (WS) that attaches as the “agent writer”.
  2. Extend the Bud WSS protocol so the backend can send `session_input`/`session_resize` directly without going through `/term`.
- Option (2) avoids another WS hop but means the service must enforce writer leases before forwarding frames to Bud.

### 4.4 Chat Semantics & Tool Results
- Responses API expects structured tool responses; we should include:
  - Exit code / signal.
  - Last _N_ lines of stdout/stderr (ANSI-stripped) for context.
  - Optional hints (“output truncated”) if we trimmed the tail.
- Multi-step plans: GPT may chain several tool calls; we need clear markers when a call finishes so the agent knows when to emit natural language back to the user.

### 4.5 Session Output & Transcript Handling
- Chat history remains user↔assistant text; **no per-command cards** live in the UI. The PTY pane shows the raw session stream, and we only feed the most recent truncated tail (e.g., 4 KB) back to the Responses API between tool calls.
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
   - `/api/runs` remains untouched for now. Workbench enforces the single-stop workflow; beyond the single queued chat input, users must stop an active turn before giving another instruction.

6. **Error recovery**
   - If the session crashes, display a modal explaining data loss risk and prompt the user to confirm a restart (creating a new session and updating `current_session_id`).

**Remaining unknowns:** ideal PTY tail size/format to send back to GPT, and whether we need throttling when users type aggressively while the agent is queued.

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
