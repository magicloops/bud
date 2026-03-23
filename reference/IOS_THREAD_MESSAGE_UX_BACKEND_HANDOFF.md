# iOS Thread Message UX Backend Handoff

**Status:** Ready for backend review  
**Audience:** Backend, web platform, iOS, product  
**Last Updated:** 2026-03-22

## Purpose

This handoff is specifically for the next iOS thread-detail UX tranche.

Chat send and live stream now work end to end on mobile. The next mobile focus is improving the thread message experience:

- open threads at the latest messages
- keep the active turn visible while streaming
- load only the latest window first
- support scrolling upward into older history
- keep tool activity readable on mobile

The main remaining unknowns are now contract and behavior clarifications, not basic connectivity.

## Current iOS Position

What is already true on iOS:

- authenticated thread list, thread detail, send, and SSE are working
- mobile now receives `agent.tool_call`, `agent.tool_result`, `agent.message`, and `final`
- assistant text can already be updated progressively in the client model
- the next blocker is building a cleaner message viewport and transcript window model on top of the real backend behavior

Relevant current design:

- `design/chat/thread-message-ux-refresh.md`

## Product Direction For This Tranche

The desired mobile behavior is:

1. Opening a thread should land at the bottom of the latest loaded messages.
2. While the user is at the bottom, new sends and streamed updates should remain visible.
3. If the user scrolls up, mobile should stop auto-scrolling and allow them to read older content.
4. The app should load only the latest page initially, then request older messages as the user scrolls upward.
5. Tool activity can remain full-fidelity in payload shape for now; mobile will handle compact/collapsed presentation client-side.

Important note:

- compact tool summary fields are a nice-to-have, not a blocker for the next iOS implementation slice

## What iOS Needs Clarified Now

## 1. Document the real thread-message pagination contract

We believe the web app already supports the user pattern of:

- load the most recent messages first
- scroll upward to reveal older history

Please document the exact backend contract that supports that behavior.

Specifically, for `GET /api/threads/:thread_id/messages`, please clarify:

- the exact request shape web uses for the initial latest page
- the exact request shape web uses to load the next older page
- whether pagination uses `cursor`, `before`, `message_id`, `created_at`, or another mechanism
- sort order guarantees for each page
- whether page boundaries are inclusive or exclusive
- how the client should know whether older history still exists

### Requested examples

Please provide:

1. initial thread message request/response
2. next older page request/response
3. any `has_more`, `next_cursor`, `prev_cursor`, or equivalent metadata

### Why this matters

Without an explicit thread-message pagination contract, iOS cannot implement proper upward history loading for long threads. The current mobile handoff only documents `limit`, which is not enough.

## 2. Clarify `agent.message` text semantics

Please confirm whether `agent.message.text` is:

- the full accumulated assistant text so far, or
- a delta/chunk that should be appended by the client

If the answer is “it depends,” please document:

- the exact rules
- whether overlapping chunks can occur
- whether `final.text` is guaranteed to contain the fully accumulated assistant output

### Requested examples

Please provide one realistic stream example showing:

- the first `agent.message`
- one or more subsequent `agent.message` events
- the final event

The main need here is to know whether mobile should treat streamed assistant text as replace-with-latest or append-delta by contract.

## 3. Confirm any other transcript/stream gotchas the web app already handles

If web already has special-case logic around thread messages or agent SSE, please document it explicitly so iOS does not rediscover it by trial and error.

We especially want to know about:

- whether `final` is always emitted for successful turns
- whether `final` is emitted for failed or cancelled turns
- whether reconnect replay can include already-seen events
- whether message history can contain rows not seen in the live stream
- whether `system` rows can appear during normal thread usage
- whether thread titles can change as a side effect of send/stream completion

### Requested examples

Please provide short notes or payload examples for any of the above if they apply.

## 4. Confirm current tool payload expectations

For the next iOS slice, we are **not** asking for a compact tool summary field before implementation.

Mobile will start by:

- consuming the full tool payload
- collapsing it in the UI by default
- allowing expansion when the user wants details

That said, please confirm any stable current behavior around:

- tool payload truncation
- `metadata.truncated`
- `output_bytes`
- whether large tool outputs are intentionally capped server-side

This will help mobile decide how to label expanded or truncated tool rows.

## 5. Flag any mobile-relevant unknowns now

Please call out any known backend or web uncertainties that could affect this thread-detail tranche, especially if they relate to:

- message paging
- stream ordering
- replay behavior
- canonical transcript reconciliation after `final`
- unusually large tool outputs
- thread history behaviors that differ from what the current handoff implies

The main goal is to flush out contract gaps before iOS starts reworking the thread viewport and pagination model.

## What iOS Is Not Asking For In This Handoff

- terminal-specific UI contracts
- cancel vs interrupt UX
- reasoning-specific stream payloads before they are real
- mobile-specific replacement routes if the current web/backend routes already support the needed behavior
- a mandatory compact tool summary field before mobile can continue

## Recommended Backend Response Format

The easiest useful backend response would be:

1. exact route and query shape for initial message page
2. exact route and query shape for older-page loading
3. `agent.message` cumulative-vs-delta answer
4. any stream/transcript gotchas web already handles
5. any existing truncation or size-limit rules for tool payloads

If there is already an internal or web-facing doc that answers these, linking or copying the relevant section is sufficient.
