# threads

Thread-route submodules split out of the top-level `routes/threads.ts` composition root.

## Purpose

Keeps browser-visible thread ownership checks explicit while splitting the old monolithic thread transport file into smaller route groups:
- core thread CRUD
- message history/create flows
- read-watermark updates for unread-attention state
- agent state/stream/cancel and structured question-response submission
- terminal create/ensure/input/history/snapshot/stream
- user-clicked file viewer session creation

## Files

### `shared.ts`

Shared Zod schemas, cursor helpers, model-selection serialization/metadata helpers, ownership-aware thread lookup, and Bud-local model availability validation helpers.

### `core.ts`

Thread list/create/read/delete routes plus `PATCH /api/threads/:threadId/model-preference` for owned model/reasoning selection persistence.

### `core.test.ts`

Focused route-handler coverage for thread-list serialization.

**Current Coverage**:
- `GET /api/threads` maps unread-attention state into `has_unseen_attention` and `last_attention_kind`
- thread-list serialization includes stored/effective model-selection fields
- `PATCH /api/threads/:threadId/model-preference` persists a validated concrete selection and rejects missing models
- `PATCH /api/threads/:threadId/model-preference` rejects unavailable
  Bud-local ds4 before updating the thread

### `messages.ts`

Thread message history, read-watermark, and create/send routes, including follow-up supersession of pending `ask_user_questions` prompts, first-message title kickoff, and user-message `path_context` stamping from cached terminal cwd when available. Create-message responses include the full serialized user message so clients can replace optimistic rows with canonical timestamps and metadata.

Message history returns normal user/assistant/tool/system transcript rows plus persisted `role: "reasoning"` display artifacts. Reasoning rows are browser-visible, owner-scoped through the same route, and intentionally excluded from model-visible reconstruction, thread previews, attention, and push notification side effects.

Create-message now resolves the current Bud environment before agent startup, but it does not run preflight context sync or `terminal_observe` before persisting the user message. When the Bud is offline, the route skips cached terminal path-context stamping, still persists the user message, and starts an offline-aware agent turn. Successful create responses include an `agent` object with `started`, `mode`, `bud_status`, and `stream_cursor` so clients can treat Bud-offline startup as a successful send rather than a failed request.

Terminal freshness is handled inside `AgentService` before provider calls: if DB/runtime state shows terminal output, cwd, readiness, or human input may be newer than the latest model-visible terminal tool result, the provider request receives a transient freshness hint telling the model to call `terminal.observe` when terminal state matters.

### `messages.test.ts`

Focused route-handler coverage for the thread read-watermark route.

**Current Coverage**:
- `POST /api/threads/:threadId/read` upserts the watermark when the seen message is newer
- stale read-watermark updates return `updated: false` and do not rewrite the row
- message history serialization preserves intermediate assistant `metadata.assistant_phase: "commentary"`
- message history serialization includes persisted `reasoning` rows while keeping them display-only
- create-message rejects invalid explicit model/reasoning selections before duplicate lookup or persistence
- create-message rejects ds4 `max` reasoning while the effective ds4 context
  window is below the 393,216 token max-thinking requirement
- create-message rejects unavailable Bud-local ds4 before user-message insert

### `agent.ts`

Agent runtime routes for `/agent/state`, `/agent/stream`, `/cancel`, and `ask_user_questions` response submission.

**Behavior**:
- authorizes the owning thread before state reads, SSE attach, cancel, or question-response submission
- enriches `/agent/state` with the owning Bud's current `environment` snapshot on idle and active responses
- enriches `/agent/state` with a best-effort `context_budget` snapshot after authorization, preferring the runtime's active backend decision during a running turn and otherwise using durable reconstruction with the same effective model selection, usable input window, normal-agent tool-schema overhead, and compaction threshold as the agent loop
- passes through runtime-only `last_error` snapshots so fast non-cancel agent failures can be recovered by `/agent/state` without creating transcript rows
- passes through `draft_assistant.started_at` so refreshes can recover active assistant draft timing from service timestamps
- passes through `draft_reasoning` snapshots so refreshes can recover visible in-flight provider reasoning before the durable reasoning row is emitted
- `/agent/stream` may emit additive `agent.compaction_start`, `agent.compaction_done`, and `agent.compaction_failed` activity markers from `AgentService`; these events are not transcript rows and omit checkpoint summaries/replacement histories. Successful compaction may include an optional post-compaction `context_budget` snapshot.
- `/agent/stream` emits `agent.reasoning_start`, `agent.reasoning_delta`, and `agent.reasoning_done` for visible provider reasoning, with `agent.reasoning_done.message` carrying the persisted `role: "reasoning"` row
- `/agent/stream` failed `final` events carry sanitized `error`, `error_code`, and `retryable` fields rather than raw provider or daemon transport messages
- accepts `POST /api/threads/:threadId/agent/question-requests/:requestId/responses`
- validates submitted answers against the persisted question request row
- returns whether the accepted response continued a live tool call, created a fallback user message, or matched an already-answered idempotent retry
- logs known question-response failures with thread/request/viewer ids plus a redacted response-body summary that omits raw freeform answer values

### `agent-question-response.test.ts`

Focused route-level integration coverage for structured question-response submission.

**Current Coverage**:
- `/agent/state` includes runtime `last_error` after authorization
- `/agent/state` includes runtime `draft_reasoning` after authorization
- owned submissions call `AgentService.submitQuestionResponse(...)` and serialize accepted continuation status
- unauthenticated callers receive `401`
- signed-in non-owner and cross-thread/missing request submissions receive `404`
- repository/request validation failures map to stable route errors
- malformed stored question requests fail closed with a service-side contract error
- validation-failure logs include safe diagnostic shape without raw text answer values

### `files.ts`

Thread-scoped file viewer route for `POST /api/threads/:threadId/files/open`.

**Behavior**:
- authorizes through `requireAuthorizedThreadAccess(...)` and derives `budId` from the owned thread
- accepts workspace-relative path candidates and absolute POSIX candidates
- rejects home, parent traversal, Windows, URL, NUL, empty, backslash, and directory path forms at the service boundary
- requires file-read transport availability and daemon `files.resolve.absolute_posix` capability before absolute POSIX preflight
- sends daemon `file_resolve` for absolute POSIX inputs and creates sessions only from daemon-approved workspace-relative results
- parses optional line/column metadata and carries it into display metadata and viewer hints
- loads the clicked source message by authorized thread/user and copies trusted `metadata.path_context` into file-session display metadata
- omits message-time path context for absolute POSIX opens because the absolute candidate resolves through daemon policy rather than cwd context
- creates a viewer-owned `file_session` with `root_key: "workspace"`, `stat/read/range` permissions, the default short TTL, and a 1 MiB preview byte cap
- persists daemon preflight content identity on absolute POSIX sessions
- stores click source metadata such as assistant `message_id` / `client_id` when supplied by the UI

### `terminal.ts`

Thread-scoped terminal routes for session create/ensure/read, snapshot, SSE attach, human input/interrupt/resize, and history reads (terminal proto 0.3).

- The stream route treats `Last-Event-ID` as the stringified byte offset the client last applied: a numeric cursor triggers durable output replay from that offset (via `readOutputRange`, internally paginated) before attaching live, with offset-based dedupe between replayed and live `terminal.output` events. `?from_offset=<n>` carries the same cursor via the query string for first connects (browsers cannot set `Last-Event-ID` on a fresh EventSource) and wins over the header when both are present. Non-numeric/absent cursors fall back to the in-memory buffer replay. Output SSE events carry offset ids; `terminal.event` and other non-output events carry no id.
- `GET /terminal/snapshot?lines=<N>` (default 1000, cap 2000) serves the Phase 3 line-oriented initial render: it observes the daemon emulator's `history` view (scrollback text) then its `screen` view on the same session and responds with `{ session_id, mode, integration, alt_screen, history_text, screen_text, cols, rows, ring_next_offset }`. `ring_next_offset` comes from the SCREEN observe (the daemon's `terminal_observe_result` watermark) so resuming the stream via `?from_offset=ring_next_offset` yields no duplication; a line that scrolls off between the two observes is lost from the snapshot only (accepted). Errors: `404 no_terminal_session`, `503 bud_offline` (pre-check plus observe-time race), `502 observe_failed` on daemon observe failure/timeout. Mode/integration fall back to the runtime context and the watermark to the durable stream offset for older daemons that omit observe facts.
- The history route serves `since_offset` reads through `readOutputRange(...)` (covering-chunk trim, explicit `truncated`/`next_offset`) and tail reads through the byte-budget `tailOutput(...)`.
- The interrupt route sends a human Ctrl+C as a dispatch-only `terminal_send` (no `wait_for`/`await` field) and rejects older pending terminal waits as `interrupted`, so a long awaited agent tool can return a conservative tool result instead of remaining pending for the full awaited budget. The HTTP response keeps the `submitted` field name (mapped from the runtime's `dispatched`).

### `terminal.test.ts`

Focused route-handler coverage for the terminal interrupt route, the snapshot route, and the offset-resume SSE stream (durable replay from `Last-Event-ID` and `?from_offset`, overlap dedupe against live events, verbatim `terminal.event` forwarding).

**Current Coverage**:
- owned terminal interrupt returns dispatch metadata from the terminal manager
- missing active sessions return `404 no_terminal_session`
- snapshot observes history-then-screen, reports the screen observe's `ring_next_offset`, caps `lines` at 2000, falls back to runtime context/stored watermark for older daemons, and returns `401`/`404`/`503`/`502` on the auth/no-session/offline/observe-failure paths
- `?from_offset` stream resume replays durable output from the cursor before live events, filters overlapping live chunks, and wins over a conflicting `Last-Event-ID` header

### `files.test.ts`

Focused route-handler coverage for the thread file-open route.

**Current Coverage**:
- unauthenticated requests return `401`
- signed-in non-owner thread requests return `404`
- owned requests create viewer-scoped file sessions with thread ownership, viewer byte cap, permissions, path metadata, and viewer hints
- absolute POSIX opens call daemon preflight and persist resolved metadata
- unsupported URL-style path forms return `400 invalid_file_path`
- daemon outside-root absolute denials return `403`

### `registration.test.ts`

Regression test for the split thread-route registration surface.

**Current Coverage**:
- the split core/message/agent/terminal/file modules register the expected endpoint set
- route registration remains duplicate-free after the decomposition

## Ownership Notes

- every exported route module resolves thread ownership at the route boundary through `requireAuthorizedThreadAccess(...)`
- SSE attach happens only after ownership is resolved
- terminal routes still stamp and enforce the owning human through the terminal runtime
- file viewer session creation stamps the acting viewer on `file_session.created_by_user_id` and never trusts a client-supplied Bud id
- thread model-preference updates resolve through the same owned-thread boundary and return `404` for signed-in non-owners
- question-response submission resolves the thread owner first, loads requests by `(thread_id, question_request_id)`, stamps `answered_by_user_id`, and returns `404` for cross-thread or cross-user request ids
- normal message creation resolves ownership first, returns duplicate `client_id` retries with the serialized existing message before side effects, then asks `AgentService` to close pending question requests as skipped before persisting and returning the new serialized user message
- create-message derives Bud environment from the owned thread's Bud id; clients cannot supply or override the environment/Bud identity used for offline startup
- thread creation, thread model-preference updates, and fresh message sends
  validate `ds4-deepseek-v4-flash` against the owned thread's Bud before
  durable side effects; absent/offline/unhealthy Bud-local ds4 returns
  `424 local_model_unavailable`

---

*Parent spec: [../routes.spec.md](../routes.spec.md)*
