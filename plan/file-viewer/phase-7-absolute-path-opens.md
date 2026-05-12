# Phase 7: Absolute POSIX Path Opens

**Implementation status:** Implemented on this branch.

**Decision status:** Recommendations accepted and implemented. This parent phase
records the product contract and resolved defaults. Implementation is split across
[phase-7a-daemon-file-resolve-frame.md](./phase-7a-daemon-file-resolve-frame.md),
[phase-7b-service-absolute-preflight.md](./phase-7b-service-absolute-preflight.md),
and [phase-7c-client-contract-and-rollout.md](./phase-7c-client-contract-and-rollout.md).

## Context

iOS now opens files smoothly from assistant-message file references and renders
Markdown previews. The next product gap is user-initiated navigation from links
inside opened Markdown files.

Many Markdown docs contain absolute host paths:

```md
- [bud.spec.md](/Users/adam/bud/bud.spec.md)
- [docs/proto.md](/Users/adam/bud/docs/proto.md)
```

Before this phase, the thread file-open route rejected absolute paths at the
service parser before the daemon could apply local filesystem policy. To support
Markdown-preview links without asking mobile to understand Bud roots, absolute
path resolution now moves to the daemon.

Related mobile handoff:

- [../../reference/IOS_FILE_VIEWER_MARKDOWN_PREVIEW_LINKS_HANDOFF.md](../../reference/IOS_FILE_VIEWER_MARKDOWN_PREVIEW_LINKS_HANDOFF.md)
- [../../reference/IOS_FILE_VIEWER_MARKDOWN_PREVIEW_LINKS_BACKEND_RESPONSE.md](../../reference/IOS_FILE_VIEWER_MARKDOWN_PREVIEW_LINKS_BACKEND_RESPONSE.md)

## Objective

Allow a user to open absolute POSIX file paths through the existing
thread-scoped file viewer route when the daemon confirms the canonical target is
inside the configured file-viewer policy root.

Acceptance criteria:

- `source.kind = "markdown_preview"` remains accepted.
- `POST /api/threads/:thread_id/files/open` accepts absolute POSIX path syntax
  after thread authorization.
- The service does not attempt to prove absolute-path containment locally.
- The daemon canonicalizes the absolute path and serves only regular,
  non-symlink files under its allowed root.
- Absolute paths outside daemon policy return a denied state, not a successful
  session.
- Successful absolute opens return a normal file session whose
  `file_session.path.relative_path` is the daemon-approved root-relative path.
- Existing relative-path behavior, message-time cwd resolution, and
  contextless terminal-cwd-first behavior continue to work.
- No mobile-supplied cwd/path-context fields are introduced.

## Sub-Phase Plan

### Phase 7a: Daemon File Resolve Frame

[phase-7a-daemon-file-resolve-frame.md](./phase-7a-daemon-file-resolve-frame.md)

- add a metadata-only `file_resolve` control frame
- add daemon resolver support for absolute POSIX paths
- return daemon-approved `resolved_relative_path`, `resolved_against`, size, and
  content identity
- share resolver/policy behavior with file open paths

### Phase 7b: Service Absolute Path Preflight

[phase-7b-service-absolute-preflight.md](./phase-7b-service-absolute-preflight.md)

- classify absolute POSIX paths in the thread open parser
- require normal file-read transport availability before preflight
- call daemon `file_resolve`
- create normalized viewer file sessions from daemon-approved metadata
- persist preflight content identity and display-safe resolution metadata

### Phase 7c: Client Contract And Rollout

[phase-7c-client-contract-and-rollout.md](./phase-7c-client-contract-and-rollout.md)

- update mobile/backend handoff docs
- define client cache/display key behavior for absolute opens
- document Markdown-preview link rollout gating
- validate mobile navigation-stack behavior and error mapping

## Fixed Scope

This phase includes:

- absolute POSIX paths such as `/Users/adam/bud/docs/proto.md`
- line/column suffix metadata on absolute paths where the existing parser can
  safely identify it
- daemon policy enforcement under the existing `workspace`/allowed root
- Markdown-preview links that already contain absolute paths

This phase does not include:

- `~/...` home-relative expansion
- Windows paths
- URLs or `mailto:`
- basename search
- relative Markdown-preview links such as `./next.md` or `../README.md`
- parent-file-relative resolution
- directory browsing
- symlink following
- broadening the daemon allowed root beyond current policy

## Current Constraints

The file-session model assumes `file_session.relative_path` is a normalized
workspace-relative path. For relative opens, the service creates the
`file_session` before daemon stat/read, and the file edge later sends
`relative_path` in daemon `file_open`.

That means the service cannot simply store an absolute path in
`file_session.relative_path`. It must either:

1. ask the daemon to resolve the absolute path before creating the ready file
   session, or
2. extend lazy edge resolution so the session can carry a raw requested path and
   be normalized after the first daemon stat.

The implemented absolute-path flow uses daemon preflight resolution in the
thread open route. That keeps the open response useful to mobile and avoids
exposing a temporary fake relative path.

## Proposed Contract

Request shape stays the same:

```json
{
  "path": "/Users/adam/bud/docs/proto.md",
  "source": {
    "kind": "markdown_preview",
    "message_id": "22222222-2222-4222-8222-222222222222",
    "client_id": "33333333-3333-4333-8333-333333333333"
  },
  "viewer_intent": "preview"
}
```

Successful response uses the existing file-session shape:

```json
{
  "file_session": {
    "root": { "key": "workspace" },
    "path": {
      "raw_path": "/Users/adam/bud/docs/proto.md",
      "relative_path": "docs/proto.md"
    },
    "display_metadata": {
      "raw_path": "/Users/adam/bud/docs/proto.md",
      "source": {
        "kind": "markdown_preview",
        "message_id": "22222222-2222-4222-8222-222222222222"
      },
      "requested_path_kind": "absolute_posix"
    }
  },
  "viewer": {
    "suggested_kind": "markdown",
    "display_name": "proto.md",
    "max_display_bytes": 1048576
  }
}
```

The client should use `file_session.path.relative_path` for cache/display keys
and preserve `path.raw_path` only as the original request/audit value.

## Recommended Architecture

### 1. Add A Daemon Resolve Path

Add a daemon-owned resolver used by file work. The resolver should accept:

- `requested_path`
- `root_key`
- optional `terminal_session_id`
- optional existing `resolution_hint`

For this phase, only `requested_path_kind = "absolute_posix"` needs new
behavior. Relative paths continue through the existing resolver.

Resolution for absolute POSIX paths:

1. reject NUL, URL-like, Windows, and backslash forms
2. create one absolute candidate from the raw path
3. reject if the candidate is a symlink
4. canonicalize
5. require canonical path to start with the daemon workspace/allowed root
6. require regular file
7. return `resolved_relative_path` using the allowed root

Implemented result metadata:

```json
{
  "accepted": true,
  "root_key": "workspace",
  "resolved_against": "absolute_path",
  "resolved_relative_path": "docs/proto.md",
  "content_identity": {
    "size": 4096,
    "modified_ms": 1777132800000
  },
  "size": 4096
}
```

### 2. Add A Service Resolve/Stat Helper

For absolute paths, the thread open route should call the daemon resolver before
creating the file session.

The helper should:

- use the already-authorized thread and derived Bud
- require an active daemon control/data carrier as needed by the chosen wire path
- pass only the raw requested path and server-known context
- map daemon denials into stable HTTP responses
- return daemon-approved `root_key`, `resolved_relative_path`, content identity,
  and display metadata

Use a small new `file_resolve` control frame. This avoids bending the streaming
`file_open` lifecycle into a pre-session metadata operation. The product route
still has only one mobile-visible open request.

### 3. Create The File Session From Resolved Metadata

After daemon resolve succeeds:

- create the normal viewer file session with `relative_path =
  resolved_relative_path`
- keep `root_key = "workspace"`
- keep 1 MiB `max_bytes`
- preserve the raw absolute request under `display_metadata.raw_path`
- set `display_metadata.requested_path_kind = "absolute_posix"`
- store `content_identity` immediately from the daemon preflight result

Subsequent `HEAD` / `GET` should use the existing relative-path `file_open`
flow. This pins the file session to the resolved target and avoids a later
terminal cwd change affecting an already-open absolute-path tab.

### 4. Keep Relative Opens On Existing Flow

Do not rewrite all relative opens in this phase.

Existing behavior should remain:

- source-message path context first for context-bearing relative opens
- workspace fallback
- terminal-cwd-first behavior for contextless/pre-rollout opens
- source-aware web/mobile reuse keys for context-sensitive entries

## Service Parser Changes

Update the thread-open path parser so it can classify path syntax:

```ts
type ParsedViewerFilePath =
  | {
      kind: "relative";
      rawPath: string;
      relativePath: string;
      line?: number;
      column?: number;
    }
  | {
      kind: "absolute_posix";
      rawPath: string;
      requestedPath: string;
      line?: number;
      column?: number;
    };
```

Service should still reject before daemon work:

- empty path
- NUL bytes
- URLs and `mailto:`
- Windows drive paths
- backslashes
- directory paths ending in `/`

Service should not reject absolute POSIX paths only because they are absolute.
Containment is a daemon policy decision.

## Error Mapping

Expected first-pass mappings:

| Daemon/service condition | HTTP | Client state |
| --- | --- | --- |
| Absolute path outside allowed root | `403` | denied/outside scope |
| Absolute path under root but missing | `404` | not found |
| Trailing slash directory syntax | `400` | invalid path / directory unsupported |
| Existing directory without trailing slash | `403` | denied / directory unsupported |
| Symlink | `403` | denied |
| Non-regular file | `403` | denied / unsupported file type |
| URL, mailto, Windows, backslash, NUL | `400` | invalid path |
| Bud unavailable during absolute preflight | `424` or `503` | offline |
| Resolve timeout | `504` | retryable error |

Avoid disclosing whether an outside-root path exists. Return the same denied
shape for outside-root absolute paths whether the file exists or not.

## Markdown Preview Link Answers

This phase answers the iOS Markdown-preview link questions as follows:

1. `source.kind = "markdown_preview"` is accepted and remains the right source
   shape.
2. Parent file context is not required for absolute-path links.
3. Mobile can allow absolute POSIX candidates after this backend phase ships,
   relying on daemon validation.
4. Mobile should use response `file_session.path.relative_path` as the
   normalized cache/display key.

Parent-file context should be added in a later phase for relative Markdown
preview links.

## Tests

Daemon tests:

- accepts absolute POSIX path under workspace root
- rejects absolute POSIX path outside workspace root
- rejects symlink absolute path
- rejects directory absolute path
- returns workspace-relative `resolved_relative_path`
- preserves existing relative-path resolution behavior

Service tests:

- thread file-open accepts absolute POSIX syntax after auth
- thread file-open still rejects URL, NUL, Windows, backslash, and trailing slash
- successful daemon absolute resolve creates file session with resolved relative
  path
- outside-root daemon denial maps to `403`
- missing daemon result maps to `404`
- unavailable daemon maps to `424`/`503`
- `source.kind = "markdown_preview"` plus original message id is accepted

Mobile/web contract tests, when clients add support:

- absolute Markdown-preview link opens when under root
- outside-root absolute link shows denied
- directory absolute link shows invalid/unsupported
- response relative path is used for cache/display key
- navigation back stack returns to parent file without refetching unless session
  expired

## Documentation And Specs

Update when implementing:

- [../../docs/proto.md](../../docs/proto.md): daemon resolve/open payloads and
  absolute path error mapping
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md):
  thread file-open absolute path behavior
- [../../service/src/files/files.spec.md](../../service/src/files/files.spec.md):
  file session creation from daemon-resolved metadata
- [../../bud/src/files/files.spec.md](../../bud/src/files/files.spec.md):
  absolute path resolver policy
- [./file-viewer.spec.md](./file-viewer.spec.md): this phase
- [../../reference/IOS_FILE_VIEWER_HANDOFF.md](../../reference/IOS_FILE_VIEWER_HANDOFF.md):
  mobile contract once absolute support ships

## Resolved Implementation Defaults

### 1. New `file_resolve` frame or stat-only `file_open` preflight?

Option A: add a new `file_resolve` control frame.

Pros:

- cleanly models the work as metadata-only resolution before DB session
  creation
- avoids manufacturing a temporary `file_session_id` / `stream_id` only to stat
  a path
- does not consume generic stream credit or data-plane runtime capacity
- keeps the streaming `file_open` path focused on already-created sessions
- gives future resolver work a natural home for `~/...`, parent-file-relative
  links, and eventual search/disambiguation

Cons:

- adds a new daemon-service protocol frame and codecs
- requires new service request tracking and timeout plumbing
- must duplicate or share daemon file policy code with `file_open`
- creates one more mixed-version capability to reason about

Option B: add a stat-only `file_open` preflight that can run before DB session
creation.

Pros:

- reuses the existing `file_open_result` shape and daemon file stat code
- may need fewer protocol concepts if implemented carefully
- keeps all local file policy behind one existing frame family

Cons:

- `file_open` currently belongs to a stream lifecycle and expects durable
  operation/stream/session identifiers
- harder to avoid data-plane registration, credit, stream cleanup, and audit
  side effects for metadata-only work
- blurs the distinction between "resolve a path" and "open a file session"
- makes future resolver-only features harder to reason about

Default: add a small `file_resolve` control frame.

Keep the implementation narrow: absolute POSIX path in, daemon-approved
`root_key` + `resolved_relative_path` + optional content identity out. Share the
daemon resolver/policy helper with `file_open` so policy behavior cannot drift.
Gate the route with a daemon capability, and return offline/unavailable when the
connected daemon does not support the frame.

### 2. Require active data-plane carrier for absolute preflight?

Option A: require an active data-plane carrier before preflight.

Pros:

- matches the fact that the next `HEAD` / `GET` needs file data-plane support
- avoids creating ready sessions that immediately fail at the file edge
- keeps product behavior simple: successful open means the viewer can proceed
  to stat/read

Cons:

- blocks resolving/displaying useful metadata during data-plane degradation
- couples a control-only metadata operation to stream transport availability
- may fail in cases where the daemon could have answered "denied" or "not
  found" without any file stream

Option B: allow control-only `file_resolve` preflight without data-plane
availability.

Pros:

- lower dependency for a small stat/resolve response
- can return precise not-found/denied errors even while data-plane is degraded
- lets the service create a degraded session if product wants that later

Cons:

- a successful open could still fail on immediate `HEAD` / `GET`
- mobile would need to handle "resolved but not readable right now" states
- creates a product distinction that is not needed for the first mobile path

Default: require the same file-read transport availability that
normal viewer sessions require, but use the control channel for the
`file_resolve` response itself.

In practice, the service should check `resolveFileTransportStatus(...)` before
calling the daemon resolver. If file transport is unavailable, return the same
offline/unavailable state mobile already handles. Once transport is available,
send `file_resolve` over control and create a normal ready file session from the
result.

### 3. Persist content identity from absolute preflight?

Option A: persist preflight `content_identity` immediately on the new
`file_session`.

Pros:

- records the file identity that was resolved during open for audit/debugging
- gives future range reads a concrete identity to pin against
- makes reload/content-changed semantics more deterministic
- useful if the open route eventually shows file size/modified metadata before
  `HEAD`

Cons:

- stores metadata that may be stale almost immediately
- requires the daemon resolve frame to stat the file, not just canonicalize it

Option B: do not persist preflight identity; let the first `HEAD` set identity
as today.

Pros:

- fewer content-changed failures immediately after opening
- keeps the current lazy identity behavior
- slightly simpler resolver response

Cons:

- the session is less tightly pinned to the exact file observed at open time
- a file could change between preflight and `HEAD` without a content-changed
  signal
- weaker audit/debug story for what was actually approved at open time

Default: persist `content_identity` from absolute preflight.

The open route is doing a daemon stat specifically to turn an absolute path into
a concrete session target. Treat that stat as the session's first observed
identity, but do not force normal preview `HEAD` / full `GET` requests to match
that identity. Users expect file preview opens to show the current file contents
even if the file changed after a message was created or after a prior open. Use
`expected_content_identity` for byte-range reads, where stale offsets could
serve incorrect bytes, and rely on the daemon's during-read identity check for
the rare case where a file mutates while a full read is in progress.

### 4. Surface `resolved_against = "absolute_path"` in display metadata, audit,
or both?

Option A: audit only.

Pros:

- minimizes browser/mobile-visible metadata
- avoids growing UI contracts with diagnostic fields
- still preserves backend observability

Cons:

- clients cannot distinguish absolute opens from relative opens without
  inspecting raw path shape
- harder to debug mobile reports from captured API payloads
- misses a useful local navigation-stack hint

Option B: `file_session.display_metadata` only.

Pros:

- visible to first-party clients for debugging and future display copy
- easy for mobile/web to store in navigation state
- no separate audit lookup needed during client troubleshooting

Cons:

- display metadata is browser/mobile visible, so it must not include raw host cwd
  beyond the raw path the user already clicked
- not enough for durable backend audit on its own

Option C: both display metadata and audit.

Pros:

- best debugging and audit trail
- lets clients treat absolute opens differently without recomputing path shape
- keeps backend audit complete even if the session payload is not captured

Cons:

- duplicates a small amount of metadata
- requires care to keep display metadata sanitized

Default: both, with a minimal display-safe shape.

Store display metadata like:

```json
{
  "requested_path_kind": "absolute_posix",
  "resolved_against": "absolute_path"
}
```

Do not add canonical absolute paths to browser/mobile-visible metadata. Audit
events can include resolver diagnostics and the normalized
`resolved_relative_path`; avoid logging outside-root absolute paths beyond what
is already necessary for operational debugging.

### 5. If the allowed root is narrower than the absolute path, denied or not
found?

Option A: return denied / `403`.

Pros:

- accurately communicates that the path syntax is understood but outside the
  file-viewer scope
- aligns with daemon policy enforcement
- helps users/admins understand why an obvious absolute path did not open
- matches mobile's expected denied/outside-scope state

Cons:

- can imply that the path may exist outside policy
- might feel less privacy-preserving than not-found in multi-user or personal
  machine deployments

Option B: return not found / `404`.

Pros:

- avoids confirming anything about paths outside the allowed root
- simple and privacy-conservative

Cons:

- misleading when the user can see the path in terminal output and expects a
  scope/policy explanation
- makes policy misconfiguration harder to diagnose
- blurs missing files with denied files

Default: return denied / `403` for absolute paths outside the
configured allowed root, with generic copy.

The user supplied an absolute local path, and the daemon can determine that the
canonical target is outside policy or that the candidate path cannot be
considered because an ancestor is outside policy. The UI copy should avoid
existence claims, for example: `This path is outside the Bud file-viewer scope.`

Implementation note: do not stat arbitrary outside-root targets just to produce
this result. Prefer lexical/canonical parent checks where possible, and return
the same denied shape whether the outside-root target exists or not.

### 6. Document macOS case-insensitive canonicalization in user copy?

Option A: document it in user-facing copy.

Pros:

- explains why `/Users/Adam/Bud/...` and `/Users/adam/bud/...` may behave the
  same on default macOS filesystems
- can reduce confusion for rare casing mismatches

Cons:

- too much filesystem detail for a normal file viewer error
- behavior depends on the actual mounted volume, not just macOS
- risks making the UI sound inconsistent across Linux, APFS case-sensitive
  volumes, external drives, and future platforms

Option B: leave it as daemon-local filesystem behavior.

Pros:

- keeps product copy simple
- lets canonicalization follow the host filesystem exactly
- avoids platform-specific UI branches

Cons:

- casing edge cases may require backend logs/debugging to explain
- users may not know why a differently cased path opened or failed

Default: leave case behavior out of user-facing copy.

The daemon should canonicalize through the host filesystem and return the
normal success/denied/not-found state. If needed, logs/audit can include
diagnostic resolver metadata, but mobile/web copy should stay generic.

## Known Unknowns

- Whether the current default daemon workspace root is broad enough for common
  absolute paths emitted by agents. This phase should not broaden policy by
  accident.
- How often Markdown docs contain relative links that users expect to resolve
  against the parent Markdown file. That needs a later parent-context phase.
- Whether file names with colons conflict with existing `:line` parsing on
  absolute POSIX paths. Keep current suffix parsing for now and revisit if real
  files hit this edge.
- Whether mobile should eventually support spaces/non-ASCII in local path
  candidates. Backend can support them if safely encoded; mobile may keep its
  narrower parser initially.
- Whether a future multi-root daemon policy needs `root_key` values beyond
  `workspace` before absolute paths feel complete.

## Rollout

Recommended order:

1. Add daemon resolver support and tests for absolute POSIX paths under the
   existing workspace/allowed root.
2. Add service protocol helper and thread-open route support for absolute path
   preflight.
3. Update protocol/spec/reference docs.
4. Run daemon/service focused tests plus file-viewer web tests.
5. Enable mobile absolute Markdown-preview link handling behind a backend
   capability or app-version gate.

Until this phase ships, mobile should treat absolute Markdown-preview links as
unsupported local file links rather than sending them to the current open route.
