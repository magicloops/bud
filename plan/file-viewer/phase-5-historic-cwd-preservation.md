# Phase 5: Historic CWD Preservation

**Implementation status:** Complete on 2026-05-06.

**Verification status:** Focused daemon tests, focused service tests, service
build, `git diff --check`, and manual web project-switch validation have passed.

## Context

Related design:

- [../../design/file-viewer-historic-cwd-preservation.md](../../design/file-viewer-historic-cwd-preservation.md)

Related specs:

- [../../bud/src/terminal/terminal.spec.md](../../bud/src/terminal/terminal.spec.md)
- [../../bud/src/files/files.spec.md](../../bud/src/files/files.spec.md)
- [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md)
- [../../service/src/files/files.spec.md](../../service/src/files/files.spec.md)
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md)
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md)
- [../../docs/proto.md](../../docs/proto.md)

## Objective

Preserve the terminal cwd that was current when a transcript message was
created, then use that message-time cwd as the first file-open resolution base
when a user clicks a file link from that message later.

Acceptance criteria:

- New assistant and tool messages carry path-context metadata when the active
  terminal session has a cached daemon-reported cwd.
- New user messages can carry the latest cached path context without requiring a
  daemon request before the agent responds.
- File sessions created from a source message copy only server-loaded,
  authorized source-message path context.
- Bud file opens with a source-message cwd hint resolve relative paths against
  message-time cwd first, then workspace root.
- Context-bearing file opens do not fall back to click-time tmux cwd, so old
  message links do not drift after the thread changes projects.
- Existing contextless file opens keep the current behavior: fresh tmux cwd
  first, workspace root second.
- No database migration is required if the implementation reuses
  `terminal_session.cwd` and `message.metadata`.

## Fixed Direction

Use raw daemon-reported `host_cwd` for the first pass. Do not add
`workspace_relative_cwd`, cwd stripping, visible cwd divider messages, or a
daemon `file_resolve` round trip in this phase.

The primary cwd refresh source should be terminal result frames, not only
terminal status. `terminal_status.info.cwd` remains useful during session
ensure/reattach, but `terminal_send_result.host_cwd` and
`terminal_observe_result.host_cwd` are the result-boundary signals needed for
"after the final terminal tool result" semantics.

## Protocol Changes

All changes are additive and optional.

### Terminal Result Frames

Extend Bud-to-service terminal result frames:

```json
{
  "type": "terminal_send_result",
  "session_id": "sess_...",
  "request_id": "send_...",
  "submitted": true,
  "readiness": {},
  "host_cwd": "/Users/adam/bud/service",
  "error": null
}
```

```json
{
  "type": "terminal_observe_result",
  "session_id": "sess_...",
  "request_id": "obs_...",
  "view": "delta",
  "output": "...",
  "host_cwd": "/Users/adam/bud/service",
  "error": null
}
```

Service should accept both `host_cwd` and missing `host_cwd`. If a daemon cannot
query cwd, it should omit the field rather than failing the terminal request.

Shared protobuf field numbers:

- `TerminalSendResult.host_cwd = 7`
- `TerminalObserveResult.host_cwd = 11`

### File Open Frame

Extend service-to-Bud `file_open` with an optional resolver hint:

```json
{
  "type": "file_open",
  "terminal_session_id": "sess_...",
  "root_key": "workspace",
  "relative_path": "src/files/file-session.ts",
  "resolution_hint": {
    "kind": "host_cwd",
    "host_cwd": "/Users/adam/bud/service",
    "source_message_id": "..."
  }
}
```

`resolution_hint` is never accepted from the browser. It is service-created from
authorized source-message metadata.

### File Open Result

Add `message_cwd` to the allowed diagnostic values for `resolved_against`.
Existing values stay valid:

- `message_cwd`
- `terminal_cwd`
- `workspace`

## Bud Daemon Work

1. Extend protocol structs and binary envelope codecs.

   Files:

   - [../../bud/src/protocol.rs](../../bud/src/protocol.rs)
   - [../../bud/src/proto_wire.rs](../../bud/src/proto_wire.rs)

   Add a deserializable `FileOpenResolutionHint` with `kind`, `host_cwd`, and
   optional `source_message_id`. Add optional `host_cwd` support for
   `terminal_send_result` and `terminal_observe_result` in the JSON/proto wire
   path. Pick new proto field numbers that do not collide with existing terminal
   result or file-open fields.

2. Emit cwd on terminal send and observe results.

   Files:

   - [../../bud/src/terminal/interaction.rs](../../bud/src/terminal/interaction.rs)
   - [../../bud/src/terminal/observe.rs](../../bud/src/terminal/observe.rs)
   - [../../bud/src/terminal/backend.rs](../../bud/src/terminal/backend.rs)

   After the existing post-send or observe capture completes, call
   `backend.pane_cwd(&handle.session_name).await.ok()` and include the result as
   `host_cwd` when present. Log cwd-query failure at debug/warn level without
   changing the terminal result outcome.

3. Skip click-time cwd lookup for hinted file opens.

   File:

   - [../../bud/src/app.rs](../../bud/src/app.rs)

   The current dispatcher queries `fresh_pane_cwd_for_session()` whenever
   `terminal_session_id` is present. For frames with
   `resolution_hint.kind = "host_cwd"`, skip that query and pass no
   click-time cwd. This keeps the old message link pinned to message-time
   context and avoids an unnecessary tmux call.

4. Resolve hinted file opens against message cwd first.

   File:

   - [../../bud/src/files/mod.rs](../../bud/src/files/mod.rs)

   Resolution order:

   - If `resolution_hint.host_cwd` is present and valid:
     1. canonicalized `host_cwd + relative_path`, reported as `message_cwd`
     2. `workspace_root + relative_path`, reported as `workspace`
   - If `resolution_hint.host_cwd` is present but invalid or outside
     `workspace_root`:
     1. `workspace_root + relative_path`, reported as `workspace`
   - If no resolution hint was provided:
     1. fresh terminal cwd candidate, reported as `terminal_cwd`
     2. `workspace_root + relative_path`, reported as `workspace`

   The hinted cwd candidate must be absolute, canonicalizable, and inside
   `workspace_root`. The final file path must still pass the existing symlink,
   regular-file, canonical workspace-root, range, size, and content-identity
   checks.

5. Add daemon tests.

   Cover:

   - terminal send result includes `host_cwd` when tmux reports cwd
   - terminal observe result includes `host_cwd` when tmux reports cwd
   - hinted file open prefers `message_cwd` over workspace when both contain the
     same relative path
   - hinted file open does not use click-time terminal cwd
   - invalid or outside-workspace hinted cwd falls back to workspace root
   - contextless file open keeps current terminal-cwd-first behavior

## Service Work

1. Extend terminal frame schemas and types.

   Files:

   - [../../service/src/ws/protocol.ts](../../service/src/ws/protocol.ts)
   - [../../service/src/terminal/types.ts](../../service/src/terminal/types.ts)
   - [../../service/src/proto/wire.ts](../../service/src/proto/wire.ts)
   - [../../service/src/proto/wire.test.ts](../../service/src/proto/wire.test.ts)

   Add optional `host_cwd` to terminal result schemas and TypeScript result
   interfaces. Keep older daemon frames valid.

2. Persist and expose latest terminal cwd.

   Files:

   - [../../service/src/runtime/terminal/session-types.ts](../../service/src/runtime/terminal/session-types.ts)
   - [../../service/src/runtime/terminal/session-store.ts](../../service/src/runtime/terminal/session-store.ts)
   - [../../service/src/runtime/terminal-session-manager.ts](../../service/src/runtime/terminal-session-manager.ts)
   - [../../service/src/runtime/terminal/request-dispatcher.ts](../../service/src/runtime/terminal/request-dispatcher.ts)

   Update `TerminalSession` to include `cwd: string | null`. Persist
   `terminal_status.info.cwd` into `terminal_session.cwd`. When send/observe
   results include `host_cwd`, persist it before resolving the terminal tool
   promise, so downstream transcript writes can read the updated cwd.

   Add a small helper on `TerminalSessionManager`, for example
   `getPathContextForSession(sessionId)`, returning:

   ```json
   {
     "schema": "terminal_cwd_v1",
     "source": "terminal_runtime_cache",
     "reported_by": "tmux_pane_current_path",
     "terminal_session_id": "sess_...",
     "host_cwd": "/Users/adam/bud/service",
     "captured_at": "2026-05-06T12:00:00.000Z"
   }
   ```

   Return `null` if there is no cached cwd.

3. Stamp transcript messages.

   Files:

   - [../../service/src/agent/agent-service.ts](../../service/src/agent/agent-service.ts)
   - [../../service/src/agent/transcript-writer.ts](../../service/src/agent/transcript-writer.ts)
   - [../../service/src/agent/terminal-tool-executor.ts](../../service/src/agent/terminal-tool-executor.ts)
   - [../../service/src/routes/threads/messages.ts](../../service/src/routes/threads/messages.ts)

   For terminal tool execution, capture pre-tool path context before dispatch and
   post-tool path context after the terminal result has updated the cache.

   Metadata shape:

   - assistant messages: `metadata.path_context`
   - user messages: `metadata.path_context`
   - tool messages: `metadata.path_context_before` and
     `metadata.path_context_after`

   Final assistant messages after tool calls use the latest post-tool context.
   Final assistant messages with no tool calls reuse the latest cached context
   and do not query the daemon.

4. Load source-message path context in the file-open route.

   File:

   - [../../service/src/routes/threads/files.ts](../../service/src/routes/threads/files.ts)

   When `source.message_id` is present, load the message with:

   - same `thread_id`
   - same authorized viewer ownership expectations
   - matching `message_id`

   If the row exists and contains `metadata.path_context.host_cwd`, copy that
   object into `display_metadata.path_context`. Ignore any client-supplied cwd or
   path context. If the source message is absent, proceed without context rather
   than exposing cross-thread message existence.

   Tool-message file links are not a first-pass product surface, but if they
   become clickable before a later resolver pass, use `path_context_after` as the
   default context and retain `path_context_before` only for audit/debug.

5. Send resolver hints to the daemon.

   Files:

   - [../../service/src/files/file-edge.ts](../../service/src/files/file-edge.ts)
   - [../../service/src/files/file-session.ts](../../service/src/files/file-session.ts)

   Extract `display_metadata.path_context.host_cwd` from the file session and
   include it as `resolution_hint` in both the durable operation request and the
   live `file_open` control frame. Do not put a resolver hint on sessions that
   lack a validated server-side path context.

6. Add service tests.

   Cover:

   - terminal status persists `cwd`
   - terminal send/observe result `host_cwd` updates `terminal_session.cwd`
   - transcript writer serializes assistant `path_context`
   - tool messages serialize both before and after contexts
   - user message route stamps cached path context when available
   - file-open route loads source-message context from the same authorized
     thread and ignores missing or foreign source messages
   - file edge includes `resolution_hint` only when server-side display metadata
     has a valid path context

## Documentation And Specs

Update:

- [../../docs/proto.md](../../docs/proto.md): terminal result `host_cwd`,
  `file_open.resolution_hint`, and `resolved_against: "message_cwd"`
- [../../bud/src/terminal/terminal.spec.md](../../bud/src/terminal/terminal.spec.md):
  result-frame cwd reporting
- [../../bud/src/files/files.spec.md](../../bud/src/files/files.spec.md):
  message-cwd resolution order
- [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md):
  cached terminal cwd and path-context helper
- [../../service/src/files/files.spec.md](../../service/src/files/files.spec.md):
  resolver hint propagation
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md):
  source-message context lookup in thread file-open route
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md):
  transcript path-context metadata
- [./file-viewer.spec.md](./file-viewer.spec.md): this phase document

No Drizzle migration is expected because `terminal_session.cwd` and
`message.metadata` already exist. If the implementation adds a dedicated
path-context column instead, follow the schema-change workflow in
[../../AGENTS.md](../../AGENTS.md).

## Rollout Order

1. Add optional protocol/schema support service-side first so older and newer
   daemon frames are accepted.
2. Add daemon `host_cwd` emission and hinted file resolution.
3. Persist service-side cwd and stamp transcript metadata.
4. Wire file-open source-message lookup and resolver-hint propagation.
5. Update docs/specs and run focused Rust and service tests.

This order keeps the feature deployable with mixed versions: older daemons omit
`host_cwd`, newer daemons serve hinted opens, and the service can gracefully omit
path context whenever it is unavailable.

## Test Plan

Run focused tests before broader package checks:

- Rust file resolution tests for [../../bud/src/files/mod.rs](../../bud/src/files/mod.rs)
- Rust terminal send/observe tests that use the fake terminal backend cwd
- Service terminal runtime tests for status/result cwd persistence
- Service agent transcript tests for path-context metadata
- Service thread file-open route tests for authorized source-message lookup
- Service file-edge tests for resolver-hint control frames

Manual validation:

1. In one thread, work in project A and produce an assistant message with a file
   link.
2. Change cwd to project B in the same terminal session.
3. Click the old project-A file link.
4. Confirm the daemon reports `resolved_against: "message_cwd"` and opens the
   project-A file.
5. Click a pre-rollout or contextless file link and confirm existing
   terminal-cwd-first behavior still works.

Completed automated verification:

- `cargo test` from [../../bud](../../bud)
- `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/proto/wire.test.ts src/runtime/terminal/request-dispatcher.test.ts src/runtime/terminal-session-manager.test.ts src/agent/transcript-writer.test.ts src/files/file-edge.test.ts src/routes/threads/files.test.ts`
- `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/routes/threads/messages.test.ts`
- `pnpm --dir /Users/adam/bud/service build`
- `git diff --check`

## Resolved And Deferred Details

- Exact terminal result proto field numbers are resolved as
  `TerminalSendResult.host_cwd = 7` and
  `TerminalObserveResult.host_cwd = 11`.
- Manual terminal input that changes cwd without any later agent terminal
  send/observe may still have stale cached cwd. A later phase can add
  `terminal_ready.host_cwd` if this becomes user-visible.
- If raw `host_cwd` privacy becomes a product concern, add a separate
  presentation-layer field later instead of changing the first-pass resolver
  contract.
- Web viewer reuse keying was resolved in
  [./phase-6-source-aware-web-reuse.md](./phase-6-source-aware-web-reuse.md):
  assistant-message candidates with `source.message_id` now use source-aware
  keys, while contextless opens keep the original relative-path key.
