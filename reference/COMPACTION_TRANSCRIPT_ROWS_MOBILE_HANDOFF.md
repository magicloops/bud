# Mobile handoff: compaction transcript rows (`role: "compaction"`)

Date: 2026-09-03 · Contract: `docs/proto.md` (message roles; `agent.compaction_done`)

## What changed

Automatic context compactions are now **durable transcript rows**. Every time
the service compacts a thread's model context, it writes one message with
`role: "compaction"` at the position of the cut, and attaches the same row to
the `agent.compaction_done` SSE event as `message`. Existing threads were
backfilled, so historical compactions have rows too.

Until now the only signal was the stream event (session-only); the summary
the model carries was never exposed to clients.

## The row

```json
{
  "message_id": "…",
  "client_id": "uuidv7",
  "role": "compaction",
  "display_role": "Context compacted",
  "content": "<the summary the model now carries in place of the earlier history — markdown>",
  "created_at": "2026-09-03T10:00:05.000Z",
  "metadata": {
    "artifact_kind": "context_compaction",
    "model_visible": false,
    "status": "completed",
    "checkpoint_id": "01CHK…",
    "turn_id": "01TURN…",
    "trigger": "auto",
    "reason": "context_limit",
    "phase": "pre_turn | mid_turn | standalone_turn",
    "tokens_before": 245000,
    "tokens_after": 12000,
    "compacted_through_message_id": "…",
    "compacted_through_llm_call_id": "…",
    "source_provider": "openai",
    "source_model": "gpt-5.6-sol",
    "source_reasoning_effort": "low",
    "replacement_history_message_count": 3
  }
}
```

- `created_at` is the checkpoint completion time: chronologically right after
  the last message the model still sees verbatim. For `mid_turn` compactions
  the row sits between tool rows of the same turn — that is where the cut is.
- `turn_id` is present on rows written live; backfilled rows omit it.
- `content` can be empty (a checkpoint without a summary); treat that as
  "nothing to expand".

## Where it shows up

- `GET /api/threads/:thread_id/messages` — interleaved with other rows,
  cursor-paginated like everything else.
- `agent.compaction_done` — additive `message` field with the same row. Older
  services omit it; keep whatever you do today for that case.

## What mobile must do (minimum)

1. **Do not fail on the unknown role.** A row with `role: "compaction"` must
   render as nothing (or a divider) — never as assistant text, never a crash.
   This is the only hard requirement before/at service deploy.
2. Treat it like `reasoning` rows for everything else: not assistant text for
   previews, unread/attention math, or push copy. (The service already
   excludes it from `message_count`, previews, attention and notifications on
   its side.)

## What mobile can do (matches web)

- Collapsed: a centered divider pill — `display_role` + phase +
  `tokens_before → tokens_after` (web formats as "Mid-turn · 245k → 12k").
- Expanded (tap): render `content` as markdown under a caption like
  "What the model now remembers of the conversation above".
- On `agent.compaction_done`, upsert `message` by `client_id` exactly like an
  `agent.message` row; when absent, fall back to a session-only marker.

## Rollout order

Service (writes rows) → backfill (idempotent; historical rows) → web. Mobile
only needs (1) above to be safe against the service deploy; the rest can
follow.
