# iOS Chat Backend Handoff

**Status:** Ready for backend review  
**Audience:** Backend, web platform, iOS, product  
**Last updated:** 2026-03-20

## Purpose

This document is the concrete backend handoff for the next major iOS tranche after auth:

- make chat work against the existing backend
- preserve the current mobile conversation/block architecture
- prefer existing routes and existing product behavior wherever that keeps the system simpler and more robust

This handoff is intentionally focused on:

- thread list
- Bud filtering and Bud selection
- conversation/thread detail
- send message
- streaming
- the minimum payload examples and docs iOS needs to implement `NetworkChatBackend`

This is **not** the terminal-view tranche, and it is **not** asking backend to fully solve mobile-native structured block parity before list/detail/send can start.

## Current iOS Position

What is already true on iOS:

- auth is working locally through the real hosted OAuth flow
- `/api/me` bootstrap works
- the app already has a stable app-owned chat model and backend seam
- `ChatStore` depends on `ChatBackend`
- `ChatBackendAdapter` already exists as the intended raw-payload mapping seam
- the only missing runtime piece is a real authenticated backend contract and implementation

Important architectural constraint:

- iOS does **not** want to rewrite the chat UI around raw backend tables
- iOS will adapt backend Bud/thread/message/run state into its own:
  - `ChatConversationSummary`
  - `ChatConversation`
  - `ChatTurn`
  - `ChatBlock`
  - `MiniAppSessionDescriptor`

## Product Decisions For The First Chat Tranche

These decisions are now the desired mobile behavior:

### 1. Primary list is thread-first

The main mobile chat list should show:

- threads, regardless of Bud

It should not require the user to first drill into a Bud before seeing conversations.

### 2. Bud is a filter and creation context

The thread list should support:

- filtering by Bud

For new chat creation:

- the app should default to the currently selected Bud
- the selected Bud should be local app state
- the selected Bud should default to the most recently used Bud
- the user must still be able to pick a different Bud before starting the new thread

### 3. Existing routes are preferred

The iOS team strongly prefers:

- using the existing backend/web routes where possible

Reason:

- simpler is more robust
- parity is easier to maintain if mobile uses the same core routes and semantics as web

We are open to mobile-specific endpoints only where the current route shape clearly makes the mobile integration awkward or unstable.

### 4. Terminal-specific cancel vs interrupt is real, but not the first blocker

We understand:

- cancel-agent and interrupt-terminal are distinct backend actions

That difference matters, but it should not block the first thread list/detail/send/stream tranche because the terminal view is not the immediate next iOS milestone.

## Recommended First-Pass Mapping

The current recommended mapping on iOS is:

| Backend concept | Mobile concept | Notes |
|---|---|---|
| `bud` | metadata/filter/create-thread context | not the primary list unit |
| `thread` | `ChatConversation` | canonical list/detail/send/stream unit |
| `message` | `ChatTurn` | plain text first |
| `run` | conversation activity / streaming state | may later map to blocks or synthetic turns |
| `terminal_session` | thread-associated runtime state | later tranche |

This means the immediate integration target is a thread-first mobile contract, with Bud metadata attached where needed for filtering and new-thread creation.

## What iOS Needs From Backend Now

## 1. Confirm how to support a thread-first list with existing routes

Please document how the current backend routes support:

- listing all visible threads for the authenticated user, regardless of Bud
- filtering those threads by Bud
- returning enough Bud metadata to label/filter a thread row cleanly

Please be explicit about whether iOS should use:

- existing `/api/threads` with query params
- a Bud route plus client-side fanout
- another existing route
- a new route only if absolutely necessary

### Requested examples

Please provide:

- request example for "all my threads"
- request example for "my threads filtered to Bud X"
- one response example for each

## 2. Confirm the Bud list / Bud metadata contract needed for filtering and new chat

For the thread filter and new-thread Bud picker, iOS needs:

- a way to list the current user's visible Buds
- enough metadata to display them simply in a picker/filter

Please document:

- which existing route should be used
- exact response shape
- whether a Bud has a canonical display name
- whether there is any ordering or "recently used" signal from the backend that mobile should consider

### Requested examples

Please provide one response example for:

- the authenticated Bud list used by mobile filter/picker UI

## 3. Confirm the canonical send-message and thread-creation contracts

This is the most important action contract we need from backend.

Please document the intended first-pass mobile behavior for:

- send a message into an existing thread
- create a new thread under a selected Bud
- send the first message in a new thread

Please be explicit about whether the intended routes are:

- `POST /api/threads`
- `POST /api/runs`
- thread creation followed by another route
- another existing route pattern

### Requested examples

Please provide:

1. existing-thread send request/response
2. new-thread creation request/response
3. "create thread and first message" request/response if that is a combined flow

## 4. Confirm the canonical streaming contract

Please document the native-usable streaming path for thread updates.

We prefer to use the existing streaming routes if they can support the thread-first mobile UX cleanly.

Please document:

- exact route(s)
- whether streaming is thread-scoped, run-scoped, or Bud-scoped
- auth behavior for the stream
- event format
- event ordering guarantees
- heartbeat behavior
- reconnect expectations
- how mobile should know the thread detail is up to date after reconnect

### Requested examples

Please provide:

- one end-to-end example event stream for a user message followed by agent activity and final completion

## 5. Provide one concrete lifecycle example across existing functionality

Please provide a single canonical example showing:

1. load thread list
2. open thread detail
3. send user message
4. backend creates or updates run state
5. assistant and/or tool output arrives
6. final thread state settles

This should use the actual existing route family you want mobile to adopt first.

The main need here is clarity, not abstraction.

## 6. Publish representative sample payload fixtures

Please provide real or realistic sample payloads for:

- thread list
- thread list filtered by Bud
- Bud list/filter data
- thread detail
- send-message response
- stream events

These will be used directly for iOS adapter tests and implementation validation.

## 7. Clarify response casing and any route inconsistencies

The existing docs still indicate mixed snake_case and camelCase responses in different endpoints.

Please do one of the following:

- normalize the first-pass mobile-facing routes, or
- explicitly document the mixed casing as a stable contract

Either is workable, but implicit inconsistency is not.

## Things We Are Explicitly Not Asking Backend To Solve First

To keep this tranche simple, iOS is **not** asking backend to block list/detail/send work on:

- final terminal view semantics
- full mobile-native structured block parity
- mini-app session parity
- account settings shell cleanup
- auth UI-test readiness

Those can follow after the real chat data path is stable.

## Lower-Priority But Useful Backend Notes

These are real, but not the first blocker:

- cancel vs interrupt semantics
- terminal session recreation limitation
- richer structured payload design
- mini-app session creation/loading contract

Please keep documenting them, but they do not need to be solved before the first thread list/detail/send slice starts.

## iOS Implementation Preference

The intended first iOS implementation shape is:

- `NetworkChatBackend`
- authenticated transport using the existing app session
- DTOs for raw backend payloads
- adapters mapping those payloads into the existing mobile chat model

That means backend does **not** need to redesign the system around iOS. What iOS needs most is:

- a clear, concrete, example-driven contract for the current routes and behaviors

## Open Questions For Backend

1. What exact existing route should iOS use for "all visible threads"?
2. How should Bud filtering be expressed on that route?
3. What exact route should iOS use to list Buds for the filter/new-thread picker?
4. What is the canonical first-pass send-message flow?
5. What is the canonical first-pass create-thread-under-Bud flow?
6. What is the canonical streaming route and scope for native clients?
7. Which route and payload examples should iOS treat as the contract source of truth?

## Recommended Next Step

Please respond with either:

1. a filled version of this handoff using existing routes and real payload examples, or
2. a dedicated backend/mobile chat contract doc that answers the asks above

Once that exists, iOS can start the concrete `NetworkChatBackend` implementation spec immediately.

## Related Docs

- `design/chat/ios-backend-chat-integration.md`
- `design/chat/PROGRESS.md`
- `plan/chat-ui/07-post-phase-6-architecture-summary.md`
- `plan/chat-ui/08-backend-hardening-and-dogfood-readiness.md`
- `reference/authentication-and-user-ownership.md`
- `reference/backend-web-better-auth-oauth-provider-spec.md`
