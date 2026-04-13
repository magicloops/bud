# Phase 6: Optional Observation Send Adoption

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Restore low-latency browser terminal typing while keeping browser and agent input on the same structured `terminal_send` path by making post-send observation optional and explicitly requested.

## Context

Phase 2 intentionally converged browser terminal interaction onto the same structured send path used by the agent/runtime stack. That fixed the transport-boundary problem, but it also pulled browser typing onto an agent-oriented response path that waits for observed terminal change before returning.

That wait is appropriate for agent/tool calls that need delta/readiness proof. It is the wrong default for xterm.js-driven human typing, where the browser already has the live terminal SSE stream to render output and only needs dispatch success.

This phase follows the recommendations in:

- [../../design/browser-terminal-typing-latency-and-send-modes.md](../../design/browser-terminal-typing-latency-and-send-modes.md)
- [../../design/daemon-terminal-send-ack-and-optional-observation.md](../../design/daemon-terminal-send-ack-and-optional-observation.md)

## Scope

### Shared Daemon Contract

Keep one `terminal_send` implementation in the daemon/runtime path.

Add an optional `observe` parameter to the shared send contract:

```json
{
  "text": "a",
  "submit": false,
  "keys": [],
  "observe": null
}
```

When observation is requested:

```json
{
  "text": "git status",
  "submit": true,
  "keys": [],
  "observe": {
    "after_ms": 200,
    "wait_for": "changed",
    "timeout_ms": 5000
  }
}
```

Phase 6 requirements:

- the tmux dispatch path stays shared across browser and agent callers
- omission of `observe` or `observe: null` means dispatch-only semantics
- explicit `observe` preserves the current observed-send behavior needed by agent/tool flows
- the first pass may keep a single response shape, but the implementation should not block a later split into immediate ack plus optional observation result

### Service And Runtime Adoption

Plumb optional observation through the touched service/runtime surfaces:

- browser-facing `POST /api/threads/:thread_id/terminal/send`
- agent-facing terminal send paths
- runtime send interaction helpers and result handling

Phase 6 service/runtime requirements:

- browser-originated structured sends default to no observation for normal interactive typing and common key flows already modeled by the structured route
- agent-originated structured sends can request observation explicitly when delta/readiness is needed
- ownership, authorization, and source stamping stay unchanged across observed and unobserved sends

### xterm.js / Browser Adoption

Update the thread terminal controller and xterm.js integration so human terminal interaction no longer waits on the agent-oriented observation window.

This phase should:

- use the structured send route without observation for normal human typing
- use the structured send route without observation for Enter, paste, and common navigation/edit keys where those paths are already covered
- keep any raw fallback path narrow, source-tagged, and independent of observation semantics
- audit the controller send queue so it waits only for dispatch completion, not terminal-change observation

### Agent Usage Adoption

Update agent-facing usage so observation becomes explicit rather than accidental.

This phase should:

- expose optional observation through the model-facing terminal send contract
- review the current default agent behavior and make it intentional in code/docs rather than inherited from pre-browser semantics
- preserve observed-send delta/readiness behavior when the caller requests observation
- document when fire-and-forget send is acceptable versus when observed send should remain the default for the agent

### Docs And Protocol Alignment

Update the touched docs/specs so they describe:

- one shared `terminal_send` path
- optional observation instead of separate browser vs agent send implementations
- browser/xterm defaulting to dispatch-only semantics
- agent/tool callers opting into observation when they need terminal response proof

## Deliverables

- optional `observe` parameter on the shared send contract
- browser xterm/controller adoption of dispatch-only structured sends for normal human input
- agent/runtime adoption of explicit observation where needed
- updated checklists/docs/specs for both send modes

## Success Criteria

- [ ] Human typing in the browser no longer pays the default observation delay.
- [ ] Browser and agent still converge on one shared daemon/runtime send implementation.
- [ ] `terminal_send` works correctly with and without observation.
- [ ] Agent/tool callers can still request delta/readiness when they need it.
- [ ] Structured browser input keeps the existing source/audit semantics.
- [ ] Any retained raw fallback path is still explicit, source-tagged, and not the primary browser interaction path.

## Expected Files

- `bud/src/main.rs`
- `bud/src/src.spec.md`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/routes/threads.ts`
- `service/src/agent/`
- `service/src/runtime/runtime.spec.md`
- `service/src/routes/routes.spec.md`
- `web/src/lib/thread-terminal-controller.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/lib/lib.spec.md`
- `docs/proto.md`
- `bud.spec.md`

## Non-Goals

- reverting the reference web client back to raw `/terminal/input` as the primary browser interaction path
- creating separate daemon send implementations for human and agent callers
- redesigning readiness heuristics beyond what is needed to make observation optional

## Risks And Notes

- The most robust daemon end state is immediate dispatch acknowledgment plus optional observation output, but this phase does not require that full event split on day one.
- Browser latency can still regress if the controller keeps per-send head-of-line blocking after observation becomes optional; validate queue behavior explicitly.
- Agent defaults are coupled to the current observed-send semantics. Make any compatibility choice explicit in code and docs.
- Interleaving observed and unobserved sends on one session must preserve per-request/result correlation.
- Do not weaken auth, owner stamping, or source tagging while making observed send optional.

