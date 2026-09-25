# Stable thread ordering

Status: implemented; manual concurrent-thread UI acceptance pending. Scope: conversation-list ordering on web and mobile.

## Problem

The web thread panel sorts by `last_activity_at`. The service advances that
timestamp for tool results and intermediate assistant messages as well as user
messages and final answers. Two active threads consequently overtake each other
throughout their work, making the list difficult to navigate.

## Ordering rules

Order by the most recent meaningful conversation event, newest first:

- Thread creation gives a new conversation its initial position.
- Accepting a new user message moves that conversation up immediately.
- Persisting the final assistant response for a turn moves it up once more.
- Streaming, tool results, reasoning, commentary, title changes, read receipts,
  terminal activity, and browser activity do not change its position.

A completed tool call or commentary segment is not a completed assistant turn.
A persisted final failure response counts as a final response. Cancellation or
failure without a final response does not promote the conversation. Waiting for
input, approval, or browser control does not promote it either; those states can
still update their indicators. Selecting a conversation never promotes it.

Two working threads remain in the same relative order until one receives a new
user message or finishes its turn. Completion may intentionally reorder the list.
This does not freeze the entire list while work is running.

## Implementation direction

Add a service-owned `thread.last_conversation_at` timestamp and expose it as
`last_conversation_at` in thread summaries. Keep `last_activity_at` for general
activity; changing its meaning risks affecting unrelated consumers.

Initialize the new value on creation. Advance it in the same transaction as an
accepted user-message insert or final assistant-message insert. Duplicate sends
and replayed events must not advance it. Use the persisted event timestamp, not
client receipt time, and preserve the greater existing value so delayed writes
cannot move a thread backward. Use a consistent server timestamp convention for
the insert and update.

Both the list query and client comparator use the same total order:
`last_conversation_at DESC, created_at DESC, thread_id DESC`. The default
most-recent-thread route uses that order too. SQL timestamp comparisons use
millisecond precision to match serialized client dates. Do not derive recency from message
counts, previews, stream activity, or local clocks.

Live updates carry the authoritative timestamp after commit through the existing
thread-summary update path, or a narrowly defined summary event if necessary.
Implementations must cover inactive threads as well as the selected thread.
Clients merge timestamps monotonically so a delayed snapshot or replay cannot
undo a newer update. Preview text and working/unread indicators may continue to
change without changing the ordering timestamp.

Backfill existing threads from the newest persisted user message or explicitly
identified final assistant response, falling back to thread creation. Use actual
final-response metadata (for example `segment_kind: final`), not merely
`role: assistant`; do not guess that unclassified historical commentary is final.

## Ownership and affected components

The thread remains the owned resource. Browser requests resolve the authenticated
viewer and authorize the owning Bud/thread before reads or writes; list queries
retain their owner predicates. Stream subscriptions authorize before attachment.
The new timestamp introduces no new ownership model or user-stamped rows; message
inserts retain their existing owner stamps. A model or client cannot supply an
arbitrary sorting timestamp.

Implementation touches thread schema/migration, message admission and final
transcript persistence, thread summary serialization/list ordering, live summary
updates, the web thread panel/default route, and mobile's thread-list comparator.
Update the relevant DB, agent, route, web and mobile specs plus
`docs/proto.md` for any summary/event contract changes. Add the corresponding
ownership validation item to the auth checklist if changing a read/stream path.

## Validation and rollout

- Run two threads with interleaved tool results, commentary and streaming: no
  movement until a qualifying event; each completion promotes its thread once.
- Sending a new user message promotes its thread; duplicate admission does not.
- Verify final failures, cancellations, handoffs and resumed turns follow the
  rules above, including updates for an inactive conversation.
- Verify equal timestamps, delayed events, refreshes and reconnects produce the
  same order on server, web and mobile. Backfill excludes intermediate messages.
- Preserve owner isolation and existing message-count/preview behavior.

Ship a checked-in migration and backfill, applying it locally through the existing
Drizzle workflow. Deploy the service contract and web consumer together, then
update mobile. An older mobile build will retain its current ordering until
upgraded; that temporary presentation difference does not require a second server
ordering mode. No daemon upgrade is needed.

Out of scope: pinned-thread behavior, preview redesign, new notification policy,
and global changes to activity tracking.

## References

- [Thread panel](../web/src/components/workbench/thread-panel.tsx)
- [Thread metadata](../service/src/db/thread-metadata.ts)
- [Transcript persistence](../service/src/agent/transcript-writer.ts)
- [Agent spec](../service/src/agent/agent.spec.md)
- [Database spec](../service/src/db/db.spec.md)

## Implemented mechanism

Migration 0043 uses a message INSERT trigger to keep promotion atomic across all
admission/transcript writers. A filtered thread trigger sends scope-only PG NOTIFY
hints after commit. The gateway exposes a Bud-owned SSE invalidation stream;
web and mobile fetch authoritative owned summaries on ready/change, including
inactive threads. No healthy progress polling. This requires session-preserving
PostgreSQL LISTEN connections and the checked-in SQL migration (not just push).
