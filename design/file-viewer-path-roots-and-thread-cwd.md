# Design: File Viewer Path Roots And Thread CWD

Status: Draft

Superseded direction: [daemon-owned-file-path-resolution.md](./daemon-owned-file-path-resolution.md) promotes daemon-owned resolution to the target product architecture. This document is retained for the implementation findings and option comparison that led to that decision.

Audience: Daemon, service, web, iOS, and product

Last updated: 2026-05-02

Related:
- [file-serving-user-initiated-viewer.md](./file-serving-user-initiated-viewer.md)
- [bud-base-dir-and-local-identity.md](./bud-base-dir-and-local-identity.md)
- [network-upgrade-file-serving-productization.md](./network-upgrade-file-serving-productization.md)

## Context

The first file viewer pass opens files by creating short-lived `file_session` rows for workspace-relative paths. That keeps file access user-initiated and reuses the daemon-side `file_open` policy gate.

The current path-root behavior is not yet a clear product model:

- `BUD_DEFAULT_CWD` / `--cwd` defaults to `~`.
- `BudApp` expands that value into `default_cwd`.
- the daemon file manager uses that `default_cwd` as the `workspace` file root.
- terminal sessions do not use that same default when the service omits `cwd`; `TerminalManager` falls back to literal `~`.
- the service generally omits `cwd` when ensuring thread terminal sessions.
- tmux can report `#{pane_current_path}`, and the daemon includes a reported `cwd` in `terminal_status`, but this is captured at ensure/reattach time and is not a durable, continuously updated thread cwd.

In practice, a thread can run commands from a directory that differs from the file viewer root. The problem becomes visible when the assistant references paths relative to the shell's current directory, but the file viewer resolves those paths relative to the daemon's `workspace` root.

Example:

1. Bud runs on a macOS host.
2. The user's useful projects are under `~/bud` and `~/bud-mobile`.
3. A thread starts at `~`, then the agent runs `cd ~/bud/service`.
4. The assistant references `src/files/file-session.ts`.
5. The file viewer tries to open `~/src/files/file-session.ts` when the intended file is `~/bud/service/src/files/file-session.ts`.

## Goals

1. Define a simple, durable path-root model for file viewing.
2. Keep file reads secure and daemon-authorized.
3. Avoid service-side guesses about thread cwd.
4. Support project-scoped Buds cleanly.
5. Preserve a path to better subdirectory-relative references later.
6. Keep the mobile contract understandable.

## Non-Goals

- giving the agent file-read authority
- building a general file browser
- adding file writes
- trusting arbitrary host absolute paths without daemon validation
- implementing continuous shell cwd tracking in this design
- making tmux-specific cwd behavior part of the long-term service contract

## Definitions

### Bud Workspace Root

The daemon-owned local root used for file reads and default terminal session start. File viewer paths are interpreted inside this root unless a later daemon resolver deliberately chooses another approved root.

### Terminal Initial CWD

The directory a thread-owned terminal starts in. This should default to the Bud workspace root.

### Terminal Current CWD

The runtime working directory of the process currently active in the terminal. This can change after `cd`, shells, subshells, scripts, `ssh`, containers, editors, or other interactive programs.

### Reported CWD

The cwd the daemon reports through terminal status. With tmux, this comes from `#{pane_current_path}`. It is useful context, but it should be treated as a hint unless it is freshly queried and validated by the daemon for a specific file operation.

## Current Implementation Findings

### Daemon Defaults

`BudArgs.cwd` currently defaults to `~`. `BudApp::new(...)` expands `args.cwd` and passes it to:

- `RunExecutor::new(default_cwd.clone())`
- `FileManager::new(default_cwd)`

That means the file adapter's `workspace` root is usually home unless `--cwd` / `BUD_DEFAULT_CWD` is set explicitly.

### Terminal Session Creation

`TerminalManager::ensure_terminal_session(...)` does:

```rust
let cwd = cfg.cwd.unwrap_or_else(|| "~".to_string());
```

The tmux backend then runs:

```text
tmux new-session ... -c <cwd> <shell>
```

So terminal sessions also default to home today, but through a separate fallback path. If we change one default without the other, the mismatch can get worse.

### File Resolution

`FileManager` only accepts `root_key = "workspace"` and validates a root-relative path. It resolves by joining:

```text
workspace_root + relative_path
```

then canonicalizes and rejects symlinks, non-regular files, and paths that escape the workspace root.

This is the right security shape. The unresolved product question is what the `workspace_root` should be and whether relative clicked paths should ever be resolved against a thread's current terminal cwd.

### Service State

The service has terminal-session cwd fields and terminal ensure schemas, but it is not currently the authority for a thread's live cwd. The service can see terminal status payloads, but that is not enough to make path resolution safe or precise.

## Option A: Home Directory As The Bud Workspace Root

Make home the intentional root for a long-lived global Bud. File viewer paths are home-relative unless absolute path support is added later.

Pros:

- fits the idea of one long-lived Bud per machine
- one Bud can access multiple user projects under home
- matches today's default behavior closely
- simple to explain for global Buds

Cons:

- broad file root increases accidental exposure and noisy false positives
- path references from project subdirectories still fail unless the assistant includes the full home-relative prefix
- `src/foo.ts` from `~/bud/service` still resolves as `~/src/foo.ts`
- less natural for project-local work
- does not encourage multiple isolated Buds for different workspaces

Assessment:

Home is a reasonable explicit global-Bud mode, but it is not the best default for a project-oriented file viewer.

## Option B: Bud Launch/Base Directory As The Workspace Root

Define one stable Bud workspace root. Use it for:

- file manager `workspace`
- default run cwd
- default terminal initial cwd
- terminal artifact root, if/when the base-dir design lands

This pairs naturally with [bud-base-dir-and-local-identity.md](./bud-base-dir-and-local-identity.md): a user can run one Bud from `~/bud`, another from `~/bud-mobile`, and optionally use local identity mode for separate device identities.

Pros:

- simple product contract: "paths are relative to this Bud's workspace"
- file viewer and terminal initial cwd align
- supports multiple project-scoped Buds on one machine
- narrows file access to the intended project root
- does not depend on tmux current-path behavior
- good mobile mental model

Cons:

- a single global Bud no longer naturally spans every project unless its root is home
- after the agent runs `cd service`, `src/foo.ts` is still relative to `service`, not the Bud root
- users may need to start separate Buds for separate workspaces
- requires daemon config cleanup so terminal and file defaults come from the same root

Assessment:

This should be the default product direction. It fixes the current root mismatch and gives Bud a durable workspace concept without inventing service-side cwd authority.

## Option C: Thread Initial CWD As The File Root

Persist a cwd at thread creation and use that as both terminal initial cwd and file viewer root for that thread.

Pros:

- lets one Bud host multiple project threads without multiple daemon instances
- thread path references can be scoped to the project selected at thread start
- stable once chosen

Cons:

- requires UI/API for selecting or deriving thread cwd
- still does not solve paths relative to later `cd` commands
- service would need to persist and authorize per-thread root metadata
- daemon file policy would need to accept multiple roots or per-request root descriptors
- more stateful than needed for the first improvement

Assessment:

Useful later, but not the simplest next step. Prefer project-scoped Bud roots first.

## Option D: Dynamic Thread Current CWD In The Service

Track the thread terminal's current directory in the service and resolve relative file paths against it.

Possible signals:

- `terminal_status.info.cwd`
- parsed shell prompts
- agent command history
- explicit `cwd` values supplied by the user/client

Pros:

- aligns with how users and agents think after `cd`
- can make `src/foo.ts` work from subdirectories

Cons:

- brittle with tmux, shells, subshells, scripts, containers, `ssh`, editors, REPLs, and TUIs
- reported cwd can be stale
- prompt parsing is unreliable and shell-specific
- service-side cwd can become a false authority
- incorrect resolution can open the wrong file, which is worse than a clear failure

Assessment:

Do not make service-tracked cwd a trusted resolver. It can be displayed as context or used as a hint, but not as authority for opening files.

## Option E: Always Require Absolute Paths

Require agents and clients to emit absolute host paths, similar to Codex-style file links.

Pros:

- unambiguous for the human and client
- avoids cwd ambiguity
- works across projects if the daemon allows the path

Cons:

- leaks host filesystem structure into transcripts
- not mobile-friendly
- requires absolute-path policy and daemon-side canonicalization
- users and agents often produce relative paths naturally
- still needs a safe root policy, because arbitrary absolute reads are not acceptable

Assessment:

Good as a future accepted input form after daemon-owned resolution exists. Not the right first-pass product requirement.

## Option F: Daemon-Owned Path Resolution

Add a daemon resolver that receives a raw path and a resolution context, then returns an approved `root_key` plus `relative_path` or a typed denial.

The resolver can query tmux at the moment of the click when a terminal session id is provided:

```json
{
  "type": "file_resolve",
  "raw_path": "src/files/file-session.ts",
  "thread_id": "uuid",
  "terminal_session_id": "bud-b_123-thread-456",
  "allowed_roots": ["workspace"],
  "resolution_order": ["terminal_cwd", "workspace"]
}
```

Possible result:

```json
{
  "accepted": true,
  "root_key": "workspace",
  "relative_path": "service/src/files/file-session.ts",
  "display_path": "src/files/file-session.ts",
  "resolved_against": "terminal_cwd"
}
```

Pros:

- daemon owns host-local canonicalization and tmux interaction
- service does not need to track live cwd
- can support subdirectory-relative and absolute paths safely
- can fail closed when current cwd is outside the allowed workspace root
- keeps `file_open` using the existing approved `root_key` and `relative_path`

Cons:

- new daemon-service request/response family
- click now needs a resolve round trip before session creation
- tmux current path can still be surprising, especially inside remote/container contexts
- requires clear fallback/ambiguity behavior

Assessment:

This is the right later mechanism for subdirectory-relative paths and absolute paths. It should not replace the simpler stable-root fix.

## Recommendation

Adopt a layered model:

1. Define a stable Bud workspace root.
2. Make terminal initial cwd and file `workspace` root the same value.
3. Keep first-pass file viewer paths workspace-root-relative.
4. Encourage one Bud per project workspace for project-oriented work.
5. Treat home-root Buds as an explicit global mode, not the only product model.
6. Do not trust service-tracked thread cwd for file resolution.
7. Add daemon-owned path resolution later for paths relative to the current terminal cwd and for absolute paths.

This gives us a robust base immediately and leaves room for better path ergonomics without baking tmux-specific or prompt-parsing assumptions into the service contract.

## Proposed Product Contract

### First Stable Contract

For the near term:

- each Bud has one `workspace` root
- terminal sessions start in that root unless an explicit cwd is provided
- file viewer relative paths are interpreted from that root
- assistant prompts should prefer workspace-relative paths
- the web/mobile UI should describe failures as "not found under this Bud workspace" rather than "not found on host"

### Explicit Global Bud Mode

If a user wants one Bud to span many projects, they can choose home as the workspace root.

The tradeoff is explicit:

- paths must be home-relative, or
- future daemon-owned resolution must resolve current-cwd/absolute paths

### Project-Scoped Bud Mode

If a user wants clean file links and isolated workspaces, they should run separate Buds rooted at each project:

```bash
cd ~/bud
bud --local

cd ~/bud-mobile
bud --local
```

The exact flags depend on the base-dir/local-identity rollout, but the product concept is one Bud workspace per project.

## Implementation Direction

### Phase 1: Align Daemon Defaults

Use one effective workspace/default-cwd value for:

- file manager root
- run executor cwd
- terminal session fallback cwd

Concrete daemon changes:

- add `default_cwd` or `workspace_root` to `TerminalConfig`
- change `TerminalManager::ensure_terminal_session(...)` fallback from `"~"` to that configured value
- keep explicit `terminal_ensure.config.cwd` highest precedence
- ensure `FileManager::new(...)` uses the same effective value
- add tests that terminal creation receives the configured default cwd when no `cfg.cwd` is provided

This phase does not need service-side live cwd tracking.

### Phase 2: Land The Base Directory UX

Adopt the direction from [bud-base-dir-and-local-identity.md](./bud-base-dir-and-local-identity.md):

- `--base-dir` / `BUD_BASE_DIR`
- optional `--local`
- explicit `--cwd` / `BUD_DEFAULT_CWD` as highest-precedence default cwd override
- default base dir from launch cwd for project-local usage
- identity remains global unless `--local` or explicit identity path is used

If Phase 2 is too large, Phase 1 can still be landed first by simply making terminal fallback use the already computed daemon `default_cwd`.

### Phase 3: Product Copy And Prompting

Update the first-party client and agent prompt guidance:

- file viewer opens workspace-relative paths
- assistants should cite paths relative to the Bud workspace when possible
- absolute and current-directory-relative path support is not guaranteed yet
- error states should name the workspace-root-relative limitation

This is not security-critical, but it reduces false failures before daemon-owned resolution exists.

### Phase 4: Daemon-Owned Resolve Follow-Up

Add `file_resolve` as the path ergonomics expansion:

- service sends raw clicked path, file source metadata, and optional terminal session id
- daemon resolves using a documented order, initially `terminal_cwd` then `workspace`
- daemon canonicalizes and checks that the selected file is inside an allowed root
- daemon returns `root_key`, `relative_path`, and `resolved_against`
- service creates the normal `file_session` from that result

This phase can also add absolute path support safely:

- absolute paths are accepted only when canonicalized under an allowed root
- home-relative `~/...` is accepted only if policy allows and canonicalizes under an allowed root
- paths outside allowed roots return typed denial

## Resolution Order For Future `file_resolve`

Recommended order when a terminal session is available:

1. If raw path is already workspace-relative and exists under workspace, accept it.
2. If raw path is relative and terminal current cwd is inside workspace, try terminal-cwd-relative.
3. If raw path is absolute, canonicalize and accept only if it is inside workspace or another approved root.
4. If raw path starts with `~`, expand on the daemon and accept only if inside an approved root.
5. Otherwise deny with a typed reason.

Rationale:

- trying workspace first preserves today's contract
- terminal cwd helps the `cd service` case
- daemon canonicalization keeps the service out of host path semantics
- denial is better than guessing when ambiguous

Open question: if both workspace-relative and terminal-cwd-relative candidates exist but differ, should the daemon return an ambiguity error or prefer one? The safer default is ambiguity error with both display candidates in non-sensitive form.

## Why Not Service-Side Current CWD?

The service should not be the authority for a live shell's cwd because the data it can observe is incomplete:

- terminal output does not reliably encode cwd
- prompts lie or omit path information
- `cd` can happen inside scripts or shell functions
- foreground processes may not be shells
- tmux pane cwd can change independently of service state
- remote shells and containers can make host paths meaningless

The daemon can query and validate host-local facts at the time of a file operation. That is the correct boundary.

## Security Notes

- A wider root such as home increases the number of readable files if a user clicks a path. It should be an explicit workspace choice, not an accidental side effect.
- Project-scoped Buds give the narrowest useful root for file viewing.
- The service should continue to authorize by viewer-owned thread before any file session or resolver request.
- The daemon should remain the final local filesystem authority.
- Absolute paths should not be accepted until daemon-owned canonicalization and allowed-root policy are in place.
- Reported cwd should be treated as display/context unless freshly resolved by the daemon during a specific file-open flow.

## Open Questions

1. Should the default installed Bud be global-home-root or launch-directory-root once `--base-dir` exists?
2. Should the claim/onboarding flow expose "project Bud" versus "global Bud" as distinct setup choices?
3. Should web show the current Bud workspace root label anywhere, or is that too much local host detail?
4. Should future `file_resolve` return ambiguity details to the UI, or only a generic ambiguous-path error?
5. Should thread creation eventually support an explicit initial cwd under the Bud workspace root?
6. How should remote/container cwd be represented if the terminal is inside `ssh`, Docker, or a devcontainer?

## Near-Term Recommendation

For the file viewer follow-up, do the smallest robust fix:

1. Make daemon terminal fallback cwd use the same effective root as the file manager.
2. Treat that effective root as the Bud workspace root.
3. Keep the viewer contract workspace-relative.
4. Update prompt/client copy to ask for workspace-relative paths.
5. Defer subdirectory-relative and absolute support to daemon-owned `file_resolve`.

This directly addresses the current mismatch while avoiding a fragile service-owned model of thread cwd.
