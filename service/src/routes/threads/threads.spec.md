# threads

Thread-route submodules split out of the top-level `routes/threads.ts` composition root.

## Purpose

Keeps browser-visible thread ownership checks explicit while splitting the old monolithic thread transport file into smaller route groups:
- core thread CRUD
- message history/create flows
- read-watermark updates for unread-attention state
- agent state/stream/cancel
- terminal create/ensure/input/history/stream

## Files

### `shared.ts`

Shared Zod schemas, cursor helpers, model-selection serialization/metadata helpers, and ownership-aware thread lookup.

### `core.ts`

Thread list/create/read/delete routes plus `PATCH /api/threads/:threadId/model-preference` for owned model/reasoning selection persistence.

### `core.test.ts`

Focused route-handler coverage for thread-list serialization.

**Current Coverage**:
- `GET /api/threads` maps unread-attention state into `has_unseen_attention` and `last_attention_kind`
- thread-list serialization includes stored/effective model-selection fields
- `PATCH /api/threads/:threadId/model-preference` persists a validated concrete selection and rejects missing models

### `messages.ts`

Thread message history, read-watermark, and create/send routes, including pre-flight context sync and first-message title kickoff.

### `messages.test.ts`

Focused route-handler coverage for the thread read-watermark route.

**Current Coverage**:
- `POST /api/threads/:threadId/read` upserts the watermark when the seen message is newer
- stale read-watermark updates return `updated: false` and do not rewrite the row
- create-message rejects invalid explicit model/reasoning selections before duplicate lookup or persistence

### `agent.ts`

Agent runtime routes for `/agent/state`, `/agent/stream`, and `/cancel`.

### `terminal.ts`

Thread-scoped terminal routes for session create/ensure/read, SSE attach, human input/interrupt/resize, and history reads.

The interrupt route sends a human Ctrl+C through the terminal runtime and rejects older pending terminal waits as `interrupted`, so a long settled agent tool can return a conservative tool result instead of remaining pending for the full settled timeout.

### `terminal.test.ts`

Focused route-handler coverage for the terminal interrupt route.

**Current Coverage**:
- owned terminal interrupt returns dispatch metadata from the terminal manager
- missing active sessions return `404 no_terminal_session`

### `registration.test.ts`

Regression test for the split thread-route registration surface.

**Current Coverage**:
- the split core/message/agent/terminal modules register the expected endpoint set
- route registration remains duplicate-free after the decomposition

## Ownership Notes

- every exported route module resolves thread ownership at the route boundary through `requireAuthorizedThreadAccess(...)`
- SSE attach happens only after ownership is resolved
- terminal routes still stamp and enforce the owning human through the terminal runtime
- thread model-preference updates resolve through the same owned-thread boundary and return `404` for signed-in non-owners

---

*Parent spec: [../routes.spec.md](../routes.spec.md)*
