# Design: Daemon Terminal Send Ack And Optional Observation

Status: Draft

Audience: Bud daemon, service, web

Last updated: 2026-04-12

Related:
- [`design/browser-terminal-typing-latency-and-send-modes.md`](./browser-terminal-typing-latency-and-send-modes.md)
- [`design/terminal-human-input-boundaries-and-replay-semantics.md`](./terminal-human-input-boundaries-and-replay-semantics.md)
- [`design/terminal-send-confirmation-and-fast-observe.md`](./terminal-send-confirmation-and-fast-observe.md)
- [`debug/thread-terminal-1-2c-da-replay.md`](../debug/thread-terminal-1-2c-da-replay.md)

## 1. Goal

Keep one coherent terminal-send implementation in the Bud daemon while supporting two different caller intents:

1. **Realtime human typing**
   - low latency
   - fire-and-forget is acceptable
   - the terminal SSE/output stream is the main feedback path

2. **Validated interaction**
   - higher latency is acceptable
   - caller wants dispatch plus post-send evidence
   - suitable for agent/tool use and some explicit interactive actions

The key requirement is that the daemon should not fork into two unrelated input implementations just because the caller expectations differ.

## 2. Current Daemon Implementation

The current Bud daemon already has one core structured send path:

- [`bud/src/main.rs`](../bud/src/main.rs)
- `TerminalManager::handle_send(...)`
- `TerminalManager::dispatch_interaction_to_tmux(...)`
- `TerminalManager::send_text_payload_to_tmux(...)`
- `TerminalManager::send_interaction_key(...)`

Today `handle_send(...)` does all of the following in one request lifecycle:

1. capture a baseline screen before dispatch
2. dispatch text / submit / keys to tmux
3. optionally sleep for `observe_after_ms` (default `1000ms`)
4. capture again or run a wait engine
5. compute delta + readiness
6. send a single `terminal_send_result`

That means the daemon currently conflates two facts:

- **dispatch succeeded**
- **post-send observation completed**

This is acceptable for agent/tool flows. It is the wrong default for human typing.

## 3. Daemon-Specific Option Review

### Option A: Separate daemon handlers for human vs validated send

Example:

- `terminal_send_human`
- `terminal_send_validated`

Pros:

- easy to reason about superficially
- latency semantics are explicit

Cons:

- duplicates the send path
- duplicates text/key encoding rules
- risks long-term drift between tmux dispatch implementations
- makes bug fixes harder because the target is the same pane, but behavior is split at the wrong layer

Verdict:

- simplest mental model
- wrong daemon architecture

### Option B: Keep one `terminal_send` request, make observation optional, return one result

Example request:

```json
{
  "type": "terminal_send",
  "session_id": "sess_...",
  "request_id": "send_...",
  "text": "a",
  "submit": false,
  "keys": [],
  "observe": null
}
```

or

```json
{
  "type": "terminal_send",
  "session_id": "sess_...",
  "request_id": "send_...",
  "text": "git status",
  "submit": true,
  "observe": {
    "after_ms": 200,
    "wait_for": "changed",
    "timeout_ms": 5000
  }
}
```

Semantics:

- no `observe` means dispatch-only
- `observe` means keep the current send-plus-observe behavior
- one result frame still comes back, but dispatch-only returns immediately

Pros:

- smallest daemon change
- preserves one tmux dispatch implementation
- easy migration from the current `observe_after_ms` / `wait_for` fields

Cons:

- result semantics still vary sharply by request mode
- the single response type continues to carry two conceptual phases
- future browser-vs-agent behavior can still get muddied because "ack" and "observation" are not modeled separately

Verdict:

- most simple viable daemon solution

### Option C: Keep one `terminal_send` request, split output into ack and optional observation

Example request:

```json
{
  "type": "terminal_send",
  "session_id": "sess_...",
  "request_id": "send_...",
  "text": "a",
  "submit": false,
  "observe": null
}
```

or

```json
{
  "type": "terminal_send",
  "session_id": "sess_...",
  "request_id": "send_...",
  "text": "git status",
  "submit": true,
  "observe": {
    "after_ms": 200,
    "wait_for": "changed",
    "timeout_ms": 5000
  }
}
```

Daemon responses:

1. immediate ack:

```json
{
  "type": "terminal_send_ack",
  "session_id": "sess_...",
  "request_id": "send_...",
  "submitted": true,
  "error": null
}
```

2. optional observation:

```json
{
  "type": "terminal_send_observation",
  "session_id": "sess_...",
  "request_id": "send_...",
  "delta": { "...": "..." },
  "readiness": { "...": "..." },
  "error": null
}
```

Semantics:

- dispatch acknowledgment is immediate and explicit
- observation is only performed when requested
- observation is a second phase, not part of "did send-keys succeed?"

Pros:

- keeps one tmux dispatch implementation
- models dispatch vs observation correctly
- best fit for both browser and agent callers
- lets browser typing stay fast without weakening validated interaction
- aligns with the real conceptual split already visible in the current daemon logic

Cons:

- requires more protocol/service work than Option B
- requires clearer correlation and error handling between ack and observation phases

Verdict:

- most robust daemon solution

## 4. Recommendation

### Most simple for the Bud daemon

**Option B**

Keep one `terminal_send` handler, make observation optional, and return immediately when no observation is requested.

Why:

- the daemon already has the core building blocks
- `dispatch_interaction_to_tmux(...)` already gives a strong dispatch boundary
- this avoids duplicating the send implementation
- it minimizes risk while restoring low-latency human typing

### Most robust for the Bud daemon

**Option C**

Keep one `terminal_send` request, but split the daemon output into:

1. immediate dispatch ack
2. optional observation result

Why:

- it maps cleanly to what the daemon actually does
- it separates transport truth from observation truth
- it avoids forcing the browser to wait for agent-oriented validation semantics
- it gives the service and web clean primitives to compose differently for human vs agent callers

### Final daemon recommendation

Choose **Option C** as the target architecture, but implement it by refactoring the current code toward **Option B** first if rollout risk matters.

In other words:

1. keep one send implementation
2. make observation optional
3. then split the response into ack plus optional observation

That gives the daemon the right long-term shape without making the first step too invasive.

## 5. Why One Send Implementation Is The Right Daemon Boundary

The Bud daemon’s real job is:

- encode text and keys correctly
- dispatch them to the right tmux target
- optionally observe what happened next

Those are all operations on the same foreground pane.

So the stable daemon boundary should be:

- one dispatch path
- optional observation policy
- separate reporting phases

It should not be:

- one human send implementation
- one agent send implementation

because the target and dispatch mechanics are identical.

## 6. Current Implementation Unknowns

The current daemon code is good enough to support this direction, but there are several unknowns we should treat explicitly.

### 6.1 Frame ordering between ack, observation, and output is not currently modeled

Today:

- `handle_send(...)` sends one `terminal_send_result`
- terminal output comes from the independent `spawn_output_watcher(...)` task

If we move to `terminal_send_ack` plus `terminal_send_observation`, we need to decide what ordering guarantees actually exist relative to:

- `terminal_output`
- `terminal_send_ack`
- `terminal_send_observation`

Likely reality:

- output may race with ack or observation because different async tasks write to the same outbound channel

That is acceptable if the protocol treats them as correlated but not strictly ordered. It is a problem if callers assume ack always arrives before any output.

### 6.2 The current baseline capture happens before dispatch

Current `handle_send(...)` captures a baseline screen before calling `dispatch_interaction_to_tmux(...)`.

Unknown:

- should realtime human sends skip baseline capture entirely?

For low-latency browser typing, the answer is probably yes. That is an important daemon optimization because baseline capture is unnecessary if no observation is requested.

### 6.3 `delivered_captures` is session-scoped, not request-scoped

The daemon currently stores delivered capture state in:

- `TerminalState.delivered_captures: HashMap<String, DeliveredCaptureState>`

This is useful for delta-mode observe/send, but it means the observation baseline is shared at the session level rather than bound to a specific request.

Unknowns:

- is session-scoped delivered capture still the right abstraction once send ack and observation are separate?
- what happens when multiple sends/observes overlap on the same session?

This does not block the design, but it affects how robust concurrent observation semantics can be.

### 6.4 The current dispatch ack boundary is "tmux command returned success"

`dispatch_interaction_to_tmux(...)` returns `submitted: bool` after the daemon’s `tmux send-keys` commands succeed.

Unknown:

- is that the right ack contract, or do we want something stronger?

For the browser, "tmux accepted the send" is probably enough.
For the agent, it is not enough on its own, which is exactly why observation should be separate.

So this unknown is mostly about naming and caller expectations, not about daemon capability.

### 6.5 Text-plus-submit dispatch uses multiple tmux invocations

`send_text_payload_to_tmux(...)` may call:

- one literal text send
- one or more `Enter` sends

Unknowns:

- is this sequencing fully equivalent to the older raw-input path in all target programs?
- do any TUIs depend on timing or grouping between text and Enter?

This is not caused by the ack/observation split, but the design should note that dispatch parity remains an implementation concern.

### 6.6 Unsupported keys are still enforced in the daemon

`send_interaction_key(...)` supports a curated set of keys and rejects others.

Unknown:

- do we need a richer key model before making validated interaction more central?

This does not affect realtime human typing directly if printable text remains text-based, but it matters for keeping one coherent send path.

## 7. Proposed Daemon Contract Direction

### Request

Unify around one request type:

```json
{
  "type": "terminal_send",
  "session_id": "sess_...",
  "request_id": "send_...",
  "text": "example",
  "submit": true,
  "keys": [],
  "observe": {
    "after_ms": 200,
    "wait_for": "changed",
    "timeout_ms": 5000
  }
}
```

For realtime human sends:

- `observe` omitted or `null`

For validated sends:

- `observe` present

### Responses

Required:

```json
{
  "type": "terminal_send_ack",
  "session_id": "sess_...",
  "request_id": "send_...",
  "submitted": true,
  "error": null
}
```

Optional:

```json
{
  "type": "terminal_send_observation",
  "session_id": "sess_...",
  "request_id": "send_...",
  "delta": { "...": "..." },
  "readiness": { "...": "..." },
  "error": null
}
```

## 8. Migration Notes

### Low-risk first step

Refactor current `handle_send(...)` internally into two stages:

1. dispatch stage
2. optional observation stage

Even if the wire protocol initially still sends only one combined result, that internal split will make the later ack/observation frame split much easier.

### Final step

Once service/web are ready:

- emit `terminal_send_ack` immediately
- only run/send observation when requested
- deprecate the old single `terminal_send_result` shape

## 9. Decision Summary

For the Bud daemon:

- **most simple**: one `terminal_send` handler with optional observation and one immediate result when observation is absent
- **most robust**: one `terminal_send` handler with immediate ack plus optional second observation frame

Final recommendation:

- keep one daemon send implementation
- do not fork human vs agent send handlers
- target **ack plus optional observation** as the long-term daemon model
- treat current unknowns mainly as ordering, baseline, and shared-capture-state questions, not as reasons to split the dispatch path itself
