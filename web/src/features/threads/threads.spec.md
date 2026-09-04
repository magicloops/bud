# threads

Thread-scoped browser runtime modules.

## Purpose

Owns thread-scoped browser runtime behavior that was previously embedded
directly inside `web/src/routes/$budId/$threadId.tsx`, including transcript,
agent stream, terminal, file-viewer, and web-view state.

## Files

### `use-thread-messages.ts`

Message/transcript ownership for the existing-thread route.

**Responsibilities**:
- bootstrap transcript state from loader-provided `{ messages, page }` plus `/agent/state` overlays
- preserve prepended-scroll position when older history loads
- fetch older transcript pages through `before=<cursor>`; `loadOlderMessages` is re-entrancy-safe (in-flight ref, since the timeline's scroll sentinel can fire again before state re-renders) and exposes `olderMessagesLoadFailed` so the timeline pauses auto-loading after a failure and shows a retry
- create and reconcile optimistic user messages
- apply runtime pending-tool and draft-assistant overlays
- apply runtime draft-reasoning overlays
- preserve pending `ask_user_questions` overlays from `/agent/state` so a refresh can recover the form while the service is waiting on the user
- reconcile canonical assistant/tool messages from the agent stream
- reconcile live reasoning draft rows with persisted `role: "reasoning"` messages from the agent stream
- keep visible assistant draft text in the timeline when a tool call arrives, so text streamed before or between tool calls is not removed while waiting for the persisted assistant row
- clear per-turn synthetic rows when a turn finishes or fails

**Exports**:
- `THREAD_MESSAGE_PAGE_LIMIT`
- `useThreadMessages(...)`

**Route contract**:
- the route still owns loader fetches, terminal presentation, and top-level status/error state
- this hook owns transcript mutation behavior and exposes narrow callbacks for the route’s stream handlers

### `thread-message-state.ts`

Pure transcript/message reconciliation helpers shared by `use-thread-messages.ts`.

**Responsibilities**:
- stable `client_id` identity comparison and chronological sorting
- optimistic user-message reconciliation into canonical persisted rows, including server timestamps and metadata
- pending-tool / draft-assistant synthetic-row detection and cleanup
- draft-reasoning synthetic-row detection, update, reconciliation, and cleanup
- pending `ask_user_questions` synthetic rows carry the server `started_at` timestamp when available so refresh and live stream rows sort consistently
- draft assistant synthetic rows carry the server `started_at` timestamp when available so refresh and persisted assistant rows keep stable chronology
- live tool-call events and `/agent/state` snapshots share the same pending-tool row builder
- `/agent/state` overlay application
- `/agent/state.draft_reasoning` overlay application
- latest-bootstrap merges that preserve older already-loaded transcript history
- per-turn finalization cleanup rules
- `upsertMessage` preserves object identity for untouched rows, returns the
  same array for identical re-upserts, and skips the chronological re-sort
  when an in-place update cannot change order (unchanged `created_at` +
  `message_id`) — the streaming hot path memoized consumers depend on

**Exports**:
- `applyAgentStateOverlay(...)`
- `mergeLatestBootstrapState(...)`
- `reconcileMessagePersistence(...)`
- `finalizeTurnMessages(...)`
- supporting pure helpers for message upsert/synthetic-row detection

### `thread-message-state.test.ts`

Node-runner coverage for transcript reconciliation rules.

**Coverage**:
- optimistic → canonical row reconciliation, including live ordering when a superseded tool result is inserted before a follow-up user message
- stale synthetic overlay replacement
- live `agent.tool_call` events build pending `ask_user_questions` prompt rows
- `/agent/state` bootstrap preserves pending `ask_user_questions` prompt rows
- latest-bootstrap refreshes do not duplicate pending `ask_user_questions` prompt rows
- `/agent/state` bootstrap preserves draft reasoning rows
- live `agent.reasoning_*` events reconcile draft reasoning rows into persisted `reasoning` messages
- latest-bootstrap preservation of older history/cursors
- turn finalization cleanup semantics
- failed/canceled turn finalization clears draft reasoning rows
- persisted commentary assistant rows survive draft replacement and successful turn finalization
- upsert identity preservation and sort-skip on in-place streaming deltas

### `agent-work-projection.ts`

Agent-work timeline projection (design/web-agent-work-collapse.md, Option B):
pure presentation grouping of one turn's reasoning, non-question tool calls,
and intermediate assistant commentary into `TimelineWorkRow`s, with
user/system/final-assistant/`ask_user_questions`/unknown rows staying
top-level and flushing the group.

**Responsibilities**:
- group identity `agent-work:<turn_id>` (stable across streaming,
  draft→canonical reconciliation, and page-split prepend merges); legacy
  rows without `turn_id` group by contiguity under
  `agent-work:legacy:<first client_id>`; a boundary interleaved mid-turn
  produces suffixed segment ids (`:2`, …)
- `live` from the caller's `liveTurnId` (`agentState.active ? turn_id :
  null`, cleared by `final`) — no per-item heuristics, no between-tool
  flicker
- `currentItem`: the in-progress step (pending tool / draft reasoning) of a
  live group; null between steps and once the run ends
- `status`: session-local `final`-event outcomes (failed/canceled), else
  presence of a canonical final assistant row for the turn (`no_final`
  otherwise); legacy groups use the immediately following boundary row
- `durationMs` via `lib/agent-work-duration` (null while live)
- `createTimelineProjector()` reuses previous row OBJECTS when a row's
  inputs are unchanged so memoized React rows skip re-rendering during
  unrelated streams

### `agent-work-projection.test.ts`

Fixture-driven conformance (JSON fixtures in `__fixtures__/agent-work/`,
platform-neutral for sharing with mobile) plus identity tests: row-object
reuse across projections, draft→canonical group stability, single-row
live→summary transition.

### `__fixtures__/agent-work/*.json`

Language-neutral conformance fixtures ({messages, live_turn_id,
turn_outcomes, expected rows}) adapted from the mobile handoff's scenario
list: basic turn with duration union, intermediate sectioning, no-final,
failed, legacy contiguity + tool-duration fallback, split-turn merge,
question-row splitting, live current step, between-steps liveness.

### `question-response-submit.ts`

Pure async submit/reconciliation helper for pending `ask_user_questions` responses.

**Responsibilities**:
- submit `ask_user_questions_response_v1` payloads to the thread-scoped response route
- stop early with an auth-abort result when the transport reports an auth redirect
- keep live continuations on the existing agent stream path
- refresh latest transcript/runtime bootstrap for fallback and idempotent/already-answered responses
- centralize user-facing error message selection for failed submissions

### `question-response-submit.test.ts`

Node-runner coverage for structured question-response submission flow.

**Coverage**:
- live continuation submissions keep the stream connected
- fallback and already-answered submissions refresh latest bootstrap state
- auth-aborted and failed submissions report stable outcomes
- missing selected thread state fails locally without making a request

### `agent-stream-recovery.ts`

Pure recovery classifier for `useAgentStream(...)` error events.

**Responsibilities**:
- stop stream recovery when auth is gone
- keep explicit resync and stale-source callbacks from double-reconnecting
- distinguish native EventSource `CONNECTING` retries with a cursor from normal closed-source reconnects
- route stale-cursor native retries into bootstrap recovery instead of letting the browser reuse a known-bad `after` URL

### `agent-stream-recovery.test.ts`

Node-runner coverage for the agent stream error recovery classifier.

**Coverage**:
- auth expiry returns a terminal stop action
- `CONNECTING` errors with a cursor request bootstrap recovery
- cursorless native reconnects are ignored
- closed sources still use the normal manual reconnect path
- stale-thread and explicit-resync-suppressed callbacks are ignored

### `agent-state-error.ts`

Pure helper for applying `/agent/state.last_error` to route-owned composer error state.

**Responsibilities**:
- return the sanitized runtime failure message when `last_error` is present
- return `null` when a refresh should clear the composer error
- keep stream bootstrap recovery and route-level state refreshes using the same runtime-error policy

### `agent-state-error.test.ts`

Node-runner coverage for reading and clearing runtime agent error messages from `ApiAgentState`.

### `assistant-activity-indicator-state.ts`

Pure state helpers for the existing-thread route's timeline activity footer.

**Responsibilities**:
- seed the client-side activity gate from `/agent/state.draft_assistant` during initial load and stream resync
- suppress the generic thinking indicator while `agent.message_start` / `agent.message_delta` are actively filling a draft assistant row
- keep suppression through `agent.message_done`, then allow the route-owned delay timer to reveal the indicator again if the turn continues
- detect final persisted assistant rows from existing metadata such as `segment_kind: "final"` or `assistant_phase: "final_answer"` so final answers do not flash the generic indicator before `final`
- derive the final activity-indicator visibility from the current workbench status, active compaction override, and client-side suppression gate without requiring new backend events

**Exports**:
- `ASSISTANT_ACTIVITY_INDICATOR_RETURN_DELAY_MS`
- `createAssistantActivityGateFromAgentState(...)`
- `reduceAssistantActivityGate(...)`
- `deriveAssistantActivityIndicatorVisible(...)`
- `isFinalAssistantMessage(...)`

### `assistant-activity-indicator-state.test.ts`

Node-runner coverage for timeline activity-gate transitions.

**Coverage**:
- bootstrap with and without a draft assistant row
- assistant message start/delta suppression
- delayed reveal after `agent.message_done`
- stale message-done timer protection
- final vs intermediate persisted assistant-row detection
- final-event reset and compaction visibility override

### `model-context-view-state.ts`

Pure presentation for the Model view: `buildModelViewPresentation(doc, { modelLabel })`
turns an `ApiModelContext` into headline/subline, the tools summary, a
compaction banner, and one `ModelViewBlock` per message (label by provenance
+ role — "System prompt", "Runtime instruction", "Compaction summary",
"User", "Bud", "Tool call", "Tool result"; badge — prompt scope/version,
"not stored", "from checkpoint", "provider replay", "synthesized"; per-part
colors from `CONTEXT_CATEGORY_COLORS`; nested tool results flattened).

### `model-context-view-state.test.ts`

Node tests for labels/badges by provenance, part kinds and colors, nested
tool-result flattening, and the active-turn / budget headline variants.

### `compaction-row-state.ts`

Presentation for `role: "compaction"` transcript rows: `isCompactionMessage`,
`getCompactionRowPresentation(message)` → pill label/detail
("Mid-turn · 245k → 12k"), trimmed summary, checkpoint and compacted-through
ids; plus the shared `formatCompactionPhase` / `formatCompactTokens`
formatters (moved out of `chat-timeline.tsx`).

### `compaction-row-state.test.ts`

Presentation from a full row, tolerance for sparse/backfilled metadata, and
the formatters.

### `use-file-viewer.ts`

Thread-scoped file viewer state and fetch flow for user-clicked transcript paths.

**Responsibilities**:
- create file sessions through `POST /api/threads/:threadId/files/open`
- keep relative file entries keyed by workspace-relative path plus assistant source message id when available, so repeated same-message clicks can route back to a valid existing entry without reusing another message's historic cwd context
- key absolute POSIX opens by raw requested path while pending, then move successful opens to the daemon-normalized workspace-relative key returned by the backend
- recreate missing/expired sessions, including reload actions
- fetch file metadata with `HEAD` before `GET`
- enforce the 1 MiB display cap client-side from metadata and fetched bytes
- decode UTF-8, sniff unsupported binary content, and select Markdown/code/text rendering hints
- map edge response failures into viewer statuses (`invalid_path`, `not_found`, `denied`, `too_large`, `expired`, `offline`, `content_changed`, `unsupported_binary`, `error`)
- create one fresh session and retry when the daemon reports `content_changed`, such as a file mutating during read

**Exports**:
- `useFileViewer(...)`
- `FileViewerEntry`
- `FileViewerKind`
- `FileViewerStatus`

### `use-web-view.ts`

Thread-scoped proxied web-view state and hosted-auth bootstrap flow.

**Responsibilities**:
- load owned Bud proxied sites and the current thread's web-view attachment
- create or reuse an owned proxied site by loopback host/port/path
- attach an existing owned site to the current thread and detach without
  disabling the durable site
- mint one-time viewer grants for iframe and standalone viewing
- refresh iframe bootstrap URLs without exposing grants/cookies to agent tools
  or transcript rows
- leave tab-visibility lifecycle to the workbench presentation layer; normal
  Terminal/Web tab switches do not mint viewer grants
- treat explicit Web view reload as an authoritative site/thread attachment and
  proxy-transport refresh before applying a new iframe grant, so stale offline
  transport snapshots can recover after Bud reconnect
- track the Bud's HTTP proxy transport separately from WebSocket/HMR transport
  so the pane can explain static-preview vs HMR availability
- keep parent error callbacks behind a ref so the mount-time
  `proxied-sites`/`web-view` fetch effect is keyed to Bud/thread identity, not
  parent render identity
- open a standalone top-level window with a fresh grant so third-party cookie
  restrictions have a product fallback
- expose compact status/error state for `WebViewPane`
- expose top-level WebSocket transport readiness alongside the active site so
  product failure states can distinguish Bud offline, unsupported HMR, and
  degraded transport

**Exports**:
- `useWebView(...)`
- `WebViewStatus`

### `file-viewer-state.ts`

Pure file-viewer state helpers shared by the hook and tests.

**Responsibilities**:
- derive stable workspace file-viewer keys, including source-message identity when available
- derive pending keys for absolute POSIX opens before backend normalization
- build pending/session/reused entries
- map HTTP response codes to viewer statuses
- parse HEAD metadata
- decode UTF-8, detect likely binary content, choose viewer kind/language, and format byte limits

### `file-viewer-flow.ts`

Pure async file-viewer flow used by `use-file-viewer.ts`.

**Responsibilities**:
- lazily call `POST /api/threads/:threadId/files/open` only on explicit open requests
- reuse valid ready entries without new network calls when the source-aware key matches
- move successful absolute POSIX opens from raw pending keys to backend-normalized workspace keys
- run `HEAD` before `GET`
- resolve `file_url` to its path + query (`fileSessionRequestPath`) so file
  bytes route through the browser's own API transport — the server mints the
  URL from ITS `APP_BASE_URL`, which the browsing origin may not reach
  (HTTP dev vs HTTPS-local Caddy profile, or deployed base-URL drift)
- retry once with a fresh file session when `HEAD` or `GET` reports `content_changed`
- enforce display caps before and after content fetch
- map file-edge failures and binary/text states into `FileViewerEntry` updates
- abort quietly only while a login redirect is pending (argless
  `shouldAbortForUnauthorized()`); a bare 401 on file bytes surfaces as an
  error instead of pinning the pane on "Reading metadata"

### `file-viewer-flow.test.ts`

Node-runner coverage for the file-viewer open/fetch flow.

**Coverage**:
- session creation followed by `HEAD` then `GET`
- origin-stripping of absolute `file_url` values (path + query preserved)
- valid ready entry reuse without network calls
- same relative path from a different source message creates a fresh session
- absolute POSIX opens send raw paths and normalize to backend workspace keys
- content-changed responses create one fresh session and retry the read path
- metadata over-cap state without content fetch
- binary detection and HTTP-status-to-viewer-state mapping

## Dependencies

| Import | Purpose |
|--------|---------|
| `react` | Hook state, refs, memoization |
| `@/lib/transport` | Paginated message fetch |
| `@/lib/messages` | Optimistic `client_id` generation |
| `@/lib/api-types` | Thread message, agent-state, file-viewer, and proxied web-view contracts |
| `@/lib/file-paths` | File-open candidate payload types |

### `use-agent-stream.ts`

Agent SSE ownership for the existing-thread route.

**Responsibilities**:
- attach to `/api/threads/:threadId/agent/stream`
- resume from the latest known stream cursor
- monitor heartbeats and reconnect stale/closed streams
- dedupe reconnect scheduling and heartbeat watchdog installation so browser-managed EventSource reconnects do not stack multiple stale-watch intervals inside one hook instance, and suppress stale-heartbeat escalation while the browser is already reconnecting the source
- handle explicit `agent.resync_required` by calling back into a route-provided bootstrap refresh
- detect native EventSource `CONNECTING` error loops with a resume cursor, close the browser-managed source, refresh `/messages` + `/agent/state`, and reconnect with a fresh cursor so service restarts do not retry one stale `after` URL forever
- apply refreshed `/agent/state.last_error` after bootstrap recovery so missed fast failure events remain visible in the composer error slot
- parse `agent.tool_call`, `agent.tool_result`, `agent.message_*`, `agent.reasoning_*`, `agent.compaction_*`, `thread.title`, and `final` events
- map live `ask_user_questions` tool calls to the route's `waiting_for_user` UI status, and live `terminal.wait` tool calls to `waiting_for_terminal`, instead of the generic streaming state
- pass `agent.tool_call.started_at` through to message-state reconciliation for pending prompt ordering
- pass `agent.message_start.started_at`, `agent.message_done.started_at`, `agent.message_done.finished_at`, `agent.message_done.duration_ms`, and `agent.message_done.duration_source` through the stream parser as additive timing metadata
- accept `agent.message` for both intermediate assistant text segments and final assistant rows
- accept `agent.reasoning_done` as the canonical persisted `role: "reasoning"` row for a visible provider reasoning segment
- tolerate additive timing fields such as `started_at`, `finished_at`, `duration_ms`, and `duration_source` on assistant and tool events
- pass through terminal tool args exactly as the service emits them (model-facing; `terminal.wait` carries `until?`)
- pass through `ask_user_questions` request args unchanged so the timeline can render the pending form and submit through the thread route
- pass through visible provider reasoning start/delta/done events to the transcript state hook
- pass through automatic context-compaction start/done/failure events to the route for live activity text, non-transcript timeline markers, immediate post-compaction budget snapshots when present, and budget refresh fallback after successful compaction
- emit narrow callback events to the route/message feature modules instead of mutating route-local state directly
- keep latest event handlers in refs so the EventSource lifecycle depends on
  `threadId` rather than callback identity churn from the composing route

**Exports**:
- `useAgentStream(...)`

**Route contract**:
- the route still owns the initial loader fetches plus the top-level `status`/`error` state
- the route maps `/agent/state.phase === "waiting_for_user"` and live `ask_user_questions` tool calls to `waiting_for_user`, and `/agent/state.phase === "waiting_for_terminal"` / live `terminal.wait` calls to `waiting_for_terminal`, keeping global loading indicators separate from paused human input and idle terminal waits
- the route owns context budget refresh from `/agent/state`; successful compaction stream events may also carry an additive post-compaction `context_budget` snapshot that the route can apply immediately before the normal refresh fallback
- the hook owns EventSource lifecycle, cursor tracking, reconnect behavior, and event parsing

### `thread-stream-timing.ts`

Pure reconnect/heartbeat timing helpers shared by the agent and terminal stream hooks.

**Responsibilities**:
- reconnect backoff calculation
- development vs production heartbeat/check interval policy, derived from the
  service SSE heartbeat cadence (5s prod / 1s dev, see
  `service/src/routes/threads/*.ts`) times a watchdog multiplier that must stay
  ≥ 2.5× so one late heartbeat never triggers a false reconnect
- the former `shouldTreatTerminalStatusAsStale` 5s status-staleness heuristic
  equaled the production heartbeat interval exactly and caused spurious
  terminal reconnects; it was deleted. Stream reconnects are driven only by
  EventSource errors and the missed-heartbeat watchdog. The agent stream's
  effective values are unchanged (prod 15s timeout / 5s check, dev 3s / 1s)

**Exports**:
- `THREAD_STREAM_HEARTBEAT_INTERVAL_MS` / `THREAD_STREAM_DEV_HEARTBEAT_INTERVAL_MS`
- `THREAD_STREAM_HEARTBEAT_TIMEOUT_MULTIPLIER`
- `getThreadStreamReconnectDelay(...)`
- `getThreadStreamHeartbeatConfig(...)`
- `hasMissedThreadStreamHeartbeat(...)`

### `thread-stream-timing.test.ts`

Node-runner coverage for reconnect delay, heartbeat-cadence-derived watchdog
thresholds (including the ≥ 2.5× invariant and agent-stream value stability),
and the missed-heartbeat boundary.

### `terminal-resume.ts`

Pure helpers for offset-based terminal stream resume and snapshot planning.

**Responsibilities**:
- decide snapshot vs resume per (re)connect: full snapshot only on initial
  mount (no applied offset), an `output_gap` terminal.event, or a bud
  offline→online transition; otherwise resume with `?from_offset=` and no
  `term.reset()`
- resolve each `terminal.output` event's end offset from the SSE event id
  (server-stamped `byte_offset + decoded length`), falling back to
  `byte_offset + decodedByteLength` when the id is absent/non-numeric
- keep the applied offset monotonic across replayed/duplicate events
- build the terminal stream path with the resume cursor
- compose snapshot text (emulator scrollback lines above the visible screen)

**Exports**:
- `planTerminalConnect(...)`
- `resolveOutputEndOffset(...)`
- `advanceAppliedOffset(...)`
- `buildTerminalStreamPath(...)`
- `buildTerminalSnapshotText(...)`

### `terminal-resume.test.ts`

Node-runner coverage for connect planning, event-id/byte-offset end-offset
resolution, monotonic cursor advancement, stream-path construction, and
snapshot text composition.

### `terminal-input-queue.ts`

Pure queue policy for terminal input typed while the terminal is disconnected.

**Responsibilities**:
- queue input chunks in order up to `TERMINAL_INPUT_QUEUE_MAX_BYTES` (8 KiB)
- drop the oldest queued chunks beyond the cap (trimming a single oversized
  chunk to its tail on a UTF-8 code point boundary) and report dropped bytes
- drain the queue as one ordered payload for flush-on-reconnect

### `terminal-input-queue.test.ts`

Node-runner coverage for ordered accumulation, drop-oldest overflow, oversized
single-chunk tail trimming, and UTF-8 boundary safety.

### `terminal-grid-state.ts`

Grid-sync client reducer (plan/terminal-grid-sync phase 2): applies
`terminal.grid` frames (proto §6.8.2) — full seeds, contiguous deltas patch
rows, §6.8.5 `row_shift` frames splice the viewport (identity-preserving for
row memoization) before dirty rows apply, generation gaps/size mismatches
return a `discontinuity` signal, full frames recover from anything
(recording a scrollback seam across missed generations). Dirty rows (and
full-frame rewrites at unchanged geometry) preserve the previous row-array
identity when content is run-for-run equal (`gridRowsEqual`) so row
memoization leaves unchanged DOM — and native selection in it — untouched;
`scrollbackStart` tracks the absolute index of `scrollback[0]` across cap
trims for stable renderer keys. The cursor carries
optional DECSCUSR `shape`/`blink` facts (§6.8.6). Accumulates scrollback pushes (capped 5000, drops counted),
seeds scrollback from snapshot `history_text`, and resolves run colors
(named/256/truecolor) to CSS. Pure; node-tested in
`terminal-grid-state.test.ts`.

### `terminal-renderer.ts`

Terminal renderer selection: `?renderer=` URL override →
`localStorage["bud.terminal.renderer"]` → `grid` default. Resolved once per
mount.

### `terminal-prediction.ts`

Predictive local echo engine (grid-sync phase 3, §6.8.3): pure ghost-tail
state — printable bursts accumulate as pending ghost text, backspace edits the
unflushed tail, every input flush assigns a client seq, frames'
`applied_input_seq` retire covered chunks, and anything unpredictable
(control keys, Enter, gate closure, failed posts, reconnects) clears all
ghosts. Node-tested in `terminal-prediction.test.ts`.

### `terminal-mouse.ts`

Mouse event encoding for the grid renderer (§6.8.4): SGR (preferred) and
legacy X10 (coordinates clamped to the UTF-8-safe range), modifier bits,
wheel buttons, the alternate-scroll arrow fallback, and the DECCKM SS3
rewrite for cursor keys. Pure; node-tested in `terminal-mouse.test.ts`.

### `terminal-command-state.ts`

Pure reducer for the terminal pane's command lifecycle chip, driven by typed
`terminal.event` payloads (no heuristic activity inference): `command_started`
→ running, `command_finished` → exit code (persists until the next command),
`child_exited` → cleared, all other events pass through unchanged.

### `terminal-command-state.test.ts`

Node-runner coverage for command lifecycle transitions, exit-code handling,
chip persistence/supersession, child-exit clearing, and malformed-payload
tolerance.

### `terminal-interrupt.ts`

`showTerminalInterrupt`: fact-gated visibility for the contextual Interrupt
(Ctrl+C) affordance. Precedence: full-screen suppression first — alt screen
(grid fact) or `tui` mode (event fact, bytes renderer) hides it even while
the launching command is still open (a TUI launched as a command keeps the
chip `running` for its whole run; Ctrl+C there is a keystroke, not "stop").
Then an open command shows it (both renderers); then, with grid frames
seeded, the closed predictive-echo gate (`!predict_ok`) shows it — covering
busy REPLs, `unknown` mode, and password prompts. Hidden at idle prompts,
when disconnected, and on the bytes renderer without an open command. Pure;
node-tested in `terminal-interrupt.test.ts`.

### `use-terminal-session.ts`

Terminal session/xterm ownership for the existing-thread route.

**Responsibilities**:
- initialize and dispose the xterm instance plus `FitAddon`
- translate browser keyboard/paste events into explicit terminal input bytes
- batch terminal input and post resize/input mutations to thread-scoped terminal endpoints
- queue typed input while disconnected (bounded drop-oldest policy via
  `terminal-input-queue.ts`), flush it in order on reconnect, and surface an
  `terminalInputQueued` state instead of silently discarding keystrokes
- create or reuse the terminal session record, then establish the view per the
  `terminal-resume.ts` plan: on initial mount / `output_gap` / bud
  offline→online, fetch `GET /terminal/snapshot?lines=1000` (emulator
  scrollback + visible screen), `term.reset()`, render it, and open the SSE
  stream at `?from_offset=<ring_next_offset>`
- on routine reconnects, resume the SSE stream from the highest applied output
  end-offset (tracked via `terminal.output` SSE event ids) with no
  `term.reset()` and no snapshot — the server replays the missed range on one
  ordered stream
- fall back to the legacy byte-tail history replay
  (`/terminal/history?bytes=131072`, with its truncation banner) only when the
  snapshot endpoint is unavailable; the snapshot path clears the banner
- decode streamed `terminal.output` chunks through one persistent streaming
  `TextDecoder` per SSE connection (`createTerminalStreamDecoder`), reset on
  `term.reset()` and on each new connection, fixing UTF-8 chunk-boundary
  corruption
- recover the daemon-side PTY through `terminal/ensure` (idempotent, no
  history replay of its own)
- reconnect only on EventSource errors and the missed-heartbeat watchdog (the
  5s status-staleness heuristic is gone)
- reduce typed `terminal.event` payloads into session facts (`mode_changed`)
  and the command lifecycle chip (`command_started` / `command_finished` /
  `child_exited`); `output_gap` forces a re-snapshot reconnect
- expose narrow terminal UI state such as connection status, session facts,
  command chip, queued-input flag, truncation, and disconnect overlay
  visibility
- renderer selection (grid-sync phase 2): `terminal-renderer.ts` resolves
  `grid` (default) vs `bytes` (legacy xterm fallback) once per mount. In grid mode xterm is
  never instantiated; the SSE stream connects with `?grid=1` and no
  `from_offset`, `terminal.grid` frames reduce through
  `terminal-grid-state.ts` (discontinuity ⇒ reconnect; the watch re-arm
  ships a fresh full frame), the snapshot seeds scrollback only, and
  `terminal.output` counts only as stream liveness
- input POSTs are strictly serialized through a promise chain: concurrent
  fetches ride parallel HTTP connections and can arrive out of order,
  reordering typed bytes at the PTY (surfaced by leading-edge per-keystroke
  flushing; the E2E's intermittent "perl- e" command corruption was this)
- predictive echo (§6.8.3): keystrokes ghost via `terminal-prediction.ts`
  while the latest frame's `predict_ok` gate is open; flushes carry `seq` on
  the input POST; frame `applied_input_seq` retires chunks; the hook exposes
  `terminalPredictionGhost` for the grid pane

**Exports**:
- `useTerminalSession(...)` (returns `terminalRenderer`, `terminalGridState`,
  `sendTerminalInput`, `sendTerminalResize` for the grid pane)
- `TerminalConnectionState`
- `TerminalSessionFacts` / `TerminalMode` / `TerminalIntegration`
- `TerminalCommandChip` (re-export)

**Route contract**:
- the route still owns terminal-specific presentation such as the overlays, status bar, and terminal menu wiring
- the hook owns xterm lifecycle, terminal transport, reconnect policy, and Bud online/offline recovery behavior

## TODO

- Add deeper hook/integration coverage for transcript reconciliation flows beyond the extracted pure helper tests
- Add deeper hook/integration coverage for agent-stream heartbeat timeout, reconnect, and explicit resync-required behavior
- Add deeper hook/integration coverage for terminal reconnect/recovery behavior beyond the shared timing policy tests
- Add browser-level visual regression coverage for terminal/file-viewer overlay, header, and xterm geometry behavior

---

*Referenced by: [../features.spec.md](../features.spec.md)*
