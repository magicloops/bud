# Phase 3: Web/Mobile Adoption + Install Cleanup

Design refs: D14 (doctor/installer), D15d (clients).

## Objective

Clients consume the event contract properly, the resume story works end to end in the browser, and every trace of the tmux dependency is gone from the install/setup experience.

## Work items

### 3.1 Web: terminal stream (`web/src/features/threads/use-terminal-session.ts` and friends)

- **Offset-based resume replaces reset+snapshot:** reconnect sends the last *applied* byte offset (SSE `Last-Event-ID` or query param per finalized proto); server backfills from the store; no `term.reset()` on routine reconnects. Buffer live events until backfill is applied (closes the snapshot/live race). Full reset only on `TruncatedFrom`-style gap notices.
- Persistent streaming `TextDecoder` per connection (`{stream: true}`), reset only on genuine resets — fixes the UTF-8 chunk-boundary corruption.
- Staleness/reconnect policy driven by heartbeats + `terminal.event` instead of the 5s-equals-heartbeat threshold; derive thresholds from one shared constant with the service.
- Stop silently dropping typed input while disconnected: queue with a visible pending state, or surface the drop.
- **Line-oriented history replay** (accepted §A limitation): raw byte-tail replay renders ~no visible lines after TUI-heavy sessions (alt-screen bytes produce no scrollback). Replace the 128 KiB byte-tail snapshot with line-oriented scrollback served from stem's emulator — interim via `terminal_observe view:history` (text-only), properly via the grid-sync scrollback channel (`design/terminal-grid-sync-and-predictive-echo.md`).

### 3.2 Web: event-driven terminal/agent status UI

- `terminal.event` consumers: command running/finished chips (exit code), mode indicator (`shell/tui/repl`), honest "waiting on TUI" state; remove heuristic activity inference.
- No command-block rendering in this phase (D15e — deferred to Phase 4).

### 3.3 Mobile handoff

- Update the mobile contract docs (`design/mobile-*` family, or a new `design/mobile-terminal-events-handoff.md`) with the finalized SSE/REST shapes: `terminal.event`, offset resume, `terminal_command` reads. iOS implementation itself is out of scope; the deliverable is the contract doc plus a validation checklist section they can run.

### 3.4 Installer / doctor / service templates

- `install.sh` + `get.bud.dev` manifest: remove tmux preflight and remediation text (single-binary story is now literal).
- `bud doctor`: tmux checks deleted; new checks — registry dir writable, holder spawn/detach smoke, supervision-directive probe (asserts the Phase 0 recipe is present in the installed plist/unit); `--cleanup-tmux` one-shot for orphaned `s_*` sessions.
- launchd plist / systemd unit templates updated with the Phase 0 survival directives (`AbandonProcessGroup` / `KillMode=process` or equivalents); upgrade path re-validated (old holders + new daemon).
- `plan/daemon-readiness` phase-1/phase-4 docs annotated as superseded where they describe tmux preflight.

### 3.5 Docs sweep

- Root `bud.spec.md`: §Why tmux? → §Terminal backend (`stem`); architecture diagrams and concept tables updated.
- `README`s and any user-facing setup docs: tmux removed.

## Test plan

- Web: unit tests for the resume/backfill reducer and decoder lifecycle (the pure-helper extraction pattern already used in `web/src/features/threads/*`); a scripted E2E reconnect drill (kill service SSE mid-stream, assert no lost/duplicated bytes rendered, no spurious full reset).
- Install: clean-VM (or clean-user) install on macOS + one Linux distro **without tmux present**; full session lifecycle + daemon upgrade simulation; doctor output reviewed.
- Full [validation-checklist.md](./validation-checklist.md) pass (§A and §B).

## Exit criteria

- A tmux-less machine: `curl get.bud.dev | sh` → claim → thread → `terminal.run` returns exit codes → vim survives a daemon upgrade → browser reconnect shows no gaps. `grep -ri tmux` across `install`, `doctor`, user docs returns only historical notes.

## Spec files to update

- `web/src/features/threads/*.spec.md` (stream hooks), root `bud.spec.md`, `deploy/get-bud-dev/release-hosting.md` if preflight is mentioned, `plan/daemon-readiness` supersession notes.
