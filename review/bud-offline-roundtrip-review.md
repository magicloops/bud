# Review: Bud Offline Roundtrip Behavior

Date: 2026-05-28

## Scope

This review follows the message-send path for the recently added behavior where a user can keep messaging the agent while the selected Bud daemon is offline. I use "primary agent LLM call" to mean `AgentModelRunner.invokeModel(...)`; there can be earlier or concurrent LLM calls for context sync, compaction, or thread title generation.

## High-Level Finding

The offline path is mostly a tool-availability and preflight-skip behavior, not a separate agent pipeline. The same message endpoint still authenticates the viewer, writes the user message, starts a runtime turn, loads conversation history, may compact context, and calls the agent model. The key difference is that Bud-dependent work is skipped when the environment snapshot is `bud_offline`.

The service does not perform a fresh daemon probe when sending a message. Environment resolution reads the Bud row for identity/reporting data and asks the in-process daemon transport/session tracker whether the Bud is currently online. If the tracker says offline, the send path avoids terminal context sync, cached path context, terminal session ensure, and Bud-specific tools.

## Recommended Direction

The default should be to skip request-time context sync before the primary agent LLM call. Keeping the user-to-assistant roundtrip snappy is more important than preemptively saving an occasional later tool call, especially for high-volume conversational turns where the terminal may not be relevant.

Instead of grabbing terminal state from the Bud, the service can give the model a cheap freshness hint when local server state indicates terminal activity changed since the last terminal tool result or injected terminal snapshot. The hint should be advisory rather than a forced daemon roundtrip:

> Terminal activity has changed since the last terminal tool result. The service did not inspect the current terminal state before this response. If the answer or next action depends on the current terminal, call `terminal.observe` before making device-specific claims or acting on terminal state.

This preserves the main benefit of context sync, which is warning the model about potentially stale terminal context, while moving the expensive Bud roundtrip into the agent turn only when the model decides current terminal state matters.

Reasonable policy shape:

1. Default to no pre-LLM `terminal_observe`.
2. Compute a cheap "terminal may have changed" flag from service-side state such as terminal output byte offsets, session last-activity timestamps, readiness state, cached cwd changes, terminal status events, or human-origin terminal input logs.
3. Add a transient model instruction/hint when that flag is true. Prefer transient prompt context over persisted system messages unless the service has actually observed concrete terminal content.
4. Let the model call `terminal.observe` when terminal freshness matters.
5. Keep a narrow escape hatch for forced pre-observe only if later evidence shows specific classes of user messages routinely fail without it.

The main tradeoff is that terminal-dependent tasks may sometimes need one additional model/tool/model loop. That is acceptable when the goal is low latency for ordinary chat, because larger device-work turns can absorb longer agent execution while the initial user response path stays thin.

## Client Roundtrips

Existing thread load:

1. Browser loader sends `GET /api/threads/:thread_id/messages`, `GET /api/threads/:thread_id/agent/state`, and `GET /api/threads/:thread_id` in parallel.
2. `GET /agent/state` authorizes the thread, reads the runtime snapshot, recomputes environment from DB plus transport state, and returns that environment to the UI. It does not ping the daemon.

Existing thread send:

1. Browser sends `POST /api/threads/:thread_id/messages`.
2. The service queues/starts the agent turn and returns `201` with the persisted user message plus `agent.started`, `agent.mode`, `agent.bud_status`, and `agent.stream_cursor`.
3. After the POST resolves, the browser calls `GET /api/threads/:thread_id/agent/state` and then ensures the SSE stream is connected. These are UI convergence requests, not prerequisites for the primary model call.

New thread send:

1. Browser sends `POST /api/threads`.
2. Browser sends `POST /api/threads/:thread_id/messages`.
3. Browser navigates to the new thread route, whose loader then performs the existing-thread parallel reads.

## Send Path Before Agent Startup

`POST /api/threads/:thread_id/messages` does this before `AgentService.startUserMessage(...)`:

1. Parse request and authorize the thread for the signed-in viewer.
2. Resolve effective model and reasoning effort.
3. Look up an existing same-thread, same-viewer user message by `client_id`; duplicate retries return early and do not start another agent turn.
4. Supersede pending structured question requests for the thread.
5. Persist thread model/reasoning preferences when needed.
6. Resolve the Bud environment from the Bud DB row and the daemon transport tracker.
7. Look up an open terminal session for the thread.
8. If a session exists and the environment is normal, run terminal context sync unless an agent is already active.
9. If the environment is normal, attach cached path context from the terminal session row when a cached `cwd` exists.
10. Insert the user message and update thread message metadata.
11. Start the agent turn.

Two timing details are easy to miss:

- The POST response is sent after the runtime turn is started, but the actual primary agent LLM call happens inside the async `runAgentFlow(...)`.
- On the first message of a thread, title generation can be kicked off as a separate background LLM task after the agent turn is started. It is not a prerequisite for the agent model request.

## Online Path Before The Primary Agent LLM

When the Bud is online, the route may contact the daemon before the user message is inserted, but only if there is already an open terminal session for the thread.

Established-session online path:

1. Environment resolves as `normal`.
2. If there is an open terminal session and no active agent turn, context sync calls `capturePane(...)`.
3. `capturePane(...)` sends a `terminal_observe` frame to the Bud with `view: "history"`, `wait_for: "none"`, and a recent-line window. The context sync caller asks for `startLine: -30` with a 3000 ms timeout.
4. The observe result gives the service current terminal text and may include current host cwd/readiness data. The service hashes the capture, compares it with the previous snapshot, and may ask a smaller LLM to summarize the state change before inserting a system/context message.
5. The route reads cached terminal path context from `terminal_session.cwd` and includes it in user-message metadata. This is DB-backed cached data, not a request-time daemon read.
6. The user message is inserted and the agent turn is started.
7. `startUserMessage(...)` calls `getOrCreateSession(...)` because the environment is normal. If the DB session is already `ready`, `active`, or `idle` and the Bud is online, this is only a DB/session-state check. If the session is pending/creating or newly inserted, the service sends `terminal_ensure` to the Bud and marks the DB session as `creating`.
8. `runAgentFlow(...)` loads the conversation, may compact the conversation if the context budget requires it, refreshes the environment again, resolves tools for that environment, appends the environment instruction when needed, and then calls the primary model.

New/no-session online path:

1. The route has no open terminal session, so there is no pre-message `terminal_observe` and no context sync.
2. `startUserMessage(...)` creates or finds the terminal session record and sends `terminal_ensure` if needed.
3. The model can be called before the terminal has become ready; readiness is handled through later terminal tool calls and runtime events.

## Offline Path Before The Primary Agent LLM

When the Bud is offline, the service still accepts and persists the message, but it deliberately avoids request-time daemon work:

1. Environment resolves as `bud_offline`.
2. The route may still query the DB for an open terminal session, but it skips context sync.
3. The route does not attach path context, because `getPathContextForThread(...)` is only called in normal mode.
4. The user message is inserted and thread metadata is updated.
5. `startUserMessage(...)` starts a runtime turn with the offline environment but skips `getOrCreateSession(...)`, so it does not create/resume a terminal session and does not send `terminal_ensure`.
6. `runAgentFlow(...)` still loads conversation history and may run context compaction before the primary model call.
7. Immediately before each provider step, the agent refreshes environment again. If the Bud is still offline, Bud-specific tools are filtered out and the offline instruction is appended. If the Bud reconnected between the HTTP route's environment capture and the provider step, the agent can promote back to normal mode and may ensure a session before calling the model.

In the steady offline case, no data is grabbed from the Bud before the primary model call.

## Data Grabbed From Bud

Presence data learned outside the send request:

- On `hello`, the service updates the Bud DB row with installation id, status, last seen time, name, OS, architecture, version, and capabilities, registers the active session, sends `hello_ack`, and emits Bud-online events for terminal sessions.
- On heartbeat, the service updates the active tracker timestamp and periodically writes `bud.last_seen_at`.
- On disconnect, the service rejects pending terminal requests, clears terminal caches/buffers, suspends sessions, emits Bud-offline events, and updates the Bud DB row to `offline`.

Request-time online data:

- `terminal_observe` during context sync returns current terminal history/screen text for the session, and may carry current cwd/readiness metadata depending on the daemon result.
- `terminal_ensure` is sent when a terminal session must be created/resumed. That is a control request, not a data capture; the service does not wait for full terminal readiness before the agent model can run.
- Cached `cwd` path context comes from DB state populated by earlier daemon status/send/observe flows. It is not freshly grabbed from Bud during message send.

Request-time offline data:

- None. The route uses DB state and the in-process transport tracker, skips Bud-dependent reads, and starts the agent with Bud tools unavailable.

## Roundtrip Comparison

| Step | Online Bud | Offline Bud |
| --- | --- | --- |
| Browser load | Messages, agent state, thread in parallel | Same |
| Browser send | `POST /messages` | Same |
| Auth/resource lookup | Viewer + authorized thread DB reads | Same |
| Model selection and duplicate check | DB reads/writes as needed | Same |
| Environment resolution | Bud DB row + transport tracker | Same, but tracker says offline |
| Existing terminal context sync | Sends `terminal_observe` to Bud; DB snapshot read/write; optional summary LLM + context message | Skipped |
| Path context | Reads cached `terminal_session.cwd` from DB | Skipped |
| User message persistence | Insert message; update thread metadata | Same |
| Session ensure before async run | DB session lookup/insert; maybe `terminal_ensure` to Bud | Skipped |
| Conversation load | DB read/reconstruction | Same |
| Pre-turn compaction | Possible compaction LLM + DB checkpoint | Same |
| Provider-step env refresh | Bud DB row + transport tracker; maybe session ensure if no session | Same refresh; if still offline, no session ensure |
| Tool catalog | Terminal, observe, web view, ask-user tools | Bud-specific tools removed; ask-user remains |
| Primary model call | Normal tool set unless environment changes | Offline instruction and reduced tool set unless Bud reconnected |

## Observations And Risks

1. Online sends can do more blocking work before the user message is inserted. A stale but online terminal session can trigger a daemon observe roundtrip and possibly a summary LLM call before the route persists the user message. Offline sends skip that path, so latency and failure modes differ.
2. Environment truth is process-local. `isBudOnline(...)` comes from active WebSocket/gRPC router state, not from an immediate network probe. If the active tracker is stale or the service instance handling the request does not own the Bud connection, the route can classify the Bud differently from what the user expects.
3. `bud.last_seen_at` is updated on disconnect when marking the Bud offline, so it is not strictly "last successful heartbeat" once offline. It is currently better read as "last presence state write."
4. The offline prompt is appended, and Bud-specific tools are filtered, but the base system prompt still contains general persistent-terminal/tool guidance. The filtering enforces behavior, but the prompt may be noisier than necessary in offline mode.
5. Context-budget estimation still uses `AGENT_TOOL_SCHEMA_TOKENS` for the full tool catalog, even when the offline catalog has fewer tools. Offline turns may compact earlier than needed.
6. Runtime environment changes are reflected through `/agent/state` and normal stream/runtime events, but there is not a dedicated environment-change SSE event. A reconnect/disconnect during a turn can therefore require a state refresh or another event to converge the UI.
7. Duplicate `client_id` retries return the existing user message without the `agent` metadata returned on a fresh insert. The client currently converges through `/agent/state`, but mobile or other clients need to follow the same pattern.
8. Replacing context sync with a freshness hint depends on the model respecting that hint. Tool filtering prevents impossible offline tool use, but stale online terminal reasoning is still a prompt-following problem unless terminal-dependent tasks are routed through an explicit observe-first policy.
9. If freshness hints are transient only, transcript continuity changes. The conversation will record concrete terminal content only when the model calls `terminal.observe` or `terminal.send`; out-of-band changes that never become relevant will not be persisted as context messages.

## Source Map

- Browser existing-thread loader: `web/src/routes/$budId/$threadId.tsx:61`
- Browser existing-thread send flow: `web/src/routes/$budId/$threadId.tsx:627`
- Browser new-thread send flow: `web/src/routes/$budId/new.tsx:135`
- Agent state route: `service/src/routes/threads/agent.ts:119`
- Message send route: `service/src/routes/threads/messages.ts:173`
- Authorized thread access: `service/src/routes/threads/shared.ts:249`, `service/src/auth/session.ts:341`
- Environment snapshot and offline instruction: `service/src/agent/environment.ts:20`
- Tool filtering for offline mode: `service/src/agent/tool-definitions.ts:220`
- Agent start and pre-provider flow: `service/src/agent/agent-service.ts:125`, `service/src/agent/agent-service.ts:397`, `service/src/agent/agent-service.ts:860`
- Context sync capture: `service/src/terminal/context-sync-service.ts:63`
- Terminal observe dispatch: `service/src/runtime/terminal/request-dispatcher.ts:173`
- Terminal ensure behavior: `service/src/runtime/terminal/session-store.ts:86`
- Cached path context: `service/src/runtime/terminal-session-manager.ts:161`
- Composite daemon online/send behavior: `service/src/transport/composite-daemon-router.ts:28`
- WebSocket active-session tracker: `service/src/ws/session-trackers.ts:71`
- Bud hello/heartbeat/offline transitions: `service/src/ws/bud-connection.ts:518`, `service/src/ws/bud-connection.ts:565`, `service/src/ws/bud-connection.ts:934`
