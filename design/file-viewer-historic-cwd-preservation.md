# Design: File Viewer Historic CWD Preservation

Status: Implemented for first web pass

Audience: Daemon, service, web, iOS, and product

Last updated: 2026-05-06

Related:
- [file-serving-user-initiated-viewer.md](./file-serving-user-initiated-viewer.md)
- [daemon-owned-file-path-resolution.md](./daemon-owned-file-path-resolution.md)
- [file-viewer-path-roots-and-thread-cwd.md](./file-viewer-path-roots-and-thread-cwd.md)
- [terminal-context-sync.md](./terminal-context-sync.md)

## Context

The current file viewer works well for the common case where the user clicks a
fresh assistant file link while the thread terminal is still in the same project
or subdirectory.

The path flow today is intentionally lazy and daemon-owned:

1. The web message renderer detects a relative file path in an assistant
   message.
2. The user clicks the file action.
3. The client calls `POST /api/threads/:thread_id/files/open` with the raw path
   plus source metadata such as `message_id` and `client_id`.
4. The service authorizes the thread, creates a short-lived `file_session`, and
   stores the clicked path in display metadata.
5. `HEAD` / `GET` on the file session sends daemon `file_open` with the active
   thread terminal session id.
6. The daemon asks tmux for a fresh `pane_current_path`, tries that cwd first,
   then falls back to the Bud workspace root.

That click-time cwd behavior is the right first improvement, but it has a
history problem. A single thread can move between projects:

```text
cd ~/bud/service
# assistant references src/files/file-session.ts

cd ~/bud-mobile
# later, user scrolls up and clicks the old src/files/file-session.ts link
```

Because the old assistant message does not carry any historic path context, the
file open is resolved against the current click-time cwd. The file may fail to
open or, worse, a same-shaped path in the new project could open instead.

## Goals

1. Preserve enough message-time path context that old relative file links remain
   meaningful after a thread changes directories or projects.
2. Keep the daemon as the filesystem authority for any host path resolution.
3. Avoid service-owned live cwd tracking as a trusted source of truth.
4. Keep the web/mobile file-open contract simple and compatible with the current
   user-clicked session model.
5. Make cwd history generally useful in transcripts, especially when a thread
   intentionally changes projects.
6. Fail closed when historic context is missing, stale, or outside policy.

## Non-Goals

- Giving the agent file-read authority.
- Requiring absolute path links.
- Building a general file browser.
- Solving remote shell, `ssh`, container, or devcontainer path mapping in the
  first pass.
- Continuously tracking every shell cwd transition with prompt parsing.
- Treating service-stored cwd as permission to read a file.
- Rewriting the file-session transport or viewer UI.

## Current Implementation Findings

### File opens already carry message source metadata

The web renderer passes source metadata when a user opens an assistant file
candidate:

```json
{
  "source": {
    "kind": "assistant_message",
    "message_id": "...",
    "client_id": "..."
  }
}
```

The service currently stores this in `file_session.display_metadata`, but it
does not use `source.message_id` to recover any message-time path context.

### File resolution is click-time only

`service/src/files/file-edge.ts` resolves the active thread terminal session and
includes `terminal_session_id` on daemon `file_open`.

`bud/src/app.rs` then calls `fresh_pane_cwd_for_session(...)`, and
`bud/src/files/mod.rs` tries:

1. `terminal_cwd + relative_path`
2. `workspace_root + relative_path`

The daemon still canonicalizes, rejects unsafe paths, denies symlinks, requires
regular files, and ensures the target stays under the workspace root.

This is good for current links. It is not enough for historic links.

### Message metadata is the lowest-friction storage point

The `message` table already has a JSON metadata column. It is used for model
selection, tool timing, provider call ids, context sync, and user
`preferred_cwd`.

That makes message metadata the simplest place to store a new path-context
snapshot for new messages without a database migration.

### Context sync already has a transcript mechanism

`ContextSyncService` can inject system messages before user messages when the
terminal state changes. Today those messages summarize mode/screen changes, but
they do not include cwd. This is a natural place to add visible "project/cwd
changed" breadcrumbs later.

### Terminal status already has a cwd field

The Bud terminal protocol already allows `terminal_status.info.cwd`, and the
database already has `terminal_session.cwd`. The current service code accepts
the field at the protocol boundary, but the terminal session store does not yet
persist it onto `terminal_session.cwd`.

That makes the simplest first pass smaller than a new daemon query or a
workspace-root normalization feature: persist the latest daemon-reported cwd in
the service terminal runtime, then stamp a copy of that cached `host_cwd` onto
future messages. Message writes should not block on asking the Bud for cwd.

## Proposal A: Message-Time Path Context Snapshot

Store a lightweight path context snapshot on new transcript messages.

Example message metadata:

```json
{
  "path_context": {
    "schema": "terminal_cwd_v1",
    "source": "terminal_runtime_cache",
    "reported_by": "tmux_pane_current_path",
    "terminal_session_id": "bud-b_123-thread-...",
    "host_cwd": "/Users/adam/bud/service",
    "observed_at": "2026-05-05T18:19:58.000Z",
    "captured_at": "2026-05-05T18:20:00.000Z"
  }
}
```

The browser does not need to interpret this context. On file open, it already
sends `source.message_id`. The service can authorize that message belongs to the
same viewer-owned thread, read `message.metadata.path_context`, and attach it to
the file session or daemon request as a resolution hint.

For source messages with usable path context, the daemon resolves relative file
paths in this order:

1. message-time cwd hint, if present and valid under policy
2. workspace root

It should not try the click-time tmux cwd for a source message that carries path
context, even if that stored hint is unusable. In that case, fall back only to
the workspace-root candidate. This keeps an old message from opening a
same-shaped file in the user's current project.

For source messages without any stored path context, keep today's behavior:

1. current tmux pane cwd
2. workspace root

The hint should be the raw host cwd reported by the daemon, not a
service-derived workspace-relative cwd. The service is preserving historical
context, not interpreting host filesystem layout. The daemon can reconstruct the
candidate by joining `host_cwd + relative_path`, then applying the same
canonicalization and policy checks used today.

Pros:

- Directly fixes old assistant links after project changes.
- Reuses current `source.message_id` contract.
- Does not require a client-visible cwd picker or extra click round trip.
- Keeps file authority in the daemon.
- Can start without a schema migration by using `message.metadata`.
- Gives mobile the same durable behavior once it sends message source metadata.
- Does not require the Bud to be online at assistant-message persistence time
  because the service stamps the latest cached context.

Cons:

- New messages only. Existing transcript rows still fall back to current
  behavior.
- Requires a service path-context capture helper.
- Requires a small daemon `file_open` contract extension for a host-cwd hint.
- A message produced while the terminal cwd is changing can still capture a
  nearby-but-not-perfect context.
- Stores raw absolute host cwd in message metadata, which is acceptable for this
  VM-oriented first pass but should be revisited before stronger privacy
  boundaries.

Assessment:

This is the best first implementation target. It is simple, durable, and fits
the current lazy file-session architecture.

## Proposal B: CWD Boundary Messages In The Transcript

Add transcript breadcrumbs when the terminal cwd changes meaningfully:

```text
Terminal directory changed to ~/bud/service.
```

or, if we avoid raw absolute paths:

```text
Project context changed to bud/service.
```

These can be system messages inserted by context sync or by a dedicated
path-context service. Each boundary message also carries structured metadata:

```json
{
  "type": "cwd_context",
  "path_context": {
    "schema": "terminal_cwd_v1",
    "host_cwd": "/Users/adam/bud/service",
    "captured_at": "..."
  }
}
```

Future assistant messages can either copy the latest context into their own
metadata or rely on a service lookup for the nearest preceding cwd boundary.

Pros:

- Makes project switches explainable to humans and agents.
- Helps the model understand cwd history in future turns.
- Creates a useful timeline even when no file links are clicked.
- Can support "what project was this answer about?" style UI later.

Cons:

- Visible transcript noise if every small cwd change becomes a message.
- "Nearest preceding boundary" lookup is more complex than direct message
  metadata.
- It still needs daemon validation before file opens.
- Context sync currently detects screen/mode changes, not cwd changes, so this
  needs a new capture signal.

Assessment:

Useful as a companion to Proposal A, not a replacement. Direct message metadata
is more robust for file opens; visible boundary messages are better for human
understanding and agent context.

## Proposal C: Resolve And Pin File References When Messages Are Written

After an assistant message is persisted, run a server-side path candidate pass
and ask the daemon to resolve each candidate into a durable approved target:

```json
{
  "file_references": [
    {
      "raw_path": "src/files/file-session.ts",
      "root_key": "workspace",
      "relative_path": "service/src/files/file-session.ts",
      "resolved_against": "message_cwd",
      "line": 42
    }
  ]
}
```

Clicking a file link later uses the pinned target instead of resolving the raw
path again.

Pros:

- Strong historic stability.
- Prevents same-shaped paths in later projects from being opened accidentally.
- Moves ambiguity handling to write time, close to when the assistant generated
  the text.
- Opens a path to structured file references that web and mobile can consume.

Cons:

- Requires daemon work during message persistence.
- Adds false-positive parser risk to backend write paths.
- Can be expensive for long messages with many candidates.
- Creates product questions about how aggressively to scan assistant prose.
- Harder to support streamed text because links appear in the client before the
  durable post-processing pass completes.

Assessment:

Good later if client parsing becomes insufficient or we need pinned references
for mobile/offline UX. It is more machinery than the current gap requires.

## Proposal D: Lazy First-Click Pinning

When a user opens a file link successfully, persist the resolved target for that
source message and raw path. Future clicks use the pinned target.

Pros:

- No write-time scanning.
- Uses real user intent to choose which references matter.
- Helps repeated clicks, tab reuse, and cross-device reopen after a successful
  first open.
- Can use daemon-returned `resolved_relative_path` from the current file open.

Cons:

- Does not solve the first click on an old message after cwd has already changed.
- Needs a storage location for per-message/per-path pins.
- Still needs Proposal A or B if we want first-click historic correctness.

Assessment:

Useful hardening after message-time path context. Not enough alone.

## Proposal E: Explicit Project Context Commands

Let the user, client, or agent explicitly mark a project context in the thread:

```text
/project ~/bud/service
```

or:

```text
Working project: bud/service
```

The route stores the context as a system message and/or thread-level marker. File
links after that point inherit the marked project until another marker appears.

Pros:

- Extremely explainable.
- Works even when tmux cwd is misleading inside TUIs, shells, or future terminal
  backends.
- Gives mobile a simple UI affordance if users manually switch projects.
- Useful for non-terminal-originated assistant messages.

Cons:

- Requires user or agent discipline.
- Can drift from the real terminal cwd.
- Should not become the default way file links work.

Assessment:

Worth keeping as a product escape hatch, especially for remote/container cases.
It should complement automatic snapshots rather than replace them.

## Recommended Direction

Use a layered approach:

1. Persist the latest daemon-reported cwd in the service terminal runtime.
2. Store that cwd as `host_cwd` path context without service-side root stripping.
3. Store direct message-time path context snapshots on new user, assistant, tool,
   and system messages whenever a cached thread terminal context exists.
4. Use `source.message_id` during file open to recover that path context.
5. Extend daemon `file_open` to accept a host-cwd hint and prefer it over
   click-time tmux cwd for context-bearing source messages, with no click-time
   cwd fallback when the source message carried path context.
6. Defer visible cwd boundary messages in the first pass.
7. Add resolve-and-pin behavior later if structured references become valuable.

The key distinction is that stored cwd is a hint, not authorization. The daemon
must still decide whether the candidate exists, is regular, and stays inside the
allowed workspace root.

The service terminal runtime is the right first home for the helper. It already
owns terminal status ingestion, terminal-session rows, and thread/session lookup.
The helper should be opportunistic:

- update latest cwd when normal daemon terminal frames report cwd
- stamp the last known path context onto messages without a daemon round trip
- omit path context when no cached value exists
- never fail assistant message persistence because the Bud is offline

If normal status frames prove too sparse, add cwd to existing terminal
send/observe result frames. That is still simpler than adding a separate
`path_context` request because it piggybacks on terminal work the daemon is
already doing.

## Proposed Contract Shape

### Message Metadata

Initial metadata can live under `message.metadata.path_context`:

```json
{
  "path_context": {
    "schema": "terminal_cwd_v1",
    "source": "terminal_runtime_cache",
    "reported_by": "tmux_pane_current_path",
    "terminal_session_id": "bud-b_123-thread-...",
    "host_cwd": "/Users/adam/bud/service",
    "observed_at": "2026-05-05T18:19:58.000Z",
    "captured_at": "2026-05-05T18:20:00.000Z"
  }
}
```

Field notes:

- `schema` makes future migrations explicit.
- `source` records that the value came from the service terminal runtime cache.
- `reported_by` records that the original host-local value came from tmux, not
  prompt parsing.
- `terminal_session_id` is diagnostic context and should not authorize access.
- `host_cwd` is the raw cwd reported by the daemon. The service should not strip
  or normalize this in the first pass.
- `observed_at` records when the daemon reported the cwd to the service.
- `captured_at` records when the cached context was copied onto the message.

If no daemon-reported cwd is available, omit `path_context` entirely. If the
service later needs to record diagnostic failures, it can store a non-resolving
diagnostic object:

```json
{
  "path_context": {
    "schema": "terminal_cwd_v1",
    "source": "terminal_runtime_cache",
    "reported_by": "tmux_pane_current_path",
    "terminal_session_id": "bud-b_123-thread-...",
    "unavailable_reason": "no_cached_cwd",
    "observed_at": "2026-05-05T18:19:58.000Z",
    "captured_at": "2026-05-05T18:20:00.000Z"
  }
}
```

`workspace_relative_cwd` is intentionally not part of the first pass. It can be
added later if Bud needs a stricter browser privacy boundary or a more
productized workspace model. For correctness today, raw `host_cwd` is the more
faithful historical anchor.

### Terminal Runtime CWD Source

`terminal_status.info.cwd` is useful as an initial or reconnect-time baseline,
but it is not enough for the desired capture boundary. The important moment for
assistant file links is after the final terminal tool result, and status frames
are not guaranteed to arrive after every `cd`, TUI navigation, or tool-driven
working-directory change.

The first implementation should therefore add optional `host_cwd` fields to
`terminal_send_result` and `terminal_observe_result`. The daemon can populate
these by querying tmux `pane_current_path` after it finishes the existing
post-send or observe capture. The service updates the latest terminal-session cwd
cache from those result frames before it persists the corresponding tool result
or final assistant message.

`terminal_status.info.cwd` should still be persisted when present. It remains a
good baseline for newly ensured or reattached sessions and keeps older daemons
compatible during rollout. Manual terminal input that changes cwd may still need
a future `terminal_ready.host_cwd` or periodic status refresh if no agent
send/observe result happens before the next no-tool assistant response.

### Thread File Open Request

Keep the browser/mobile request shape stable:

```json
{
  "path": "src/files/file-session.ts",
  "source": {
    "kind": "assistant_message",
    "message_id": "...",
    "client_id": "..."
  },
  "viewer_intent": "preview"
}
```

The service should not trust a client-supplied path context. It should load the
authorized source message by `message_id`, verify the message belongs to the same
thread and viewer, and copy the stored path context into the file session display
metadata and daemon request.

### Daemon File Open Hint

Extend `file_open` with an optional hint:

```json
{
  "type": "file_open",
  "relative_path": "src/files/file-session.ts",
  "terminal_session_id": "bud-b_123-thread-...",
  "resolution_hint": {
    "kind": "host_cwd",
    "host_cwd": "/Users/adam/bud/service",
    "source_message_id": "..."
  }
}
```

The daemon resolution order becomes:

1. `resolution_hint.host_cwd + relative_path`
2. `workspace_root + relative_path`

Every candidate uses the same existing daemon policy checks. If a provided hint
is missing `host_cwd`, non-absolute, contains NUL bytes, or canonicalizes outside
the workspace, the daemon skips the hint and falls back to the workspace-root
candidate. Unsafe final file paths still fail closed through the existing daemon
policy checks.

When no source-message path context exists, the daemon keeps the current
resolution order:

1. fresh `pane_current_path + relative_path`
2. `workspace_root + relative_path`

### File Session Metadata

The service can store:

```json
{
  "raw_path": "src/files/file-session.ts",
  "source": {
    "kind": "assistant_message",
    "message_id": "..."
  },
  "path_context": {
    "schema": "terminal_cwd_v1",
    "host_cwd": "/Users/adam/bud/service",
    "captured_at": "..."
  }
}
```

This gives audit/debug visibility without making file sessions long-lived
capability handles.

## Capture Boundaries

Recommended first pass:

- user messages: stamp the latest cached context when inserting the user message
  or queuing the agent turn
- assistant final messages after terminal tools: stamp the cached context after
  the final terminal tool result
- assistant final messages without terminal tools: reuse the latest cached
  context from the previous assistant/tool boundary, and do not query the daemon
  just to write the response
- assistant intermediate text segments: stamp the latest cached context at the
  segment persistence point
- tool result messages: carry both pre-tool and post-tool path context when
  available
- system context messages: include the latest cached path context when context
  sync runs

This creates a "near enough" path context for each durable row without requiring
continuous cwd tracking.

For tool rows, carrying both pre-tool and post-tool context is worthwhile:

```json
{
  "path_context_before": {
    "schema": "terminal_cwd_v1",
    "host_cwd": "/Users/adam/bud/service"
  },
  "path_context_after": {
    "schema": "terminal_cwd_v1",
    "host_cwd": "/Users/adam/bud/service/src"
  }
}
```

The downsides are small metadata growth and a resolver rule for which one to use
if a future tool-output file link becomes clickable. The recommended rule is:
assistant messages use the latest post-tool context; tool-result links use
`path_context_after` by default, with `path_context_before` retained for audit
and debugging.

## Visible CWD History

Visible cwd boundary messages are not part of the first pass.

Visible cwd messages should be conservative. A system message is useful when:

- the cwd changes between project-looking roots
- the thread moves from one top-level project folder to another
- the user sends a message after manual terminal activity changed cwd outside
  the agent loop

Avoid a message for every `cd src`, `cd ..`, or script-internal cwd change.

The display can stay short:

```text
Terminal directory changed to /Users/adam/bud/service.
```

If privacy or polish is a concern, hide these by default behind the existing
system-message toggle while still storing structured metadata.

## Security And Privacy

- The service must authorize the thread and source message before reading
  `message.metadata.path_context`.
- The client must not be allowed to submit an arbitrary cwd hint.
- Stored cwd must not expand the readable root. It only changes candidate order
  inside the existing daemon workspace policy.
- The first pass allows raw absolute `host_cwd` in message metadata. This is a
  correctness-first choice for VM-like Bud hosts and should be revisited before
  stronger privacy boundaries.
- If the message-time cwd is missing or fails daemon validation, omit it from the
  resolver hint or let the daemon skip it and fall back to workspace root.
- If message-time cwd and click-time cwd both contain the requested path but
  resolve to different files, prefer message-time cwd. The user clicked an old
  message, so historic context should win.
- For context-bearing source messages, avoid click-time cwd fallback. It can
  open a same-shaped path in the wrong project.
- `workspace_relative_cwd` can be added later as a privacy-oriented presentation
  layer, but it should not be required for first-pass correctness.

## Remote, Container, And Devcontainer Paths

The simplest first pass is to support host-local cwd only.

If tmux reports a host cwd, store that host cwd. If the terminal is inside
`ssh`, Docker, or a devcontainer, tmux may still report the host cwd of the
foreground process rather than the remote/container cwd visible inside the
program. Bud should not try to translate those paths in this pass.

That means remote/container file links may fail to open or may only open if the
referenced path also exists under the host cwd. This limitation is acceptable for
the first pass because the feature is scoped to host-machine file viewing. Future
options include:

- explicit project-context markers
- daemon-aware container path mappings
- a remote file adapter
- structured file references emitted by a tool that knows the active filesystem

Until one of those exists, Bud should not claim remote/container correctness.
The safest UX is to surface a normal not-found or outside-scope state when the
host-cwd candidate does not validate.

## Performance

The recommended first pass avoids extra click-time and message-write round
trips:

- cwd capture happens opportunistically when terminal status, send result, or
  observe result frames report `host_cwd`
- file open reuses `source.message_id` already sent by the client
- daemon validation is local path work already happening during file open

There is a small persistence cost to keep latest cwd state current. Keep it
bounded:

- only update cwd when normal terminal frames include cwd
- cache the latest `host_cwd` per terminal session
- do not query the daemon solely to stamp a message
- do not scan files or stat candidates during message persistence in Phase 1

## Phased Plan

### Phase 1: Metadata-Only Path Context Snapshots

Update the daemon and service terminal runtime so cwd is refreshed from
`terminal_status.info.cwd`, `terminal_send_result.host_cwd`, and
`terminal_observe_result.host_cwd` when available.

Persist the latest daemon-reported cwd and derive path context for the active
thread terminal session.

The first implementation should store raw daemon-reported `cwd` as `host_cwd`.
Do not add service-side workspace-root stripping.

Store `message.metadata.path_context` on new user, assistant, tool, and system
messages.

No file-open behavior changes yet.

### Phase 2: Source-Message Context On File Open

Update `POST /api/threads/:thread_id/files/open` to:

1. read `source.message_id` when present
2. authorize the message belongs to the same thread/viewer
3. extract `message.metadata.path_context`
4. store it in `file_session.display_metadata`

This remains backend-only and should not require web changes beyond existing
source metadata.

### Phase 3: Daemon Hint Resolution

Extend `file_open` with an optional host-cwd hint. Resolve relative
paths for context-bearing source messages against:

1. message-time cwd hint
2. workspace root

For contextless source messages, keep current behavior:

1. current tmux cwd
2. workspace root

Return metadata such as:

```json
{
  "resolved_against": "message_cwd",
  "resolved_relative_path": "service/src/files/file-session.ts"
}
```

The service can persist or expose this for diagnostics in the same way it
already handles `resolved_against`.

### Phase 4: Visible CWD Boundary Messages

Extend context sync or add a path-context watcher that inserts sparse system
messages when the cwd changes meaningfully.

This is explicitly out of the first pass. When added, it should focus on human
and agent understanding, not file-open correctness.

### Phase 5: Optional Pinning And Structured References

If needed, add lazy first-click pinning or write-time file-reference resolution.

This is where server-assisted path parsing and structured file-reference metadata
should be revisited.

## Resolved Questions

1. The first helper should live in the service terminal runtime. It should use
   cached daemon-reported cwd, not a per-message daemon request.
2. The service should not derive a workspace-relative cwd in the first pass.
   Store raw daemon-reported `host_cwd`; let the daemon validate it during file
   open.
3. Assistant messages should use cwd captured after the final terminal tool
   result. If no terminal tools ran, reuse the last cached context and do not
   query the daemon just to persist the assistant response.
4. Tool result rows should carry both pre-tool and post-tool path context. The
   main downside is small metadata growth plus a resolver rule; use post-tool by
   default for clickable tool-output references later.
5. Visible cwd boundary messages are deferred from the first pass.
6. If message-time cwd and click-time cwd both resolve the path, message-time cwd
   wins. Historic links should not drift to the current project.
7. Remote/container/devcontainer path translation is out of scope for first
   pass. Store host cwd only and do not claim remote path correctness.
8. No backfill is needed for old messages. Pre-rollout messages keep current
   fallback behavior.

## Implementation Notes

The first-pass implementation was completed on 2026-05-06. It adds result-time
`host_cwd` reporting from Bud terminal send/observe frames, caches cwd in the
service terminal runtime, stamps transcript path context metadata, forwards
source-message context as daemon `file_open.resolution_hint`, and resolves
context-bearing file opens against message-time cwd before workspace root.

## Remaining Unknowns

1. Whether `terminal_session.cwd` is enough for the latest raw cwd, or whether a
   richer cached path-context object belongs in `stateSnapshot` or a future
   dedicated column.
2. Whether raw `host_cwd` in browser-visible message metadata needs a future
   privacy mode before broader non-VM productization.
3. How often foreground TUIs update tmux `pane_current_path`; the current manual
   validation suggests it is good enough, but this remains backend behavior.
4. Whether manual terminal input should refresh cwd through `terminal_ready` in a
   follow-up, for no-tool assistant responses after a human changes directory in
   the terminal directly.
5. Resolved on 2026-05-06: the web viewer includes assistant
   `source.message_id` in file-entry reuse keys when available, while
   contextless opens keep the original relative-path key.

## Recommendation

Implement Proposal A first, with Proposal B as a follow-on for transcript
clarity.

Message-time path context is the smallest durable fix for historic file links:
it uses metadata we already have, preserves the current click-to-open product
flow, does not require the Bud to be online when an assistant message is
persisted, and keeps all host filesystem decisions inside the daemon. Visible
cwd history and pinned file references can build on the same metadata later
without forcing a more complex resolver into the first pass.
