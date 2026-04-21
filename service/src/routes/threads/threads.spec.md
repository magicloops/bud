# threads

Thread-route submodules split out of the top-level `routes/threads.ts` composition root.

## Purpose

Keeps browser-visible thread ownership checks explicit while splitting the old monolithic thread transport file into smaller route groups:
- core thread CRUD
- message history/create flows
- agent state/stream/cancel
- terminal create/ensure/input/history/stream

## Files

### `shared.ts`

Shared Zod schemas, cursor helpers, serialization helpers, and ownership-aware thread lookup.

### `core.ts`

Thread list/create/read/delete routes.

### `messages.ts`

Thread message history and create/send routes, including pre-flight context sync and first-message title kickoff.

### `agent.ts`

Agent runtime routes for `/agent/state`, `/agent/stream`, and `/cancel`.

### `terminal.ts`

Thread-scoped terminal routes for session create/ensure/read, SSE attach, human input/resize, and history reads.

### `registration.test.ts`

Regression test for the split thread-route registration surface.

**Current Coverage**:
- the split core/message/agent/terminal modules register the expected endpoint set
- route registration remains duplicate-free after the decomposition

## Ownership Notes

- every exported route module resolves thread ownership at the route boundary through `requireAuthorizedThreadAccess(...)`
- SSE attach happens only after ownership is resolved
- terminal routes still stamp and enforce the owning human through the terminal runtime

---

*Parent spec: [../routes.spec.md](../routes.spec.md)*
