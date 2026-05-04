# Design: Daemon-Owned File Path Resolution

Status: Draft

Audience: Daemon, service, web, iOS, and product

Last updated: 2026-05-02

Related:
- [file-serving-user-initiated-viewer.md](./file-serving-user-initiated-viewer.md)
- [file-viewer-path-roots-and-thread-cwd.md](./file-viewer-path-roots-and-thread-cwd.md)
- [network-upgrade-file-serving-productization.md](./network-upgrade-file-serving-productization.md)
- [../docs/proto.md](../docs/proto.md)

## Context

The first file viewer pass created a conservative, user-initiated workflow:

1. The web client detects a path-like reference in an assistant response.
2. The user explicitly clicks to open it.
3. The service authorizes the thread and creates a short-lived `file_session`.
4. `HEAD` / `GET` on the session sends daemon `file_open` work to the Bud.
5. The daemon enforces local file policy before statting or reading.

That pass intentionally accepted only workspace-relative paths. It avoided pretending the service knows the host machine's current directory, and it kept all actual filesystem access behind the daemon.

The remaining product problem is that "workspace-relative only" is too narrow for Bud's base deployment model. Bud should work as one long-lived daemon per machine, with threads moving between projects as normal terminal work requires. Multiple Buds rooted in separate project directories can be a useful isolation feature, but they should not be required just to make file viewing work.

Path references also often arrive without reliable context:

- the assistant may cite a path relative to whatever the shell was doing at the time
- a TUI, sub-agent, build tool, or test runner may emit paths relative to its own process cwd
- users may paste absolute paths, home-relative paths, repo-relative paths, or just filenames
- the service may observe terminal status, but it should not become the authority for shell cwd

The daemon is already the component that touches the host filesystem. It should also own host path interpretation.

## Product Stance

Bud's normal assumption should be:

- one Bud can serve a whole machine
- each thread can work in different projects or directories
- file viewing should accept natural path strings from the transcript
- local privacy and filesystem policy are enforced by the daemon at open time

Project-scoped Buds remain valuable, but as an optional security/isolation mode:

- a user can still run a Bud with a narrow allowed root for a sensitive project
- enterprise or sandboxed deployments can restrict roots more aggressively
- the core product should not require multiple Bud installations or per-project daemon lifecycle management

## Goals

1. Make the daemon the authority for resolving a user-clicked path string into a local file target.
2. Keep the browser and mobile API simple: "open this path for this thread."
3. Avoid service-side live-cwd tracking as a correctness dependency.
4. Keep file access user-initiated, audited, short-lived, and thread-authorized.
5. Be liberal in accepted path inputs while conservative in actual files served.
6. Preserve the existing file-session and `file_open` shape as much as possible.
7. Avoid extra client-visible round trips beyond the existing open/session/stat/read flow.
8. Keep performance bounded and predictable.

## Non-Goals

- agent-managed file reads or a model-facing file tool
- file writes, edits, uploads, or saves
- a general file browser
- recursive filesystem search as a required first-pass behavior
- trusting arbitrary absolute paths without daemon policy checks
- making tmux current cwd a service-owned source of truth
- requiring users to install or start one Bud per workspace

## Core Decision

Add daemon-owned path resolution to the file-open path.

The service should continue to own:

- browser/mobile authentication
- thread and Bud ownership checks
- file-session creation, TTL, revocation, audit correlation, and byte caps
- HTTP file edge behavior

The daemon should own:

- raw path interpretation on the host
- current terminal cwd lookup when useful
- home-directory expansion
- canonicalization and symlink policy
- allowed-root policy
- typed local denial reasons
- final stat/read/range access

In the common product flow, the browser/mobile client still sends:

```text
POST /api/threads/:thread_id/files/open
```

with a raw path candidate. The service authorizes the thread and sends daemon-backed open/resolve work as part of creating or preparing the file session. The user experience stays "request this file -> open it or show why it cannot be opened."

## Recommended Architecture

### Browser / Mobile API

Keep the product route thread-scoped:

```http
POST /api/threads/:thread_id/files/open
```

Request:

```json
{
  "path": "src/files/file-session.ts",
  "source": {
    "kind": "assistant_message",
    "message_id": "msg_...",
    "client_id": "018f..."
  },
  "line": 42,
  "column": 7,
  "viewer_intent": "preview"
}
```

The request path is deliberately raw display/input text. The client may parse obvious line/column suffixes, but it should not try to prove where the file lives.

Response on success:

```json
{
  "file_session": {
    "file_session_id": "fs_...",
    "bud_id": "b_...",
    "thread_id": "thread_...",
    "file_url": "/api/files/fs_...",
    "state": "ready",
    "max_bytes": 1048576,
    "path": {
      "requested_path": "src/files/file-session.ts",
      "display_path": "src/files/file-session.ts",
      "resolved_path": "bud/service/src/files/file-session.ts",
      "resolved_against": "terminal_cwd"
    }
  },
  "viewer": {
    "suggested_kind": "code",
    "language": "typescript",
    "line": 42,
    "column": 7,
    "max_display_bytes": 1048576
  }
}
```

The exact resolved path should be a display-safe form, such as root-relative or home-relative, not necessarily a full absolute host path.

### Service Flow

The service route should:

1. authenticate the viewer
2. authorize the thread with ownership-aware lookup
3. derive the Bud from the thread
4. create or prepare a short-lived viewer file session with the raw requested path
5. send daemon file-open work that includes the requested path and resolution context
6. persist the daemon-approved resolved target and content identity metadata when available
7. return either a ready session or a typed failure

This can be implemented in two ways:

1. Eager open preparation: `POST /files/open` waits for daemon stat/resolve and returns `404` / `403` / `409`-style typed errors immediately when the file cannot be opened.
2. Lazy edge resolution: `POST /files/open` creates the session from the raw path, and the first `HEAD` resolves through the daemon.

Recommendation: use eager open preparation for the product route if the daemon is online and a data-plane carrier is available. It matches the user's expectation that clicking a path either opens a session or returns a clear failure. Keep lazy edge resolution as an implementation fallback if route latency or carrier availability makes eager preparation too brittle.

### Daemon Flow

The daemon should expose one resolver internally to file handling:

```text
resolve_requested_file(requested_path, context, policy) -> resolved target | typed denial
```

The existing `file_open` handler should call that resolver before stat/read/range access. A separate public `file_resolve` frame is not required for the first product pass.

Preferred wire direction:

- extend `file_open` to accept `requested_path` and `resolution_context`
- keep existing `root_key` / `relative_path` support for backward compatibility
- return `file_open_result` with resolved target metadata on accept
- return typed policy or not-found denials on reject

A standalone `file_resolve` frame can be added later for search, disambiguation, or preview-only flows, but it should not be required for the normal click-to-open path.

## Resolution Context

The service can provide hints, not authority:

```json
{
  "thread_id": "thread_...",
  "terminal_session_id": "bud-b_...-thread-thread_...",
  "requested_path": "src/files/file-session.ts",
  "source": {
    "kind": "assistant_message"
  },
  "line": 42,
  "column": 7
}
```

Useful hints:

- terminal session id for fresh daemon-side pane cwd lookup
- source kind for audit/debugging
- path suffix metadata already parsed by the client
- existing thread/Bud identity for logging and correlation

Non-authoritative hints:

- service-stored cwd
- terminal status cwd cached in the service
- assistant text implying a cwd
- source message metadata

The daemon may use hints to choose candidate paths, but every accepted target must pass local policy after canonicalization.

## Accepted Path Inputs

The resolver should eventually accept these forms:

| Input Form | Example | First Option F Scope |
|------------|---------|----------------------|
| relative with separators | `src/files/file-session.ts` | Yes |
| leading `./` | `./src/main.rs` | Yes |
| home-relative | `~/bud/service/src/files/file-session.ts` | Yes, if under an allowed root |
| absolute POSIX path | `/Users/adam/bud/service/src/files/file-session.ts` | Yes, if under an allowed root |
| root-relative/project-ish path | `bud/service/src/files/file-session.ts` | Yes, through candidate roots |
| basename only | `file-session.ts` | Follow-up |
| line/column suffix | `src/foo.ts:12:4`, `src/foo.ts#L12` | Metadata only |
| URL | `https://example.com/file.ts` | No |
| directory | `src/files/` | No for viewer first pass |
| traversal | `../secrets.txt` | No |
| Windows drive path | `C:\Users\...` | Follow-up only if Windows Bud is scoped |

The resolver should not treat "accepted syntax" as permission. Syntax only produces candidates. Policy decides whether any candidate can be served.

## Candidate Resolution Order

For a path with directory separators:

1. If the path is absolute, canonicalize it and accept only if policy allows the canonical target.
2. If the path starts with `~/`, expand using the daemon user's home and accept only if policy allows the canonical target.
3. If a terminal session id is available, query the current pane cwd at click/open time and try cwd-relative resolution.
4. Try the daemon's primary allowed root, usually home for a machine-wide Bud or a configured project root for isolated Buds.
5. Try additional configured allowed roots, if any.
6. Reject with `not_found` or `policy_denied`.

For a path without separators:

1. First pass: try only the terminal cwd and primary allowed root.
2. Follow-up: optionally use bounded search or an index.
3. Reject ambiguous matches unless the product has a disambiguation UI.

This order prioritizes the directory the terminal is actually using without making service cwd tracking part of the contract. If a thread has `cd ~/bud/service`, `src/files/file-session.ts` can resolve from that cwd. If the transcript includes `bud/service/src/files/file-session.ts` while the terminal is already in `~/bud`, the primary root fallback can still find the home-relative/project-ish path.

## Policy Model

The resolver should run under daemon-local file policy:

- allowed roots are configured on the daemon
- default machine-wide Bud policy should probably allow the daemon user's home directory, not the whole filesystem
- project-scoped Buds can narrow allowed roots to a repo or directory
- future enterprise/device policy can add deny roots or require user approval for wider roots
- only regular files are served
- directories are not served through the viewer route
- symlinks remain denied in the first policy unless the canonical target is explicitly allowed in a later policy
- max display bytes default to 1 MiB for viewer sessions
- binary/image/PDF rendering remains a viewer expansion, not broader path permission

The service must not send arbitrary client-provided roots as authority. If the service sends `allowed_roots`, it should be a policy selector or scope hint that the daemon validates against its own configured policy.

## Error Model

The daemon should return typed denial reasons that the service maps to stable HTTP/UI states:

| Daemon Reason | Product Meaning |
|---------------|-----------------|
| `invalid_path` | The path string cannot be interpreted safely. |
| `not_found` | No candidate file exists under allowed policy. |
| `policy_denied` | A candidate exists but is outside allowed roots or denied by policy. |
| `directory_unsupported` | The target is a directory and the viewer only opens files. |
| `symlink_denied` | A symlink was encountered and current policy denies it. |
| `non_regular_file` | The target is a socket, FIFO, device, or other unsupported file type. |
| `ambiguous_path` | Multiple acceptable candidates were found and no deterministic choice is safe. |
| `too_large` | The file exceeds the viewer/session cap. |
| `content_changed` | The target changed between stat and read/range. |
| `resolver_timeout` | Candidate resolution exceeded its budget. |

The service should continue returning `401` only for unauthenticated browser/mobile requests and `404` for signed-in users who do not own the thread/session.

## Session Pinning

Once a path resolves, the file session should pin the resolved target for its lifetime.

Why:

- a later `cd` in the terminal should not silently change what an existing tab/session reads
- reload of an open file should reread the same resolved file unless the user explicitly opens the raw path again
- content identity checks remain meaningful

Recommended behavior:

- first click resolves `requested_path` to a daemon-approved target
- the session stores enough resolved metadata to reopen the same target
- `HEAD` / `GET` use the pinned target and expected content identity where available
- a new click on the same raw path may reuse the existing still-valid session/tab
- if the session is expired or missing, opening the raw path again re-runs resolution with the current context

## Performance Strategy

First-pass resolution should avoid recursive search.

Bounded first pass:

- parse input and generate a small finite candidate list
- at most one fresh tmux pane cwd query
- canonicalize/stat only those candidates
- stop on the first policy-allowed existing file unless ambiguity rules require otherwise
- enforce a short resolver time budget
- do not spawn shell commands for normal resolution

Follow-up basename/search support can add:

- repo-aware search using a git index when the current/root directory is a Git worktree
- daemon-maintained lightweight file index for configured roots
- depth limits, match limits, ignore rules, and time budgets
- user-facing disambiguation when multiple matches are equally plausible

Search should remain opportunistic. The correctness baseline is "open exact paths safely" rather than "find any file-like name on the machine."

## Correctness Notes

- The daemon should query tmux pane cwd at the moment it handles the file operation when a terminal session id is available.
- Tmux pane cwd is still a hint, not proof of the path's origin.
- If pane cwd is outside allowed roots, cwd-relative candidates should be skipped.
- If multiple candidates exist and the resolver cannot choose deterministically without risk, it should return `ambiguous_path`.
- Absolute and home-relative paths should be accepted only after canonicalization and policy checks.
- The service should not strip absolute paths into relative paths using its own view of the filesystem.
- The daemon should avoid revealing full absolute paths in user-visible errors unless policy explicitly allows that display.

## Privacy And Security

Machine-wide Buds need a broader default root than project-scoped Buds, but broader access should still be intentional.

Recommended default:

- one-machine Bud: allow regular files under the daemon user's home directory
- project/scoped Bud: allow regular files under configured project roots
- future policy: allow user-configured extra roots and deny roots

Sensitive behavior:

- never serve files outside allowed roots
- avoid showing absolute host paths in browser/mobile responses by default
- do not disclose whether a denied path exists outside policy
- keep sessions short-lived and revocable
- continue to stamp sessions and audit events with the acting user
- keep the agent out of file-read authority for this feature

## Phased Plan

### Phase 1: Resolver Library In The Daemon

Add a daemon resolver module used by `file_open`.

Scope:

- parse raw requested paths
- handle relative, `./`, `~/`, and absolute POSIX forms
- query terminal cwd when a session id is provided
- build finite candidates from terminal cwd and allowed roots
- canonicalize and enforce policy
- return resolved target metadata or typed denial
- unit-test candidate order, traversal rejection, outside-root denial, symlink denial, and ambiguity behavior

### Phase 2: Extend `file_open`

Extend the daemon/service `file_open` payload to carry raw requested path and resolution context.

Scope:

- keep old `root_key` / `relative_path` compatibility for existing file sessions
- allow product-created sessions to use `requested_path`
- include resolved metadata in `file_open_result`
- update protocol docs and codecs together
- add service tests for daemon denials and resolved metadata persistence

### Phase 3: Thread Open Route Uses Daemon Resolution

Update `POST /api/threads/:thread_id/files/open`.

Scope:

- stop rejecting absolute and home-relative paths at the service boundary
- still reject clearly non-local forms such as URLs and NUL-containing inputs
- authorize thread before daemon work
- use eager daemon stat/resolve when possible
- create ready sessions with resolved metadata
- return typed not-found/denied/ambiguous states
- preserve line/column metadata for later highlighting

### Phase 4: Web And Mobile Path Inputs

Relax client parsing to pass more natural path strings through the route.

Scope:

- web parser continues to avoid noisy false positives
- absolute and home-relative path candidates can show open actions
- viewer displays requested path and display-safe resolved path
- Markdown previews can reuse the same open route for local file references where wiring is straightforward
- mobile can implement equivalent parser rules against the same backend contract

### Phase 5: Optional Search And Disambiguation

Add basename or fuzzy file-name support only after exact path resolution is stable.

Scope:

- bounded search, preferably repo/index-aware
- deterministic time and match caps
- disambiguation UI for multiple matches
- explicit no-result and too-many-results states
- policy-preserving display labels

## Open Questions

1. Should the default machine-wide allowed root be the daemon user's home directory, or should onboarding require explicit root selection?
2. Should project-scoped Buds use the same identity as the machine Bud by default, or should local identity remain opt-in?
3. Should `POST /files/open` block on daemon stat/resolve, or should it create a pending session and let `HEAD` produce resolution failures?
4. What display-safe path format should the daemon return for accepted absolute paths: home-relative, root-relative, or opaque root label plus relative path?
5. Should first-pass symlink policy remain "deny all symlinks" or allow symlinks whose canonical target is under an allowed root?
6. How much ambiguity should be surfaced to users before a disambiguation UI exists?
7. What should happen when no terminal session exists for a thread yet?
8. How should paths emitted from `ssh`, containers, devcontainers, or remote build systems be represented when they are not host paths?
9. Should daemon policy have explicit deny roots for common sensitive directories inside home, such as credential stores, before a broad home-root default ships?
10. Where should policy configuration live for mobile-first users who may not edit daemon config files?

## Known Unknowns

- Tmux `pane_current_path` behavior while foreground TUIs, editors, shells, and subshells are active.
- macOS privacy/TCC behavior for daemon reads under Desktop, Documents, Downloads, and external volumes.
- Performance characteristics of future basename search over large home directories.
- How often agents or tools emit paths relative to a process cwd that differs from the shell pane cwd.
- Whether users expect denied absolute paths to say "outside allowed roots" or simply "not found."
- How content identity should behave for files that change rapidly during open/read.
- How Windows path support should be modeled if/when Bud supports Windows hosts.

## Recommendation

Treat daemon-owned path resolution as the target architecture for file viewer path semantics.

Near-term implementation should keep the existing user-initiated file-session model, but move raw path interpretation into the daemon rather than asking the service or clients to normalize paths into a single workspace-relative form. The daemon can then accept natural path strings from one machine-wide Bud while still serving only files that pass conservative local policy.

The older workspace-root model remains useful as a policy mode and compatibility path, but it should not be the core product assumption.
