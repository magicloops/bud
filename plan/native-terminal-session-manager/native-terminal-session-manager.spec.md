# native-terminal-session-manager.spec.md

Phased implementation plan for replacing tmux with `stem`, a Bud-shipped PTY session manager, including the pre-release redesign of the terminal wire/tool contracts around typed events. Decisions live in [design/native-terminal-session-manager.md](../../design/native-terminal-session-manager.md) (D1–D15); these plan files sequence the work.

## Files

| File | Purpose |
|---|---|
| [implementation-spec.md](./implementation-spec.md) | Parent plan: objective, phase overview and gates, impacted contracts, spec-update inventory, rollout rules (contract-first, single cutover branch) |
| [phase-0-holder-survival-spike-and-proto-draft.md](./phase-0-holder-survival-spike-and-proto-draft.md) | Gating spike: detached-holder survival matrix under launchd/systemd, emulator bake-off (`wezterm-term` vs `alacritty_terminal`) with reusable fixture corpus, and the proposed `docs/proto.md` terminal revision |
| [phase-1-stem-crate.md](./phase-1-stem-crate.md) | The `stem` crate: workspace conversion, module layout (holder/pty/ring/ipc/registry/client/emu/semantic/events/keys/introspect), dumb-holder behavioral rules, and the daemon-free test suite incl. IPC version-skew CI |
| [phase-2-daemon-and-service-cutover.md](./phase-2-daemon-and-service-cutover.md) | The cutover: daemon terminal runtime rebuilt on `stem` (tmux/trait/wait-strategies deleted, dispatch de-serialized), finalized wire contract, service event routing with bud-ownership assertions, `terminal_command` table, `terminal.run` tool surface |
| [phase-3-web-mobile-and-install-cleanup.md](./phase-3-web-mobile-and-install-cleanup.md) | Client adoption: browser offset-resume replacing reset+snapshot, event-driven status UI, mobile contract handoff, installer/doctor/service-template tmux removal |
| [phase-4-deferred-follow-ups.md](./phase-4-deferred-follow-ups.md) | Optional: `bud term attach`/`peek`, command-block UX on the `terminal_command` substrate, crate extraction, Windows/ConPTY |
| [validation-checklist.md](./validation-checklist.md) | Manual E2E verification: §A core (Phase 2 gate) covering OSC 133 exit codes, TUI/REPL modes, restart/upgrade persistence, ring backfill; §B clients/install (Phase 3 gate); grep-able regression sentinels |

## Status

- [ ] Phase 0 — **in progress (2026-08-14)**: 0.2 emulator bake-off ✅ complete (decision: `alacritty_terminal` — see design D5 and `spikes/emulator-bakeoff/findings.md`); 0.3 proto `0.3` draft ✅ merged as `docs/proto.md` §6.7 (proposed); 0.1 survival harness ✅ built and smoke-tested (`spikes/holder-survival/`); **macOS matrix ✅ GO (2026-08-15, 8/8 PASS — kill -9, kickstart, upgrade all survived with reattach, both `AbandonProcessGroup` variants)**; Linux systemd matrix awaits a manual operator run (`run-linux.sh`) — go/no-go pends Linux only
- [ ] Phase 1 — blocked on Phase 0 go/no-go
- [ ] Phase 2 — blocked on Phase 1
- [ ] Phase 3 — blocked on Phase 2
- [ ] Phase 4 — optional, unscheduled
