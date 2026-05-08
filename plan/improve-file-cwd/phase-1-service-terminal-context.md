# Phase 1: Service Terminal Context

## Objective

Send thread terminal context with daemon `file_open` frames so the daemon can query a fresh tmux pane cwd for thread-owned file sessions.

This phase should not change browser/mobile APIs, file-session creation, path validation, or viewer behavior.

## Current Code

Relevant service files:

- `service/src/files/file-edge.ts`
- `service/src/files/file-runtime.ts`
- `service/src/files/file-session.ts`
- `service/src/routes/files.ts`
- `service/src/routes/threads/files.ts`

Current `openFileEdgeStream(...)` sends:

```ts
{
  type: "file_open",
  file_session_id: args.session.fileSessionId,
  root_key: args.session.rootKey,
  relative_path: args.session.relativePath,
  mode,
}
```

The `FileSessionRow` already has optional `threadId`. The thread-scoped product route stamps it during session creation.

## Implementation Steps

1. Decide how to derive the daemon terminal session id for `args.session.threadId`.

   Likely options:

   - reuse the existing service helper that derives thread-scoped terminal session ids
   - query the owned `terminal_session` row for the thread and Bud
   - compute the canonical `bud-{budId}-thread-{threadId}` id if that remains the contract

2. Add optional terminal context to `file_open` in `service/src/files/file-edge.ts`.

   Proposed minimal JSON field:

   ```json
   {
     "terminal_session_id": "bud-b_123-thread-456"
   }
   ```

3. Include terminal context in durable operation/audit request metadata.

   Add only non-sensitive identifiers:

   - `thread_id`
   - `terminal_session_id`
   - `resolution_order: ["terminal_cwd", "workspace"]`

4. Update `service/src/files/file-runtime.ts` to tolerate optional accepted-result metadata:

   - `resolved_against`
   - `resolved_relative_path`
   - optional `resolution_fallback_reason`

   These fields should be optional and should not affect HTTP behavior.

5. Decide whether to expose result metadata beyond logs.

   First-pass recommendation:

   - preserve metadata in the runtime result
   - include it in audit/logging where useful
   - do not persist it to `file_session` unless needed

## Tests

Add or update service tests to prove:

- file sessions without `threadId` send no terminal context
- thread-owned file sessions send the expected terminal session id
- old accepted `file_open_result` frames without metadata still parse
- new accepted `file_open_result` frames with `resolved_against` metadata parse and preserve it
- operation/audit metadata does not include raw absolute cwd

Potential test locations:

- `service/src/files/file-runtime.test.ts`
- a focused `file-edge` test if one exists or is practical to add
- route/edge integration tests if current test harness can inspect sent control frames

## Spec Updates

Update in the same implementation slice:

- `service/src/files/files.spec.md`
- `docs/proto.md`
- `proto/bud/v1/bud.proto` and wire tests if typed protobuf fields are added

## Acceptance Criteria

- Service can send old-compatible `file_open` frames with optional terminal context.
- No browser/mobile request contract changes.
- No database migration.
- Existing file viewer happy path continues to work against daemons that ignore the new field.
