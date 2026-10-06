# Phase 1: Exact message cursors

Status: Service and web implemented; real-PG traversal and mounted reset pass.
Request: F3. Native adoption/physical acceptance pending.

## Contract and implementation

Update `routes/threads/shared.ts` and `message-loader.ts`. Cursor v2 is opaque
base64url JSON containing `v:2`, `thread_id`, `created_at` and `message_id`.
`created_at` is normalized UTC with six fractional digits. Select it from
PostgreSQL alongside the row using an explicit UTC formatting expression;
never pass the cursor timestamp through JS Date or a Date-mapping ORM encoder.
Public message `created_at` display serialization need not change.

Validate version, exact timestamp calendar validity, UUID fields and thread
binding; cap encoded input at 2048 characters. Bind the validated string as a
SQL parameter cast to `timestamptz`. Use the exact timestamp and message ID as
the same lexicographic key in ORDER BY and strict before/after comparisons.
Retain owner/thread filters. Do not use `<=`, round stored dates, or expose the
extra cursor-only selected field in message payloads.

Return `400 {"error":"invalid_message_cursor"}` for malformed, unsupported or
wrong-thread cursors; do not perform a global anchor lookup. `/open` and
`/messages` must use the same encoder. An exact tuple continues working after
its anchor row is deleted.

Web/mobile treat this error as one window reset: discard old pagination state,
bootstrap `/open`, preserve separately tracked optimistic sends, then rebuild
history on demand. Do not retry the bad cursor or pretend the failed page is
the end of history. Generic network errors retain normal explicit retry behavior.
Coordinate v1 cursor reset in mounted and disk-cached clients at release.

## Tests and completion

- [ ] PostgreSQL rows at `.123100`, `.123400`, `.123900` and exact-equal timestamps
      with different IDs; before/after traversal at limits 1, 2 and 100.
- [ ] Every row appears exactly once; deleted anchor still gives correct boundary.
- [ ] Empty/first/last pages and open-produced cursors match normal history.
- [ ] Malformed/oversized/date-invalid/v1/wrong-thread cursors fail consistently.
- [ ] Foreign-owner requests return existing auth/resource errors without leakage.
- [ ] Web reset test and mobile fixture cover a rejected old cursor, optimistic
      sends and successful new bootstrap without a retry loop.

Link the existing missing-final debug note in the change. Audit other cursor
Date conversions, but record unrelated fixes separately rather than silently
expanding this phase. No DB schema or daemon change.
