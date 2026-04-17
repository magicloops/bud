# Review: Service Layer Implementation And Refactor Readiness

**Reviewed:** 2026-04-17
**Scope:** `service/` runtime, REST/SSE/WSS boundaries, terminal/session orchestration, auth ownership enforcement, LLM/provider integration, and supporting service scripts/config

## Review Coverage

This review was a static read-through of the current service package:

- every file under `service/src/`
- service package/config files (`package.json`, `README.md`, `.env.example`, `tsconfig.json`, `eslint.config.js`, `drizzle.config.ts`)
- service-side support scripts under `service/scripts/` and `service/src/scripts/`
- Drizzle documentation/spec files under `service/drizzle/`

I did not run builds, tests, or live flows as part of this review.

## Executive Summary

The main service problem is not just file size. The deeper issue is that the service still carries two overlapping generations of backend architecture at once:

- the newer thread-scoped terminal + agent runtime
- the older standalone run + global stream surfaces

That overlap shows up in both structure and correctness. Several large files still mix transport, persistence, policy, and product semantics in one place, and some of the remaining legacy paths now bypass the ownership rules the rest of the service correctly adopted.

The good news is that the current implementation already has the right long-lived primitives:

- ownership-aware Bud/thread lookup helpers
- thread-scoped terminal sessions
- dedicated runtime state/event buses
- an LLM provider abstraction
- focused tests around pure runtime helpers and terminal outcome normalization

The next refactor should preserve those primitives and split the orchestration layers around them.

## Primary Hotspots

These files now carry too many responsibilities to evolve safely:

| File | Current Size | Mixed Responsibilities | Recommended Split |
|------|--------------|------------------------|-------------------|
| `service/src/agent/agent-service.ts` | 1602 lines | conversation reconstruction, provider invocation, tool execution, transcript persistence, runtime events, cancellation | conversation loader, model runner, terminal tool executor, transcript writer |
| `service/src/runtime/terminal-session-manager.ts` | 1650 lines | session lifecycle, DB persistence, send/observe RPC, output storage, readiness cache, idle cleanup, SSE emission | session store/lifecycle, send-observe dispatcher, output persistence/replay, cleanup/idle worker |
| `service/src/routes/threads.ts` | 990 lines | thread CRUD, message creation, agent state/stream, terminal creation/ensure/input/history, deletion | `threads`, `messages`, `agent`, and `terminal` route modules |
| `service/src/ws/gateway.ts` | 950 lines | websocket auth/hello, session tracking, Bud online/offline transitions, terminal frame routing, enrollment token handling | handshake/auth, active-session tracker, frame router, offline transition coordinator |

The refactor should start by defining ownership boundaries inside these files, not by doing a cosmetic file split.

## Highest-Value Findings

### 1. High: legacy SSE endpoints bypass viewer authorization, and one is wired to the wrong event key

Evidence:

- `service/src/server.ts:151-176`
- compare with the ownership-aware thread stream in `service/src/routes/threads.ts:825-859`

`/api/runs/:runId/stream` and `/api/terminals/:budId/stream` are still mounted directly in `buildServer()` with no `requireViewer(...)`, no ownership lookup, and no `404` masking for cross-user access. That violates the ownership rules documented in `AGENTS.md`.

There is also a functional bug in the terminal endpoint: `TerminalEventBus` is keyed by `sessionId`, but `/api/terminals/:budId/stream` attaches by `budId`, so the route is not just unauthenticated, it is also not aligned with how terminal events are emitted.

Recommendation:

- remove these legacy endpoints if nothing still depends on them
- otherwise re-home them behind ownership-aware resource resolution before attaching SSE listeners
- do not keep both the legacy global stream surface and the modern thread-owned stream surface alive indefinitely

### 2. High: service startup hard-fails when no LLM provider key is configured, contradicting the documented local setup

Evidence:

- `service/src/server.ts:59-60`
- `service/src/llm/index.ts:45-67`
- `service/README.md:100-105`

`initializeProviders()` throws if neither OpenAI nor Anthropic is configured, but the README explicitly says auth and Bud claim testing do not require an LLM provider key. Right now that is not true in practice because server startup fails before any auth-only path can be exercised.

Impact:

- local auth and claim flows cannot be brought up incrementally
- operational readiness is coupled to an unrelated feature surface
- first-party mobile/auth work is harder to validate in isolation

Recommendation:

- make provider initialization feature-scoped instead of a global startup requirement
- let auth/device-claim/thread browsing boot with zero providers registered
- fail only when an agent or title-generation path actually needs a model

### 3. High: the seed script and gateway hash enrollment tokens differently, so seeded tokens cannot authenticate

Evidence:

- `service/src/scripts/seed.ts:8-12`
- `service/src/ws/gateway.ts:941-943`

The seed script uses:

```ts
createHash("sha256").update(`${hashSecret}:${tokenValue}`)
```

The gateway uses:

```ts
createHmac("sha256", config.enrollmentHashSecret).update(token)
```

These are different algorithms. A token created by the seed script will never match what the gateway expects during Bud enrollment.

Recommendation:

- define one shared `hashEnrollmentToken(...)` helper and use it from both places
- do not leave security-sensitive hashing logic duplicated in scripts and runtime code

### 4. High: canceling an agent turn does not abort in-flight terminal waits

Evidence:

- `service/src/agent/agent-service.ts:326-381`
- `service/src/agent/agent-service.ts:1034-1157`
- `service/src/runtime/terminal-session-manager.ts:913-1029`
- `service/src/runtime/terminal-session-manager.ts:1048-1133`
- `service/src/ws/gateway.ts:888-897`

`AgentService` stores an `AbortController` per thread and checks it around the model loop, but terminal waits are still plain promises with local timeouts. `observeTerminal(...)` and `sendInteraction(...)` do not accept an `AbortSignal`, and Bud offline transitions clear caches and emit offline events without rejecting pending send/observe requests.

Effect:

- `/api/threads/:threadId/cancel` can report success while the active step keeps hanging until `send_timeout` or `observe_timeout`
- Bud disconnects during a wait do not fail fast
- cancellation semantics are only half-implemented

Recommendation:

- plumb abort support into terminal send/observe paths
- add explicit `rejectPendingObservesForBud(...)` / `rejectPendingSendsForBud(...)` behavior on offline transition
- make terminal waits participate in the same cancellation model as provider calls

### 5. Medium: first-use terminal session creation is racy and can fail under concurrent access

Evidence:

- `service/src/runtime/terminal-session-manager.ts:209-239`
- `service/src/agent/agent-service.ts:1514-1529`
- `service/src/routes/threads.ts:741-756`

Session creation is currently "read active session, then insert". The DB enforces one active session per thread, but `createSessionForThread(...)` does not catch a concurrent unique violation and retry the lookup. That leaves a real race between:

- the browser creating the thread terminal
- the agent lazily creating the terminal on first tool use

Impact:

- avoidable `500 session_create_failed` or failed first message paths
- duplicated "get or create session" logic in both route and agent layers

Recommendation:

- replace the current pair of methods with a single ownership-aware `ensureSessionRecordForThread(...)`
- handle unique-conflict retry inside the session manager, not in callers

### 6. Medium: thread title generation assumes Anthropic is available, which makes OpenAI-only deployments noisy and brittle

Evidence:

- `service/src/agent/thread-title-service.ts:14-18`
- `service/src/agent/thread-title-service.ts:159-190`
- `service/src/llm/registry.ts:62-80`

Thread-title generation is hard-coded to `claude-haiku-4-5`. If only OpenAI is configured, `providerRegistry.getProviderForModel(...)` throws, which means every first user message produces avoidable warnings/failures even though the main agent path may otherwise be valid.

Recommendation:

- use the configured default model when it meets the title-generation requirements
- otherwise choose the cheapest available registered model dynamically
- title generation should degrade quietly when no compatible provider exists

### 7. Low: the context-sync heuristic can never classify the Node REPL correctly

Evidence:

- `service/src/terminal/context-sync-service.ts:158-178`

The generic shell prompt check:

```ts
if (/[❯λ➜>]\s*$/.test(trimmed)) {
  return "shell";
}
```

runs before the explicit Node REPL check:

```ts
if (trimmed === ">" && !capture.includes("Claude")) {
  return "repl";
}
```

So the Node REPL path is unreachable. That weakens the session-context sync logic and can lead to the wrong interaction mode being inferred after REPL launches.

Recommendation:

- move the Node REPL check above the generic shell `>` rule
- add a regression test for the `>` prompt case

### 8. Medium: the legacy standalone run subsystem is still a first-class runtime surface even though the agent has already moved to terminal tools

Evidence:

- `service/src/server.ts:50-60`
- `service/src/routes/runs.ts:16-75`
- `service/src/runtime/run-manager.ts:164-218`

The service still boots `RunManager`, exposes `/api/runs`, keeps a separate `RunEventBus`, and dispatches deprecated `shell.run` frames with `proto: "0.1"`. That is a meaningful amount of runtime surface area to keep alongside the newer thread-scoped terminal model.

This is not automatically wrong, but the current codebase does not treat it as either:

- an explicit compatibility surface with limited ownership, or
- a planned removal target

As a result, the service still has duplicated execution concepts, duplicated stream concepts, and duplicated lifecycle logic.

Recommendation:

- make an explicit decision: retain as compatibility-only or remove
- if retained, isolate it behind a module boundary and stop letting legacy stream routes leak into shared bootstrap
- if removed, do it deliberately after the thread-terminal path has the needed parity

## Secondary Debt

### Documentation and tooling drift around Drizzle is still present

The service package contains mixed guidance:

- `AGENTS.md` says schema-first `drizzle-kit push` is the authoritative workflow for now
- `service/drizzle/drizzle.spec.md` and `service/drizzle/migrations/migrations.spec.md` still describe the older generate/migrate-file workflow as the default path

That is not a runtime bug, but it will produce wrong operator behavior during future service refactors unless it is cleaned up.

## What Is Already Working

The review is not all negative. A few structural choices are already pointing in the right direction:

- the modern thread routes consistently use ownership-aware helpers such as `requireViewer(...)`, `getAuthorizedBud(...)`, and `getAuthorizedThread(...)`
- thread-scoped terminal sessions are the right persistence model for multi-thread work
- `AgentRuntimeStateManager`, `RunEventBus`, and `TerminalEventBus` provide a real seam for stream behavior
- there is useful targeted test coverage around agent runtime state, event-bus replay, terminal send outcome normalization, and thread-title normalization

Those are good anchors for the refactor.

## Recommended Refactor Sequence

### Phase 1: contain correctness and boundary bugs first

- remove or lock down the legacy unauthenticated stream routes
- unify enrollment-token hashing
- make zero-provider startup legal for non-agent service paths
- fix the Node REPL detection ordering bug

### Phase 2: split terminal runtime ownership

- extract session record lifecycle from `TerminalSessionManager`
- separate send/observe request dispatch from output persistence
- add fast-fail rejection for pending requests on cancel/offline transitions
- centralize `ensureSessionRecordForThread(...)` so routes and agents stop reimplementing it

### Phase 3: split agent runtime ownership

- extract conversation loading and transcript persistence out of `AgentService`
- isolate model streaming/invocation from terminal tool execution
- move cancellation and reasoning/model normalization into a dedicated runner layer

### Phase 4: split external transport surfaces

- break `routes/threads.ts` into smaller route modules
- split `ws/gateway.ts` into hello/auth, active-tracker management, and frame routing
- remove or quarantine the remaining global/legacy execution surfaces

### Phase 5: decide the legacy run story explicitly

- keep `RunManager` only if a real compatibility requirement still exists
- otherwise remove the standalone run/event surface after terminal-tool parity is confirmed

## Bottom Line

The service layer is refactor-ready now. The main risk is not that it is impossible to improve, but that the codebase will get harder to change if the team keeps adding features before resolving the remaining mixed-concern seams and legacy-path overlap.

The next refactor should start with boundary cleanup and cancellation correctness, then split the large orchestrator files around clear ownership seams. If that order is followed, the service can be modularized without changing its current product model.
