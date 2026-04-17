# Design: Backend-Neutral Terminal Wire Contract

**Status:** Draft
**Created:** 2026-04-16
**Related:**
- [`review/bud-daemon-modularization-review.md`](../review/bud-daemon-modularization-review.md)
- [`plan/refactor-daemon/implementation-spec.md`](../plan/refactor-daemon/implementation-spec.md)
- [`design/terminal-command-and-interaction-contract.md`](./terminal-command-and-interaction-contract.md)
- [`design/terminal-send-settled-by-default.md`](./terminal-send-settled-by-default.md)
- [`design/terminal-delta-observation-and-minimal-tool-payloads.md`](./terminal-delta-observation-and-minimal-tool-payloads.md)
- [`docs/proto.md`](../docs/proto.md)

---

## Summary

The Bud daemon now has the right internal seam for future backends: the terminal runtime is split above a `TerminalBackend` trait and tmux is isolated in its own adapter. The remaining problem is the **wire contract still exposes tmux as if it were part of the product model**.

That leakage is broader than `terminal_status.info.tmux_session`:

- Bud advertises tmux-specific capability fields in `hello`
- the service still predicts and persists tmux session names
- agent/docs still describe tmux-native key notation as the canonical interactive input language
- specs and protocol examples still describe terminal operations in tmux terms

The next cleanup should remove tmux implementation identity from the Bud↔service and service↔browser contracts while keeping current behavior unchanged. The service and daemon should reason about:

- terminal availability
- terminal session lifecycle
- structured input
- output streaming
- rendered observation
- readiness

They should not need to reason about tmux session names or tmux version unless we are explicitly doing diagnostics.

## Why This Follow-Up Exists Now

The daemon refactor intentionally deferred wire cleanup so we could first prove the backend-neutral internal runtime was correct. That proof now exists:

- the terminal runtime is modularized above the backend layer
- tmux-specific process/session behavior is already isolated in the daemon
- the refactor has passed manual verification

That means we can now clean the external contract without also restructuring the daemon internals at the same time.

This ordering matters. Before the refactor, removing tmux leakage would have risked collapsing abstraction and implementation changes into one hard-to-debug pass. After the refactor, the service contract can be tightened while the daemon keeps translating into tmux behind the scenes.

## Problem Statement

Today the external contract still carries implementation details that do not belong to the long-term product surface.

### 1. `terminal_status` leaks the backend-local session identity

Current protocol/docs still model status like:

```json
{
  "type": "terminal_status",
  "session_id": "sess_01...",
  "state": "ready",
  "info": {
    "tmux_session": "s_01..."
  }
}
```

That field is not part of the service's terminal semantics. It is a tmux adapter detail.

Worse, the service currently treats it as meaningful persisted state:

- `service/src/runtime/terminal-session-manager.ts` stores it as `tmuxSessionName`
- `service/src/db/schema.ts` persists it in `terminal_session.tmux_session_name`
- the service also derives tmux session names locally from `session_id`

That is exactly the kind of dependency the daemon refactor was meant to eliminate.

### 2. `hello.capabilities` exposes backend identity instead of behavior

Current Bud hello capabilities include fields such as:

- `sessions_backends`
- `terminal_backends`
- `tmux_version`
- `supports_pty`

This is problematic for two reasons:

1. it encourages the service and browser to branch on implementation identity rather than behavior
2. some of the current fields are ahead of reality or semantically blurry, especially `supports_pty`

The browser currently appears to normalize these values but not meaningfully branch on them. That is a good sign: removing them should be low-risk if the service stays tolerant during rollout.

### 3. The agent-facing interactive input contract is still too tmux-shaped

`terminal.send.keys` currently documents tmux `send-keys` notation such as `C-c` as the canonical way to express `Ctrl+C`.

That was acceptable when tmux was effectively the contract. It is the wrong long-term shape once Bud can support other backends.

More importantly, batched `actions` is probably not the right canonical abstraction either. The simpler backend-neutral contract is:

- one `terminal.send` call represents one input gesture
- that gesture is either literal `text` with optional `submit`
- or one semantic `key`

That maps cleanly onto tmux, a direct PTY, or a mosh-like transport without introducing ambiguous batching or sequencing semantics into the product contract.

### 4. Protocol and spec language still describe terminal behavior in tmux terms

Examples in `docs/proto.md` and related specs still say things like:

- "create/adopt the tmux session"
- "resize tmux pane"
- "use tmux notation for chords"

That language makes it harder to reason about future PTY or mosh-like backends as first-class implementations of the same product contract.

## Goals

- Remove tmux-specific identity from the Bud↔service terminal contract.
- Keep current terminal behavior and user-visible functionality unchanged.
- Make the service reason about terminal semantics, not backend implementation.
- Make the agent/tool/browser contract backend-neutral by default.
- Keep a path for implementation diagnostics without polluting the main wire contract.
- Avoid speculative abstractions that will become dead weight if only one backend ships in the near term.

## Non-Goals

- Replacing tmux as the active backend in this phase.
- Redesigning terminal tool semantics beyond what is needed to remove tmux leakage.
- Changing terminal lifecycle, readiness behavior, or delta behavior.
- Removing the legacy queued `run` path.
- Solving every future backend divergence up front.

## Current Leakage Inventory

### Bud → service terminal status

Current leakage:

- `terminal_status.info.tmux_session`

Current generic fields that should stay:

- `pid`
- `shell`
- `cwd`
- `cols`
- `rows`
- `output_log_bytes`
- `started_at`
- `last_activity_at`

### Bud hello capabilities

Current leakage / ambiguity:

- `sessions_backends`
- `terminal_backends`
- `tmux_version`
- `supports_pty`

Current generic fields that can remain:

- `max_concurrency`
- `shell_default`
- `terminal`
- `terminal_proto`

### Service persistence and state modeling

Current leakage:

- `terminal_session.tmux_session_name`
- `TerminalSessionManager.tmuxSessionName(sessionId)`
- `fetchStatus()` returning `tmux_session`

This is the most important non-wire dependency to remove. It means the service still partially owns tmux naming even though the daemon now owns backend adaptation.

### Agent/tool contract

Current leakage:

- canonical `terminal.send.keys` notation is tmux-specific (`C-c`)

Desired long-term shape:

- the contract uses a single semantic input gesture per request
- semantic key names remain available for non-text gestures
- the daemon/backend adapter accepts tmux aliases only as compatibility input

## Recommended Contract Direction

## 1. `terminal_status.info` should contain only generic terminal metadata

Recommended terminal status shape:

```json
{
  "proto": "0.2",
  "type": "terminal_status",
  "session_id": "sess_01...",
  "state": "ready",
  "info": {
    "pid": 1234,
    "shell": "/bin/bash",
    "cwd": "/Users/adam/bud",
    "cols": 200,
    "rows": 50,
    "output_log_bytes": 4096,
    "started_at": "2026-04-16T18:12:00.000Z",
    "last_activity_at": "2026-04-16T18:12:03.000Z"
  },
  "ext": {}
}
```

Recommendation:

- remove `tmux_session` from the normal status payload
- do **not** replace it with `backend_session_id` unless a real consumer appears

Reasoning:

- the service already has the stable public `session_id`
- the service does not need the backend-local session name to operate the terminal feature
- renaming tmux identity to a generic field without a real consumer would preserve unnecessary coupling under a new label

If we still want implementation-level observability later, it belongs on a dedicated diagnostics surface, not on the normal status contract.

## 2. Capabilities should describe behavior, not backend identity

Recommended near-term hello capabilities:

```json
{
  "max_concurrency": 1,
  "shell_default": "/bin/bash",
  "terminal": true,
  "terminal_proto": "0.2"
}
```

Optional:

- retain `sessions: true` only if it still carries meaning separate from `terminal`

Recommended removals:

- `terminal_backends`
- `sessions_backends`
- `tmux_version`

Recommended correction:

- either remove `supports_pty` or scope it to the legacy run subsystem with honest semantics

The key rule is simple:

> If the service should not branch on a field to decide whether the terminal contract works, the field probably does not belong in `hello.capabilities`.

### What about future backend divergence?

Do not introduce a speculative `terminal_features` matrix yet.

If and only if two real backends differ in behavior, add semantic feature flags such as:

- `persistent_terminal_sessions`
- `terminal_history_observe`
- `terminal_screen_observe`

Do not add backend IDs as a proxy for those behaviors.

## 3. Canonical interactive input should become a single gesture per request

Recommended canonical shape:

```json
{
  "type": "terminal_send",
  "session_id": "sess_01...",
  "text": "git status",
  "submit": true,
  "wait_for": "settled",
  "timeout_ms": 30000
}
```

Or for a non-text gesture:

```json
{
  "type": "terminal_send",
  "session_id": "sess_01...",
  "key": "ctrl+c",
  "wait_for": "settled",
  "timeout_ms": 30000
}
```

Recommended canonical gesture rules:

- `text` with optional `submit`
- or one semantic `key`
- `text` and `key` are mutually exclusive
- the wait/settle policy runs once after dispatching that one gesture
- if the agent needs multiple gestures, it should make multiple calls

Recommended canonical key names:

- `enter`
- `escape`
- `tab`
- `backspace`
- `arrow_up`
- `arrow_down`
- `arrow_left`
- `arrow_right`
- `page_up`
- `page_down`
- `ctrl+c`
- `ctrl+d`

Recommended convenience sugar:

- keep `text` + `submit: true` as the primary concise shell/REPL path
- keep `keys: [...]` only as a compatibility alias while older callers exist
- move docs and prompts toward singular `key` for semantic non-text gestures

The important rule is:

> `terminal.send` should describe one input gesture. The contract should not batch multiple gestures into one request by default.

This is the simplest shape that stays correct across backends:

- tmux backend: `text` -> literal send, `submit` -> Enter, `key` -> tmux key name
- PTY backend: `text` -> bytes, `submit` -> line ending, `key` -> control byte or escape sequence
- mosh-like backend: same gesture, different transport implementation

It also avoids awkward questions like:

- are multiple actions dispatched with a settle/wait between them?
- are multiple actions atomic?
- do different backends sequence the batch differently?
- what does partial success mean if the first action succeeds and the second fails?

Those ambiguities disappear if one request means one gesture.

Recommended compatibility rule:

- Bud may continue accepting tmux aliases such as `C-c` and normalize them internally during migration
- service prompts/docs should move to semantic key names first
- the tmux backend adapter becomes the only place that knows how `ctrl+c` maps to tmux

### Why not make raw bytes the main contract?

Because raw bytes are the wrong default abstraction for the agent/service path:

- they are harder for the model to use correctly
- they reintroduce terminal-emulator details into the contract
- they make validation and future compatibility worse

If a browser-fidelity escape hatch is ever needed, it should be a separate surface, not the main agent/service contract.

### Why not keep a dedicated interrupt API?

Because `Ctrl+C` is still terminal input, not a guaranteed process-management primitive.

The product should have one general interactive input tool. The backend decides how to realize `ctrl+c`:

- tmux key chord
- PTY control byte
- remote transport input event

## 4. The service should stop owning backend session naming

Recommended service direction:

- stop deriving tmux session names from `session_id`
- stop persisting tmux session names as first-class terminal state needed by the app
- treat Bud as the sole owner of backend-local session identifiers

Short-term migration approach:

- keep the DB column and in-memory field only as transitional compatibility if needed
- remove them from the live request/response contract first

Long-term recommendation:

- if no real diagnostic consumer appears, drop the column rather than rename it
- if a diagnostic consumer does appear, prefer a generic debug/metadata JSON field over a first-class `backend_session_id` column

Renaming `tmux_session_name` to `backend_session_id` immediately is not the best default. It keeps a field alive before we have proved we need it.

## 5. Protocol/docs should describe terminal semantics, not tmux mechanics

Recommended doc language:

- "create or reattach terminal session", not "create/adopt tmux session"
- "resize terminal session", not "resize tmux pane"
- "special keys", not "tmux send-keys actions"

This sounds cosmetic, but it matters. The docs are the conceptual contract the rest of the codebase follows.

## Diagnostics Recommendation

There is still a legitimate operator question:

- which backend is this Bud using?
- what version of tmux was detected?

Those are valid diagnostics. They are just not part of the normal terminal contract.

Recommended path:

- keep tmux detection and version logging inside the daemon
- if product/debug needs arise, expose backend identity and version through a dedicated diagnostics/admin surface later
- do not keep `tmux_version` or backend IDs in the browser-facing or normal service-facing capabilities/status payloads just in case

## Recommended Migration Plan

## Phase 1. Neutralize the service and protocol surfaces first

Changes:

- update `docs/proto.md` examples and field descriptions
- make `service/src/ws/gateway.ts` accept the neutral status/capabilities shape
- remove `tmux_session` from `service/src/terminal/types.ts`
- stop returning `tmux_session` from `TerminalSessionManager.fetchStatus()`
- keep Bud tolerant of legacy key aliases

Compatibility:

- the service can continue accepting `tmux_session` as optional input during rollout
- Bud can stop sending it once the service no longer depends on it

This gives us a safe additive/subtractive rollout without changing terminal behavior.

## Phase 2. Move the canonical interactive input contract to a single gesture model

Changes:

- update service agent prompt/tool descriptions so `terminal.send` means one gesture per call
- move docs/examples from tmux-native `C-c` toward semantic names such as `ctrl+c`
- keep `text + submit` as the primary common path
- introduce singular `key` as the canonical non-text gesture field
- keep alias normalization in Bud during the transition window

Validation:

- browser interrupt still works
- agent interrupt still works
- repeated interrupts still work in TUIs where one `ctrl+c` is not enough

## Phase 3. Remove backend-specific persistence from the service runtime

Changes:

- stop deriving tmux session names in `TerminalSessionManager`
- stop writing `tmuxSessionName` for new lifecycle updates
- remove first-class use of `tmuxSessionName` from service runtime state

Then decide:

- drop `terminal_session.tmux_session_name`
- or preserve backend diagnostics in a generic metadata field if a real use case emerges

The default recommendation is to drop the field if nothing needs it.

## Phase 4. Cleanup specs, docs, and residual compatibility paths

Changes:

- update Bud/service/web specs
- remove obsolete tmux-specific wording from terminal contract docs
- remove compatibility shims only after the coordinated service+Bud rollout is verified

## Should This Bump `terminal_proto`?

Recommendation: **not initially**.

Reasoning:

- removing optional fields from status/capabilities can be made backward-compatible on the service side
- canonical key-name cleanup can be handled with alias acceptance during rollout
- the underlying request/response semantics are not changing

Use a `terminal_proto` bump only if we decide to make a non-compatible request/response change, not merely to tidy optional field leakage.

## Open Questions

1. Do we want to keep any implementation diagnostics visible in the product at all, or should tmux identity/version live only in logs unless a dedicated debug surface is built?
2. Is there any real consumer of `terminal_session.tmux_session_name` beyond historical debugging and habit?
3. Should `supports_pty` be removed entirely, or reintroduced later under a clearly separate legacy-run capability surface?
4. Do we want to preserve `sessions` as a generic capability, or is `terminal: true` already the only meaningful signal now?
5. Should we drop the `tmux_session_name` column immediately after runtime cleanup, or leave it one release longer as a no-op compatibility field?
6. Do we want the canonical key names to use `ctrl+c` style strings, or a slightly more structured enum vocabulary such as `ctrl_c`? The important part is that the canonical form should be semantic, not tmux-native.
7. Do we want to expose singular `key` on the Bud↔service wire immediately, or first adopt it in service-side types/tools while keeping `keys` as a compatibility alias during rollout?

## Best Path Forward

The best path is a **minimal, semantics-first cleanup**:

1. remove `tmux_session` from the normal terminal status contract
2. stop exposing tmux backend identity/version in `hello.capabilities`
3. make `terminal.send` a single-gesture input model with `text + submit` or one semantic `key`
4. stop the service from deriving and persisting tmux session names as if they were product state
5. keep any remaining tmux identity only in dedicated diagnostics, not the main contract

The main thing to avoid is replacing tmux-specific leakage with renamed-but-still-unnecessary generic leakage.

Bad outcome:

- `tmux_session` becomes `backend_session_id`
- `terminal_backends` becomes `backend_kinds`
- the same coupling survives behind more abstract labels

Good outcome:

- the service contract speaks only in terms of terminal semantics
- Bud owns backend translation internally
- tmux remains an implementation detail that can change without another cross-stack contract rewrite

That is the cleanest base for future PTY, home-built terminal, or mosh-like work.
