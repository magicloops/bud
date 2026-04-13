# Design: Browser Terminal Typing Latency And Send Modes

Status: Draft

Audience: Web, service, daemon

Last updated: 2026-04-12

Related:
- [`debug/thread-terminal-1-2c-da-replay.md`](../debug/thread-terminal-1-2c-da-replay.md)
- [`debug/thread-terminal-cursor-bottom-after-safe-bootstrap.md`](../debug/thread-terminal-cursor-bottom-after-safe-bootstrap.md)
- [`design/terminal-human-input-boundaries-and-replay-semantics.md`](./terminal-human-input-boundaries-and-replay-semantics.md)
- [`design/terminal-send-confirmation-and-fast-observe.md`](./terminal-send-confirmation-and-fast-observe.md)
- [`plan/thread-terminal-boundaries/implementation-spec.md`](../plan/thread-terminal-boundaries/implementation-spec.md)
- [`plan/thread-terminal-cursor-bootstrap-validation.md`](../plan/thread-terminal-cursor-bootstrap-validation.md)

## 1. Problem

The browser terminal typing path is now noticeably slower than expected after the thread-terminal-boundaries work.

The immediate evidence is straightforward:

- browser typing now goes through `POST /api/threads/:thread_id/terminal/send`
- that route calls `terminalSessionManager.sendInteraction(...)`
- `sendInteraction(...)` defaults `observe_after_ms` to `1000`
- the browser-side controller serializes outbound sends behind one `sendQueue`
- the observed server response time is about `1051ms`

That means the browser is currently paying the cost of an agent-oriented "send plus delayed proof" path for ordinary human typing.

This is not just a tuning mismatch. It is an intent mismatch:

- browser human typing needs near-immediate responsiveness
- agent tool calls need stronger evidence and can tolerate more latency

The system currently treats both as the same kind of send.

## 2. Constraints

We do not want to lose the structural improvements from the boundaries work:

- browser typing should not go back to conflating human input and emulator protocol
- browser typing should stay as aligned as practical with the `terminal_send` path used elsewhere
- the backend should keep one coherent terminal-send model rather than diverging into unrelated implementations

At the same time, browser terminal UX has a hard requirement:

- normal typing must feel immediate

This is the core design tension.

## 3. What Changed That Caused The Latency

### 3.1 Browser typing moved from fire-and-forget input to request-response send

Old practical behavior:

- browser text went through raw `/terminal/input`
- the route returned once the service forwarded bytes to Bud and recorded audit state
- it did not wait for a Bud-side post-send observation result

Current behavior:

- browser text goes through structured `/terminal/send`
- the route waits for `terminal_send_result`
- Bud-side send currently includes a delayed post-send observe window

### 3.2 The current send default is tuned for proof, not for typing

Current `sendInteraction(...)` defaults:

- `observe_after_ms = 1000`
- `wait_for = "none"`
- `timeout_ms = 5000`

Even with `wait_for = "none"`, the default still means:

- dispatch input
- wait roughly one second
- capture fast post-send delta
- only then resolve the request

That is a good default for an agent asking "did the terminal visibly react?"
It is a poor default for a human typing one or two characters.

### 3.3 The browser controller serializes sends

The browser-side terminal controller batches printable text for only `20ms`, then queues each outbound send behind the previous send promise.

That is defensible for ordering, but when each request takes about one second to resolve, it turns ordinary typing into a visible backlog.

So the latency is not one bug. It is the combination of:

1. a proof-oriented send default
2. per-send request-response gating
3. serialized browser dispatch

## 4. Goals

- Preserve the input-boundary fix from the `1;2c` work.
- Keep browser human typing on a path that is conceptually aligned with `terminal_send`.
- Restore near-immediate browser typing responsiveness.
- Avoid reintroducing "everything from xterm is raw human input" semantics.
- Keep agent/tool sends able to request stronger evidence than the browser needs.

## 5. Non-Goals

- Reverting the entire thread-terminal-boundaries architecture.
- Forcing the browser to wait for proof-of-visible-change on every keystroke.
- Designing a perfect final wire schema in this document.

## 6. Options

### Option A: Revert browser typing back to raw `/terminal/input`

Shape:

- use `/terminal/input` again for normal browser typing
- keep `/terminal/send` for agent tools and maybe some browser special keys
- effectively restore the old low-latency browser path

Advantages:

- simplest immediate latency fix
- likely restores the old typing feel quickly
- minimal daemon/runtime changes

Disadvantages:

- partially reverses the architecture we just introduced
- reopens pressure to treat raw xterm output as equivalent to human typing
- keeps the browser and agent on different terminal-input contracts
- makes future browser input coverage harder to reason about
- encourages the low-level path to remain the real production path

Verdict:

- good emergency rollback lever
- poor long-term direction

### Option B: Keep current architecture, but reduce browser `observe_after_ms`

Shape:

- keep browser on `/terminal/send`
- override browser-originated sends to use a much smaller post-send observe delay, for example `0-50ms` instead of `1000ms`
- keep the request-response shape otherwise unchanged

Advantages:

- small code change
- preserves the structured send route
- keeps browser and agent on the same broad send primitive

Disadvantages:

- still forces every browser text batch to wait on a request-response cycle
- still keeps typing behind the controller send queue
- even `50ms` per send is too much for fast interactive typing over repeated batches
- still couples human typing to proof semantics it does not really need

Verdict:

- good short-term mitigation
- not robust enough as the real design end-state

### Option C: Hybrid split by input class

Shape:

- keep `/terminal/send` for Enter, arrows, special keys, and agent/tool sends
- send plain printable browser text through a raw low-latency path
- keep structured send only where it is clearly needed

Advantages:

- restores low latency for the most common typing path
- avoids making every printable character pay for send-result proof
- smaller change than a deeper protocol redesign

Disadvantages:

- reintroduces two browser send models
- makes browser behavior depend on input-class heuristics
- weakens the goal of converging browser and agent terminal-send behavior
- increases surface area for ordering and audit bugs

Verdict:

- pragmatic fallback if we need relief quickly
- still architecturally mixed

### Option D: Keep `terminal_send`, but add explicit send modes

Shape:

- keep browser and agent on the same high-level `terminal_send` path
- add explicit send intent / response policy, for example:
  - `mode: "realtime_human"`
  - `mode: "validated_interaction"`
- browser typing uses the realtime mode
- agent/tool sends default to validated mode

Illustrative semantics:

- `realtime_human`
  - dispatch to tmux immediately
  - return as soon as dispatch is accepted or minimally acknowledged
  - no built-in `1000ms` post-send observe
- `validated_interaction`
  - preserve the current or improved send-plus-observation model
  - suitable for agents, confirmations, TUI actions, and higher-confidence automation

Advantages:

- preserves one coherent terminal-send family
- keeps the browser boundaries work intact
- cleanly separates "typing latency" from "proof semantics"
- avoids making raw `/terminal/input` the real production path again
- gives us room to improve agent-side send confirmation independently

Disadvantages:

- requires backend/daemon work, not just route tuning
- requires deciding where acknowledgement happens:
  - service accepted
  - Bud accepted
  - tmux send-keys completed
- still needs careful browser queue behavior

Verdict:

- best long-term direction
- aligned with both responsiveness and architecture

### Option E: Keep `terminal_send`, add explicit send modes, and decouple observation from response

Shape:

- same as Option D
- additionally make any post-send observation a separate event or optional follow-up, not part of the primary browser typing response

Illustrative model:

- browser typing request gets fast dispatch acknowledgement
- terminal output still arrives over SSE
- optional proof/observe data can arrive separately when requested

Advantages:

- strongest separation of concerns
- best browser responsiveness ceiling
- cleanest long-term model for human-vs-agent send semantics

Disadvantages:

- more protocol and implementation complexity than Option D
- requires a clearer event/result model across web, service, and daemon
- more change than we likely need right now

Verdict:

- very strong long-term model
- probably more than we need for the next corrective step

## 7. Ranking

### 7.1 Simplest To Ship

1. **Option A: revert browser typing to raw `/terminal/input`**
2. **Option B: keep `/terminal/send`, reduce browser `observe_after_ms`**
3. **Option C: hybrid split by input class**
4. **Option D: same `terminal_send` path with explicit send modes**
5. **Option E: send modes plus separate observation/event model**

### 7.2 Most Robust Long-Term

1. **Option D: same `terminal_send` path with explicit send modes**
2. **Option E: send modes plus separate observation/event model**
3. **Option B: keep `/terminal/send`, reduce browser `observe_after_ms`**
4. **Option C: hybrid split by input class**
5. **Option A: revert browser typing to raw `/terminal/input`**

## 8. Recommendation

### Final recommendation: Option D

Keep browser typing on the same `terminal_send` family, but add explicit send modes so human typing does not inherit the agent's proof-oriented latency.

That gives us the right long-term split:

- **browser human typing**: fast dispatch-oriented send
- **agent/tool interactions**: validated send with observation semantics

This is the best balance between:

- preserving the boundaries fix
- keeping one coherent terminal-send model
- restoring browser responsiveness

### Recommended near-term rollout

#### Step 1: immediate mitigation

Before the full mode split lands, reduce browser-originated structured sends away from the `1000ms` default.

This is not the final design. It is a safe interim mitigation.

#### Step 2: introduce explicit browser-vs-agent send policy on `/terminal/send`

Possible request shape:

```json
{
  "text": "a",
  "source": "human",
  "delivery": "realtime"
}
```

and for agent/tool/default validated sends:

```json
{
  "text": "git status",
  "submit": true,
  "source": "agent",
  "delivery": "validated"
}
```

The exact field name can change, but the semantic split should be explicit.

#### Step 3: make `realtime` resolve on dispatch, not on delayed observation

For browser typing:

- do not wait for a `1000ms` post-send observe window
- resolve as soon as the backend has strong enough evidence that the input was dispatched
- let actual terminal text continue to arrive over the existing output SSE stream

#### Step 4: keep validation and richer semantics for agent sends

Agent/tool sends still need:

- confirmation that something happened
- optional delta/readiness evidence
- a stronger basis for the model's next action

That path should keep its own tuned send-confirmation behavior.

## 9. Why Not Just Revert

Reverting browser typing fully back to `/terminal/input` would solve the symptom quickly, but it would also undo the most important structural part of the boundaries work:

- normal browser typing would again depend on the low-level raw-input surface
- the codebase would drift back toward two unrelated terminal-input models
- future clean-up would become harder, not easier

So revert should remain an escape hatch, not the preferred direction.

## 10. Decision Summary

The current latency is the result of using one proof-oriented send default for two very different intents:

- human realtime typing
- agent validated interaction

The right fix is not to abandon the structured send path. It is to make that path express intent explicitly.

Recommended direction:

- keep browser typing in the `terminal_send` family
- add explicit realtime vs validated send modes
- use realtime mode for browser human typing
- keep validated mode for agent/tool sends
- use a smaller temporary browser delay only as an interim mitigation while the real split lands
