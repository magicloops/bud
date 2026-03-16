# Design: Bud Base Directory, Launch CWD Defaults, and Local Identity Mode

## Problem Statement

Bud currently mixes together three different concepts:

1. the daemon's long-lived device identity
2. the directory used for terminal logs and session artifacts
3. the default cwd for terminal sessions and one-shot commands

In the current implementation:

- identity defaults to `~/.bud/identity.json`
- terminal logs default to `~/.bud`
- the daemon's default cwd also defaults to `~`
- terminal sessions fall back to `~` whenever the service does not send an explicit cwd

This makes common local workflows harder than they should be:

- A single user cannot easily run multiple Buds against different project directories unless they manually override multiple flags.
- Running Bud from a project directory does not naturally make terminal sessions start there.
- The low-level flags exist, but there is no clear high-level model for "global Bud" vs "local Bud".
- It is awkward to run Bud from its source or development directory while still treating the user's home Bud root as the base dir.

We want a simpler and more intentional model.

## Goals

- Keep the default identity global, so a normal Bud install still behaves like a single reusable device identity.
- Make the default terminal base dir come from where Bud is launched, so project-local usage feels natural.
- Make the default terminal cwd also come from that launch/base directory when no more specific cwd is supplied.
- Add a simple optional flag that makes Bud "local", meaning its identity is also scoped to the launch/base directory under a hidden `.bud/` subdirectory.
- Keep all paths overridable with explicit flags/env vars.
- Make it easy to run Bud from a development directory while pointing its base dir back at a user-global location.
- Preserve a clear mental model for users and for future documentation.

## Non-Goals

- Redesigning the full service-side terminal session schema in the same tranche.
- Changing Bud ownership, claim flow semantics, or multi-user authorization rules.
- Solving tmux namespace isolation in this document.

## Terminology

### Launch Directory

The process current working directory at Bud startup.

This design uses "the directory Bud is run from" to mean `std::env::current_dir()` at process start, not the directory containing the Bud executable.

That distinction matters:

- a shared global `bud` binary can be invoked from many project directories
- a copied Bud binary can still be run from some other shell cwd
- wrapper scripts can choose either behavior explicitly by `cd`ing first

### Base Directory

The directory Bud uses as the root for local runtime state such as:

- terminal session artifacts
- terminal output logs
- default terminal cwd when no more specific cwd is set
- other future per-instance local files that are not the global identity by default

### Global Identity Mode

The default Bud mode:

- identity file remains user-global
- installation identity remains adjacent to that identity file
- base dir still defaults to the launch directory unless overridden

### Local Identity Mode

An optional Bud mode enabled by a simple flag:

- identity file becomes local to a hidden `.bud/` directory under the effective base directory
- installation identity becomes local to that same hidden directory
- this enables multiple concurrent Bud instances for one human user without sharing device identity

## Current Implementation Summary

Today:

- `--identity-file` controls identity storage directly.
- `installation-id` is derived as a sibling of the identity file.
- `--terminal-base-dir` controls only terminal log storage.
- `--cwd` controls the run executor default cwd.
- terminal sessions ignore both `--cwd` and `--terminal-base-dir` unless the service explicitly provides `config.cwd`.
- the service currently does not send a `cwd` in `terminal_ensure`, so the daemon falls back to `~`.

This means the current model is low-level and fragmented rather than user-oriented.

## Proposed UX Model

Bud should expose two distinct top-level concepts:

1. **Where should this Bud keep its runtime base files and start its terminals?**
2. **Should this Bud reuse the global identity, or have a local identity in that base directory?**

That leads to:

- `--base-dir <path>`: choose the effective Bud base directory
- `--local`: choose local identity mode

The existing low-level flags remain available for full overrides:

- `--identity-file`
- `--cwd`

## Proposed Default Behavior

### Without Any New Flags

If the user runs:

```bash
cd /Users/adam/code/foo
bud
```

Then Bud should resolve:

- effective base dir: `/Users/adam/code/foo`
- identity file: `~/.bud/identity.json`
- installation-id: `~/.bud/installation-id`
- terminal artifact dir: `/Users/adam/code/foo`
- default terminal cwd: `/Users/adam/code/foo`
- default run cwd: `/Users/adam/code/foo`

This preserves the familiar single-Bud identity while making the runtime behavior project-local.

### With `--local`

If the user runs:

```bash
cd /Users/adam/code/foo
bud --local
```

Then Bud should resolve:

- effective base dir: `/Users/adam/code/foo`
- identity file: `/Users/adam/code/foo/.bud/identity.json`
- installation-id: `/Users/adam/code/foo/.bud/installation-id`
- terminal artifact dir: `/Users/adam/code/foo`
- default terminal cwd: `/Users/adam/code/foo`
- default run cwd: `/Users/adam/code/foo`

This is the intended path for multiple concurrent Buds owned by one user across multiple project directories.

### With Explicit `--base-dir`

If the user runs:

```bash
cd /Users/adam/code/bud
bud --base-dir ~/.bud
```

Then Bud should resolve:

- effective base dir: `~/.bud`
- identity file: `~/.bud/identity.json`
- installation-id: `~/.bud/installation-id`
- terminal artifact dir: `~/.bud`
- default terminal cwd: `~/.bud`
- default run cwd: `~/.bud`

This makes it easy to launch Bud from a development directory while treating the user-root Bud directory as the real runtime base.

## Path Resolution Model

The design should use one "effective base dir" computation and build defaults from it.

### Effective Base Dir

Resolution order:

1. explicit `--base-dir`
2. env `BUD_BASE_DIR`
3. launch directory

### Effective Identity File

Resolution order:

1. explicit `--identity-file`
2. env `BUD_IDENTITY_FILE`
3. if `--local` or `BUD_LOCAL=true`: `<effective-base-dir>/.bud/identity.json`
4. otherwise: `~/.bud/identity.json`

### Effective Installation ID Path

Always derived as a sibling of the effective identity file:

- `<identity-file-parent>/installation-id`

### Effective Default CWD

Resolution order:

1. explicit `--cwd`
2. env `BUD_DEFAULT_CWD`
3. effective base dir

This value should be used consistently by:

- the run executor
- daemon fallback terminal cwd when `terminal_ensure.config.cwd` is absent

### Effective Terminal Artifact Dir

Resolution:

- effective base dir

This directory holds:

- `sessions/<session-id>/terminal.log`
- future terminal-local artifacts

## CLI Proposal

### New High-Level Flags

#### `--base-dir <path>`

Sets the Bud base directory.

Intended meaning:

- where terminals start by default
- where terminal logs/artifacts live by default
- the directory local identity mode uses by default

Suggested env var:

- `BUD_BASE_DIR`

#### `--local`

Enables local identity mode.

Intended meaning:

- if the identity file is not explicitly set, derive it from the effective base dir instead of `~/.bud`
- store that local identity under `<effective-base-dir>/.bud/`

Suggested env var:

- `BUD_LOCAL`

### Existing Flags

#### `--identity-file`

Remains the highest-precedence identity override.

#### `--cwd`

Remains the highest-precedence cwd override.

Under this design, it overrides the default terminal cwd and default run cwd, regardless of base dir.

#### `--terminal-base-dir`

This design treats `--base-dir` as the replacement for `--terminal-base-dir`.

The canonical user-facing concept becomes:

- one Bud base dir
- one default terminal artifact root derived from that base dir

If we keep `--terminal-base-dir` temporarily, it should only exist as a short-lived deprecated compatibility alias that maps directly to `--base-dir`.

## Behavior Matrix

| Scenario | Launch Dir | Flags | Identity File | Base Dir | Default Terminal CWD |
|----------|------------|-------|---------------|----------|----------------------|
| Shared global Bud from project dir | `/code/foo` | none | `~/.bud/identity.json` | `/code/foo` | `/code/foo` |
| Local Bud for one project | `/code/foo` | `--local` | `/code/foo/.bud/identity.json` | `/code/foo` | `/code/foo` |
| Run from dev repo but use user-root Bud dir | `/code/bud` | `--base-dir ~/.bud` | `~/.bud/identity.json` | `~/.bud` | `~/.bud` |
| Local identity with explicit custom base | `/code/bud` | `--local --base-dir /tmp/bud-a` | `/tmp/bud-a/.bud/identity.json` | `/tmp/bud-a` | `/tmp/bud-a` |
| Fully explicit custom identity/cwd | any | `--identity-file /tmp/id.json --cwd /tmp/work --base-dir /var/tmp/bud` | `/tmp/id.json` | `/var/tmp/bud` | `/tmp/work` |

## Why This Model Fits The Requirements

### Single reusable Bud still works

By default, identity remains global. A user can run Bud from many directories and still reconnect as the same Bud.

### Multiple concurrent Buds become simple

`bud --local` from different project directories naturally gives:

- different identity files under hidden local `.bud/` directories
- different installation IDs
- different terminal cwd defaults
- different terminal artifact directories

### Running from source while using home-root Bud state is straightforward

`bud --base-dir ~/.bud` is the simple override for that case.

### Wrapper scripts stay useful

Teams can continue to wrap Bud in small scripts that:

- `cd` into a chosen project directory before launch
- pass `--local`
- or pass `--base-dir` explicitly

## Proposed Implementation Shape

### Phase 1: Daemon-Centric Default Resolution

Add the new resolution model on the Bud daemon side:

- compute effective base dir
- compute effective identity path
- compute effective default cwd
- use effective default cwd for run executor initialization
- use effective default cwd as terminal fallback instead of hard-coded `~`
- use effective base dir as the terminal artifact root
- resolve local identity mode to `<effective-base-dir>/.bud/identity.json`

This phase alone would fix the current "session starts in `~`" behavior even if the service continues to omit `cwd` from `terminal_ensure`.

### Phase 2: Service-Side Session CWD Wiring

Wire explicit session settings end to end:

- persist terminal session `cwd` and `shell`
- parse and honor `POST /api/threads/:threadId/terminal/ensure` body
- send `cwd` and `shell` in `terminal_ensure.config`
- optionally persist Bud-reported `cwd`/`shell` from `terminal_status`

This phase should ship in the same change as the daemon-side default resolution, not as a later follow-up. The goal is to land one coherent cwd model for both implicit defaults and explicit per-session terminal configuration.

### Phase 3: Documentation Cleanup

Update:

- Bud README
- daemon specs
- local setup docs
- helper script examples

The docs should consistently explain:

- launch directory
- base dir
- global identity vs local identity

## Compatibility and Migration Notes

### Identity Compatibility

Default identity behavior stays global, so existing Bud users keep the same device identity unless they opt into local mode or explicitly change the identity file.

### Terminal Behavior Compatibility

Changing the default terminal base dir and terminal cwd from `~/.bud` / `~` to the launch directory is a behavior change.

It is intentional, but we should call it out clearly in release notes and docs.

### Flag Compatibility

`--base-dir` becomes the canonical replacement for `--terminal-base-dir`.

If we preserve the old flag during migration, it should be documented as deprecated and mapped directly onto `--base-dir` semantics rather than continuing as a separate concept.

### Concurrent Process Safety

Global identity mode still implies one logical Bud identity unless the user explicitly overrides identity path.

If a user wants multiple concurrent Buds, they must use:

- `--local`
- or distinct explicit `--identity-file` paths

## Decisions And Open Questions

### Resolved Decisions

#### 1. "Run from" means launch cwd, not executable directory.

- it matches normal shell expectations
- it works with a shared global `bud` binary
- it makes project-local invocation natural

#### 2. Local identity lives under a hidden `.bud/` subdirectory.

Concrete paths:

- `<base-dir>/.bud/identity.json`
- `<base-dir>/.bud/installation-id`

Terminal artifacts remain rooted at the base dir itself unless explicitly redesigned later.

#### 3. `--base-dir` replaces `--terminal-base-dir`.

There should be one canonical base-directory concept. A temporary deprecated alias is acceptable only as a migration aid.

#### 4. `--cwd` overrides both runs and terminal sessions.

- users read `--cwd` as "default Bud working directory"
- splitting semantics between runs and terminals creates confusion

#### 5. Service-side explicit session cwd wiring ships in the same change.

The daemon default-resolution work and the service-side `terminal_ensure` cwd plumbing should land together so the resulting behavior is consistent for both implicit defaults and explicit per-session terminal configuration.

### Remaining Open Questions

#### 1. Should local mode change the default device name?

Possible convenience behavior:

- if `--local` is enabled and no `--name` is set, default the device name to the basename of the effective base dir

Example:

- `/code/foo` -> `foo`

This is useful for multi-project local testing, but it is optional and can be deferred.

## Recommendation

Adopt the following high-level decisions:

1. "Run from" means process launch cwd.
2. Add `--base-dir` as the public base-directory concept.
3. Default base dir to the launch cwd.
4. Add `--local` to make identity local to `<effective-base-dir>/.bud/`.
5. Default terminal cwd and run cwd to the effective base dir unless `--cwd` is set.
6. Make `--base-dir` the canonical replacement for `--terminal-base-dir`.
7. Keep explicit path flags as highest-precedence overrides.
8. Ship service-side explicit terminal cwd wiring in the same change as the daemon default-resolution work.
