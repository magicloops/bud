# Design: Terminal Human Input Boundaries And Replay Semantics

Status: Draft

Audience: Web, service, daemon

Last updated: 2026-04-10

Related:
- [`debug/thread-terminal-1-2c-da-replay.md`](../debug/thread-terminal-1-2c-da-replay.md)
- [`reference/unknown-terminal-input.md`](../reference/unknown-terminal-input.md)
- [`design/terminal-command-and-interaction-contract.md`](./terminal-command-and-interaction-contract.md)
- [`design/terminal-send-confirmation-and-fast-observe.md`](./terminal-send-confirmation-and-fast-observe.md)
- [`design/terminal-delta-observation-and-minimal-tool-payloads.md`](./terminal-delta-observation-and-minimal-tool-payloads.md)
- [`design/mobile-agent-stream-attach-semantics.md`](./mobile-agent-stream-attach-semantics.md)

## 1. Goal

Eliminate the class of bugs where browser terminal output, browser terminal protocol responses, and human keystrokes are all treated as the same transport.

The immediate symptom is the thread-view `1;2c` issue. The broader problem is that the current web terminal contract collapses three different things into one channel:

1. human-originated input
2. emulator-generated protocol replies
3. replayed or restored terminal output

The design goal is to separate those concerns cleanly enough that:

- restored output can never be mistaken for user input
- emulator protocol traffic is never logged or handled as human input
- reconnect and reopen flows have explicit replay semantics
- future xterm protocol features do not create new variants of the same bug

## 2. Review Summary

The current thread-view implementation is clear:

- the web route subscribes to `term.onData(...)` and forwards every emitted string to `POST /api/threads/:thread_id/terminal/input`: [`web/src/routes/$budId/$threadId.tsx`](../web/src/routes/$budId/$threadId.tsx)
- the same route restores terminal state by replaying `/terminal/history` back into xterm with `term.write(...)`: [`web/src/routes/$budId/$threadId.tsx`](../web/src/routes/$budId/$threadId.tsx)
- xterm emits Primary Device Attributes replies such as `ESC[?1;2c` through the same `triggerDataEvent(...)` path used for outbound terminal data: [`web/node_modules/xterm/src/common/InputHandler.ts`](../web/node_modules/xterm/src/common/InputHandler.ts)
- xterm also uses that same path for focus and window-report responses: [`web/node_modules/xterm/src/browser/Terminal.ts`](../web/node_modules/xterm/src/browser/Terminal.ts)
- the service and daemon currently preserve those bytes; they do not distinguish "human keystroke" from "browser emulator response": [`service/src/routes/threads.ts`](../service/src/routes/threads.ts), [`service/src/runtime/terminal-session-manager.ts`](../service/src/runtime/terminal-session-manager.ts), [`bud/src/main.rs`](../bud/src/main.rs)
- terminal reconnect also has overlapping replay sources today:
  - in-memory SSE replay when no terminal `lastEventId` is supplied
  - persisted `/terminal/history` replay on reconnect/open

So the design problem is not "xterm emitted a weird sequence once." The problem is that the browser transport boundary is modeled incorrectly.

## 3. Problem Statement

`term.onData(...)` is currently being treated as "what the human typed."

That is not a safe assumption.

In practice, the current browser terminal has one overloaded outbound channel carrying:

- real human text entry
- real human special keys
- real human paste and IME commits
- xterm-generated protocol replies
- any protocol replies triggered while replaying old output into the parser

That creates four classes of failure:

### 3.1 Human-input misclassification

The backend logs, authorizes, and forwards browser-originated terminal input as if it all came from the human. That is already wrong for DA replies and would also be wrong for DSR, focus reporting, window reports, and similar emulator-originated traffic.

### 3.2 Restore/replay feedback loops

When restored output is fed back through xterm, xterm can emit protocol replies in response. Those replies then go back upstream as fresh input. This is the current `1;2c` mechanism.

### 3.3 Duplicate replay and repeated side effects

The terminal reconnect path currently replays both:

- in-memory SSE output
- durable `/terminal/history`

That means replay side effects can occur multiple times per reopen or reconnect.

### 3.4 Audit and ownership inaccuracies

The service currently stamps browser terminal input as human-originated input. That is appropriate for keystrokes and paste. It is not appropriate for emulator protocol responses.

Even if the byte stream is technically valid terminal input, it should not be logged as "the user typed this."

## 4. Design Principles

- Human terminal input must be explicit at the browser boundary.
- Emulator protocol replies must be explicit at the browser boundary.
- Terminal restore/bootstrap must be explicit and replay-safe.
- The browser should have one source of truth for live output and one separate source of truth for bootstrap state.
- No-cursor attach should not mean "replay everything we still have."
- The browser should not rebuild a safe terminal restore by feeding old raw control bytes back into xterm and hoping the parser behaves.
- Agent and human terminal input contracts should converge where practical instead of maintaining two unrelated input models.
- The service should preserve user ownership and audit semantics without conflating human actions and emulator mechanics.

Short version:

- input is not output
- human input is not emulator protocol
- bootstrap is not replay

## 5. Recommendation

### 5.1 Introduce An Explicit Browser Terminal Transport Boundary

The web client should stop wiring public `term.onData(...)` directly to `/terminal/input`.

Instead, the browser should own a small transport layer that classifies outbound terminal traffic into two explicit streams:

1. `human_input`
2. `emulator_protocol`

That boundary should live in one module, not inside the thread route itself.

Suggested web shape:

- add a dedicated `TerminalTransportController`
- the controller owns the xterm instance's outbound integration
- the thread route only consumes:
  - `controller.sendHumanInput(...)`
  - `controller.sendProtocolResponse(...)`
  - `controller.writeLiveOutput(...)`
  - `controller.restoreSnapshot(...)`

The critical design change is that the route no longer assumes "whatever xterm emitted must be what the human typed."

### 5.2 Split Human Input From Emulator Protocol At The xterm Boundary

xterm already distinguishes those concepts internally through `triggerDataEvent(data, wasUserInput)`.

That means the web layer should expose the distinction explicitly instead of relying on the flattened public `onData(...)` API.

Recommended implementation direction:

- isolate one thin xterm adapter module that can observe or wrap internal xterm data emission and recover the `wasUserInput` distinction
- route `wasUserInput === true` traffic into the human input path
- route `wasUserInput === false` traffic into the emulator protocol path
- keep that internal xterm dependency in one file with focused tests so xterm upgrades are contained

This is a pragmatic boundary, not a product-facing contract. If xterm later exposes a public API for this, we can swap the implementation without changing the rest of the app.

### 5.3 Do Not Treat Emulator Protocol Replies As Human Input

The system should not simply drop non-human traffic. Some terminal programs may legitimately rely on terminal capability queries and replies.

The right fix is separation, not blanket suppression.

Recommended service/daemon model:

- `human_input` remains user-attributed
- `emulator_protocol` is machine-attributed
- both can still result in bytes being sent to the tmux session
- only `human_input` is logged as human-originated terminal input
- `emulator_protocol` can be allowlisted, rate-limited, or dropped during restore/bootstrap windows

This gives us correct semantics for:

- DA / DSR replies
- focus reports
- window reports
- any future xterm-generated terminal-protocol output

without incorrectly claiming the user typed those bytes.

### 5.4 Add A Browser-Facing Structured Input Route Backed By The Existing Send Path

The browser should stop using the low-level legacy `/terminal/input` route as its normal interactive transport.

Instead, it should use a browser-facing structured input surface backed by the same Bud-side send machinery that already exists for the agent.

Recommended target contract:

- `POST /api/threads/:thread_id/terminal/send`

Illustrative request:

```json
{
  "text": "git status",
  "submit": true,
  "keys": []
}
```

Illustrative key-only request:

```json
{
  "keys": ["Up"]
}
```

Illustrative mixed request:

```json
{
  "text": "y",
  "submit": true
}
```

Why this matters:

- it aligns the browser and agent with one structured input contract
- it removes the need for the thread view to POST arbitrary raw data as if it were all human text
- it gives the service and daemon one long-term place to evolve key handling and submit semantics

### 5.5 Keep A Narrow Raw-Bytes Escape Hatch For Compatibility

The structured route should be the end-state contract, but we should not assume we can model every browser input case perfectly on day one.

There are still difficult input categories:

- IME composition edge cases
- bracketed paste behavior
- some Alt/Meta combinations
- terminal-specific encoded sequences

So the pragmatic rollout is:

1. stop the direct `onData -> /terminal/input` pipe
2. add explicit classification first
3. move common browser input to structured `terminal/send`
4. keep a narrow, source-tagged raw-bytes path as an internal escape hatch until structured coverage is complete

The important change is that even raw bytes are no longer treated as automatically human. They are carried with explicit origin.

### 5.6 Introduce Terminal State Bootstrap Separate From Live Output Replay

The browser currently restores terminal state by replaying raw `/terminal/history` bytes into xterm.

That is the wrong bootstrap model.

We should separate:

1. bootstrap state
2. live output stream

Recommended new route:

- `GET /api/threads/:thread_id/terminal/state`

Illustrative response:

```json
{
  "session_id": "bud-123-thread-456",
  "state": "ready",
  "bud_status": "online",
  "readiness": {
    "ready": true,
    "confidence": 0.92,
    "trigger": "prompt_detected",
    "hints": {
      "looks_like_prompt": true,
      "may_still_be_processing": false
    }
  },
  "latest_byte_offset": 48192,
  "snapshot": {
    "view": "screen",
    "text": "user@host:~/repo$ "
  },
  "updated_at": "2026-04-10T19:25:00.000Z"
}
```

Key property:

- `snapshot.text` is rendered terminal state, not raw historical control bytes

That makes bootstrap replay-safe.

The browser can reset xterm and render a safe snapshot without risking DA/DSR/focus/window side effects from old raw bytes.

### 5.7 Change Terminal Stream Attach Semantics To Match The Newer Agent-Stream Model

The terminal stream should adopt the same high-level shape we now prefer for agent streaming:

- no-cursor attach is live-only
- explicit resume is cursor-driven
- state/bootstrap comes from a separate snapshot route

For terminals, the natural durable cursor is output byte offset, not SSE event id.

Recommended stream contract:

- `GET /api/threads/:thread_id/terminal/stream?after_offset=<n>`

Semantics:

#### No `after_offset`

- live-only attach
- do not replay buffered historical `terminal.output`
- `terminal.status`, `terminal.ready`, `terminal.bud_offline`, and `terminal.bud_online` are live-only

#### `after_offset` supplied

- replay only durable output strictly after that byte offset
- then continue live
- use the durable output store, not only an in-memory SSE buffer

This is much better aligned with the current backend:

- terminal output is already stored durably with `(session_id, byte_offset)`
- `/terminal/history` already supports `since_offset`

The stream should use those durable semantics directly instead of replaying an in-memory event bus buffer and then replaying `/history` again on the client.

### 5.8 Reclassify `/terminal/history`

The current `/terminal/history` route is doing too many jobs:

- reconnect backfill
- initial open restore
- implicit parser rehydration

Those jobs should be split.

Recommended role for `/terminal/history` going forward:

- explicit history and scrollback access
- not normal reconnect bootstrap
- not the primary way to redraw the current terminal state into xterm

Longer-term, browser-facing history should prefer rendered pane capture/history over raw byte-log replay. The raw byte log remains valuable for transport durability and internal tooling, but it is not a safe redraw format for xterm rehydration.

### 5.9 Expected Browser Open And Reconnect Sequence

Recommended open sequence:

1. `POST /api/threads/:thread_id/terminal` to ensure the session row exists.
2. `GET /api/threads/:thread_id/terminal/state`.
3. Render `snapshot.text` into xterm as a safe screen bootstrap.
4. Attach `GET /api/threads/:thread_id/terminal/stream?after_offset=<state.latest_byte_offset>`.
5. Route live output chunks into xterm.
6. Route classified outbound traffic into:
   - human input path
   - emulator protocol path

Recommended reconnect sequence:

1. keep track of `last_rendered_byte_offset`
2. reconnect stream with `after_offset=<last_rendered_byte_offset>`
3. if resume is not possible or the session changed, fetch `terminal/state` again and reset to the new safe snapshot

The browser should no longer do:

- replay buffered SSE output
- then reset
- then replay `/terminal/history`

That is exactly the overlapping replay pattern we want to remove.

### 5.10 Preserve Correct Audit Semantics

Ownership and logging rules should stay correct:

- human input remains stamped with the acting user id
- emulator protocol should not be stamped as human-originated input
- if we keep an input audit log, its source model should become explicit:
  - `human`
  - `emulator_protocol`
  - `agent`
  - `system`

That change is not only cleaner for debugging. It also avoids teaching the backend and future product surfaces the wrong semantics about what a user actually did.

## 6. Alternatives Considered

### 6.1 Add A Restore Guard Only

Example:

- ignore `onData(...)` while `refreshTerminalSnapshot(...)` is replaying history

Why rejected:

- it mitigates one trigger
- it does not fix the input-source conflation
- it does not fix duplicate replay
- it does not address other xterm-generated non-human output outside restore

This is an acceptable short-term mitigation, not the structural fix.

### 6.2 Filter Known Escape Sequences Only

Example:

- drop `ESC[?1;2c`
- drop `ESC[I`
- drop `ESC[O`

Why rejected:

- it is brittle and incomplete
- xterm can emit more than the currently observed sequences
- it encodes a blacklist instead of defining a clean source boundary

The right abstraction is origin classification, not sequence-specific filtering.

### 6.3 Disable Emulator Protocol Replies Entirely

Why rejected:

- some terminal applications legitimately query terminal capabilities
- blanket suppression may fix today's symptom while silently breaking compatibility elsewhere

Again, the right fix is separation, not pretending protocol replies do not exist.

### 6.4 Keep Replay-All Attach And Add Client-Side Dedupe

Why rejected:

- it leaves the wrong attach semantics in place
- it still routes bootstrap through raw byte replay
- it still allows parser side effects from restored historical control bytes

Client dedupe is not a substitute for correct stream/bootstrap design.

## 7. Rollout

Recommended rollout order:

1. Add a browser-side terminal transport controller so the thread route no longer wires public `onData(...)` directly to the backend.
2. Add explicit source classification for outbound terminal traffic:
   - human
   - emulator protocol
3. Add a browser-facing structured terminal send route backed by the existing daemon `terminal_send` path.
4. Add `GET /api/threads/:thread_id/terminal/state` with safe rendered bootstrap data plus `latest_byte_offset`.
5. Change terminal stream attach semantics to live-only by default with explicit `after_offset` catch-up.
6. Remove reconnect-time `/terminal/history` parser replay from the thread view.
7. Reclassify `/terminal/history` as explicit history/scrollback, not reconnect bootstrap.
8. Update audit logging so emulator protocol is not stamped as human input.

If we need a lower-risk transition, steps 1 to 3 can ship before the stream/bootstrap redesign. That alone would eliminate the core "non-human outbound data is treated as user input" bug class.

## 8. Expected File Areas

Web:

- [`web/src/routes/$budId/$threadId.tsx`](../web/src/routes/$budId/$threadId.tsx)
- [`web/src/lib/api.ts`](../web/src/lib/api.ts)
- new browser terminal transport/input modules under `web/src/lib/`

Service:

- [`service/src/routes/threads.ts`](../service/src/routes/threads.ts)
- [`service/src/runtime/event-bus.ts`](../service/src/runtime/event-bus.ts)
- [`service/src/runtime/terminal-session-manager.ts`](../service/src/runtime/terminal-session-manager.ts)

Daemon:

- [`bud/src/main.rs`](../bud/src/main.rs)

Docs/specs:

- [`docs/proto.md`](../docs/proto.md)
- [`service/src/routes/routes.spec.md`](../service/src/routes/routes.spec.md)
- [`service/src/runtime/runtime.spec.md`](../service/src/runtime/runtime.spec.md)
- [`web/src/routes/$budId/budId.spec.md`](../web/src/routes/$budId/budId.spec.md)
- [`bud.spec.md`](../bud.spec.md)

## 9. Decision Summary

The current `1;2c` issue is the visible symptom of a deeper contract problem:

- the browser is using xterm's flattened outbound data stream as if it were synonymous with human keystrokes
- the reconnect path is using raw historical parser replay as if it were a safe bootstrap model

The structural fix is to split the system into explicit planes:

- human input
- emulator protocol
- bootstrap state
- live output stream

That gives us a terminal architecture where:

- replayed output cannot become fake user input
- emulator protocol is handled intentionally instead of accidentally
- reconnect semantics are explicit and durable
- browser terminal open and reconnect no longer depend on feeding old raw control bytes back through xterm and hoping nothing answers them

