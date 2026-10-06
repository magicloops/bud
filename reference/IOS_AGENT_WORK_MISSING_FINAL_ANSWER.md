# Earlier history: agent runs with no final answer

Date: October 2, 2026. From the iOS team. Short request for a backend check.

## Problem

When the app loads earlier history (`GET /api/threads/:id/messages?before=…`), some
agent runs have no final assistant message after their work. Mobile then cannot
collapse that work into a "Worked for …" row and shows tools, reasoning and commentary
inline.

As far as the user knows, these runs did finish with an answer. We believe the final
message is either missing from the response, classified as intermediate, or ordered
before the work, and suspect a recent backend change.

## What mobile expects

Per run, in `created_at` order, with `segment_kind` read from `metadata.segment_kind`:

```text
user message
  reasoning / tool / assistant(segment_kind = "intermediate")   ← agent work
assistant(segment_kind = "final")                                 ← final answer
next user message
```

Work collapses only when the next assistant message after it has
`segment_kind: "final"`, is complete and has text. An assistant row with
`segment_kind: "intermediate"` is treated as commentary inside the work.

## What we observed

Device trace on October 2, 2026 (iOS 0.2.0, backend PR #139 branch on the local test
service), one long thread:

- The window returned by `GET /api/threads/:id/open` (latest 100 messages): every run
  has a final answer and collapses correctly.
- Two earlier pages from `GET …/messages?before=…` (about 270 KB each): several runs
  have **no assistant message classified as final** between their work and the next
  top-level row. One page has a 32-row run like this; others have 1–5 rows.
- None of these runs is flagged as still running, and no final message is missing its
  `segment_kind`; the final message is simply not where we expect it.

The client's mapping and projection did not change in the build that showed this
(only where decoding runs); the same rule has been in place since September 12.

## Likely causes, in order

1. **Final answers stored or returned as `segment_kind: "intermediate"`.** Mobile
   would then show the answer as commentary inside the work, which would match what
   users describe (commentary rendered inline with the tools).
2. **Final answer missing from `before=` pages**, for example a filter, a page
   boundary, or a row written in a later transaction.
3. **Final answer's `created_at` earlier than the work's rows**, so it sorts above the
   run instead of after it.

## What we need

For the affected thread (ID: _to fill in_), for each user message in the older pages:

1. the rows up to the next user message, in returned order, with `role`,
   `metadata.segment_kind`, `created_at` and `message_id`;
2. whether those runs ended with a final answer in the database;
3. any recent change to how `segment_kind` is set, how final messages are persisted,
   or what `messages?before=` returns.

## Mobile side, meanwhile

We have a client change ready that collapses work once a later user message proves the
run ended (the documented rule in `mobile-agent-work-collapse-web-handoff.md`). We are
holding it: if cause 1 is right, it would hide real final answers inside a collapsed
"Worked" row.
