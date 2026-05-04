# Phase 0: Validate Tmux `pane_current_path`

## Objective

Confirm whether tmux `#{pane_current_path}` reports the host directory users expect file links to resolve from while common foreground programs are active.

This phase should happen before implementing daemon resolution. If the observation is poor, do not proceed blindly into the service/daemon changes.

## Setup

Use a local macOS machine with tmux available.

Create or pick:

- a tmux session
- a known project directory such as `~/bud`
- a known subdirectory such as `~/bud/service`
- a known file under that subdirectory

Useful tmux query:

```bash
tmux display-message -p -t <session-or-pane> '#{pane_current_path}'
```

If running through Bud, compare this with the daemon's existing `TmuxBackend::pane_cwd(...)` behavior.

## Test Matrix

| Case | Steps | Expected |
| --- | --- | --- |
| Plain shell at home | Start tmux shell at `~`; query `pane_current_path`. | Reports home. |
| Shell after cd | `cd ~/bud/service`; query. | Reports `~/bud/service`. |
| Foreground sleep | From `~/bud/service`, run `sleep 30`; query during sleep. | Prefer `~/bud/service`. |
| Pager | From `~/bud/service`, run `less package.json` or another file; query while pager is active. | Prefer `~/bud/service`. |
| Editor/TUI | From `~/bud/service`, run a local TUI/editor available on the machine; query while active. | Prefer `~/bud/service`. |
| REPL | From `~/bud/service`, start `node`, `python`, or similar; query while active. | Prefer `~/bud/service`. |
| Agent-style TUI | From `~/bud/service`, run Codex/Claude-style TUI if practical; query while active. | Prefer `~/bud/service`. |
| Nested shell | From `~/bud`, start nested shell, `cd service`; query. | Prefer nested shell cwd if tmux reports it. |
| Internal cwd change | Run a small process that changes cwd internally and stays alive; query. | Record actual behavior; do not assume. |

## Deliverable

Create a debug note or append observations to this phase file before implementation starts.

Minimum observation format:

```markdown
## Observations

| Case | Observed `pane_current_path` | Matches Expected? | Notes |
| --- | --- | --- | --- |
| Shell after cd | `/Users/adam/bud/service` | Yes | |
```

## Go / No-Go Criteria

Go if:

- plain shells, `cd`, foreground commands, pagers, and at least one REPL/TUI report the expected project/subdirectory cwd
- failures are understandable and workspace fallback remains acceptable

Pause if:

- tmux often reports home or the original session cwd while foreground tools are active
- tmux reports paths unrelated to where users expect relative file references to resolve
- common agent/TUI workflows consistently produce misleading cwd

## Follow-Up If Paused

Revisit broader daemon-owned resolution before implementation:

- process cwd inspection
- shell integration
- explicit terminal cwd updates
- user-visible cwd selection
- delayed absolute path support
