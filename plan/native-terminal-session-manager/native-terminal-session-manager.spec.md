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

- [x] Phase 0 — **COMPLETE, verdict GO (2026-08-15)**: 0.1 survival matrix ✅ macOS 8/8 PASS (both `AbandonProcessGroup` variants) and Ubuntu/systemd 4/4 PASS with **`KillMode=process`** (mandatory unit directive; `control-group` fails; `systemd-run --scope` escape validated as hardening) — see `spikes/holder-survival/findings.md` for the binding supervision recipe; 0.2 emulator bake-off ✅ (decision: `alacritty_terminal`, design D5); 0.3 proto `0.3` draft ✅ (`docs/proto.md` §6.7, proposed). Optional logout/reboot rows remain documentation-only. D2(d) tmux-control-mode fallback not needed.
- [x] Phase 1 — **COMPLETE (2026-08-15)**: `bud/` converted to a Cargo workspace with the `stem` member crate; all modules implemented (dumb holder + ring + versioned IPC; alacritty-confined emu with cursor-filtered damage; chunk-safe OSC 133/OSC 7/alt-screen scanner; D7 mode machine; mode-aware keys; composed `Session` with replay/backfill-suppression/DamageQuiet). 87 stem tests + the true single-binary re-exec test (`bud term-hold` daemonized spawn/reuse/kill via `bud/tests/term_hold.rs`) + full bud suite (96) all green; clippy/fmt clean; `examples/repl.rs` manual smoke tool works. D4 amended (nix openpty over portable-pty, spike-proven mechanics). Deferred with SPEC:TODO in `bud/stem/stem.spec.md`: cross-binary IPC version-skew CI job (no Rust CI lane exists yet).
- [ ] Phase 2 — **unblocked** (daemon + service cutover)
- [ ] Phase 3 — blocked on Phase 2
- [ ] Phase 4 — optional, unscheduled
